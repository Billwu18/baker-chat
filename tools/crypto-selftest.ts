/**
 * 加密层的自检。
 *
 * 跑法（Node 22 直接啃不了 .ts，所以先用 esbuild 打成一个 mjs 再跑）：
 *
 *   npx esbuild tools/crypto-selftest.ts --bundle --format=esm --platform=node \
 *     --outfile=tools/.crypto-selftest.mjs && node tools/.crypto-selftest.mjs
 *
 * 这里验的都是「错一次就全盘皆输」的性质 —— 不是「接口能跑通」，
 * 而是「密钥不对必须打不开」「改一个字节必须失效」。
 */

import {
  fingerprintOf,
  generateIdentityKeys,
  exportPublic,
  exportSecret,
  importPublicX,
  importSecret,
  numberOf,
  safetyNumber,
} from '../src/crypto/keys'
import {
  deriveSharedKey,
  exportAesKey,
  generateSessionKey,
  importAesKey,
  open,
  seal,
  unwrapSessionKey,
  wrapSessionKey,
} from '../src/crypto/envelope'
// `authMaterial` / `authMaterialV2` / `signChallenge` / `concat` / `utf8` 曾经
// 在这里被 import：那是 1.x 的**登录握手**（客户端签一段服务器给的挑战文本）。
// P2P 里没有服务器可登录，那段探测连同这些 import 一起删了 —— 留着它们会让
// 下一个读的人以为「登录挑战」还是这套结构的一部分。
import { fromB64, randomBytes, toB64 } from '../src/crypto/core'
// `device.ts` 是「我是谁」的地基，却一直不在任何自检的 import 图里（报告 T4）。
// 这里把它的**导入**路径纳进来 —— 也就是「一份身份包凭什么能被信任」。
import { exportDeviceIdentity, importDeviceIdentity } from '../src/crypto/device'
import { judgeKeySource } from '../src/crypto/keyOwnership'
import {
  CryptoSessionManager,
  deserializeKeyEnvelope,
  enableTestHooks,
  serializeKeyBundle,
  type PeerIdentity,
} from '../src/crypto/session'

// 打开 exportKeyForTest / installForTest 的测试开关（默认关着，生产路径碰到就抛错）。
enableTestHooks()

import { createHash } from 'node:crypto'

/**
 * 指纹的**独立再实现**，只用 node:crypto 和自己的位循环。
 *
 * 存在的理由：`fingerprintOf` 里那几个字符就是用户互相核对身份的凭据。
 * 如果它被自己的 `toBase32` / `group` 顺手改错了（比如字母表把 O 和 0 搞混、
 * 或者分组多插一个连字符），**所有测试都会照常通过** —— 因为断言用的还是
 * 同一个坏函数算出来的值。所以这里从头再写一遍，只共享「SHA-256 取前 10 字节」
 * 这一条规格，其余全部重写，两边算出同一个串才算数。
 *
 * 这是 P2P 版才补上的：1.x 时这个位置拉的是 `server/src/identity.mjs`
 * 的对拍函数，服务器删掉之后就没有第二份实现了。留着这一份比删掉更值 ——
 * 编号现在不只是显示，它还是「别人看到的你是谁」。
 */
function independentFingerprint(edB64: string, xB64: string): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const material = Buffer.concat([Buffer.from(edB64, 'base64'), Buffer.from(xB64, 'base64')])
  const digest = createHash('sha256').update(material).digest().subarray(0, 10)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of digest) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out.replace(/(.{4})(?=.)/g, '$1-')
}


let passed = 0
let failed = 0

function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}${extra}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${extra}`)
  }
}

async function main() {
  console.log('=== 身份密钥 ===')

  const alice = await generateIdentityKeys()
  const bob = await generateIdentityKeys()
  const alicePub = await exportPublic(alice)
  const bobPub = await exportPublic(bob)
  const aliceSecret = await exportSecret(alice)

  check('公钥导出来是 32 字节 raw', fromB64(alicePub.ed).length === 32 && fromB64(alicePub.x).length === 32)

  // 用私钥重建身份，公钥必须一模一样 —— 身份迁移全靠这条。
  //
  // 这里刻意跑 40 轮而不是 1 轮：这条路径踩过一个**概率性**的坑 ——
  // JWK 的 `x` 是 base64url，直接喂给 atob 时，只有恰好不含 `-`/`_` 才不报错，
  // 单轮跑过的概率约 1/4。跑一轮是碰运气，跑 40 轮才叫测试。
  let reuseOk = 0
  let reuseBroken = ''
  for (let i = 0; i < 40; i += 1) {
    const k = await generateIdentityKeys()
    const s = await exportSecret(k)
    try {
      const rebuilt = await importSecret(s)
      const pub = await exportPublic(rebuilt)
      const want = await exportPublic(k)
      if (pub.ed === want.ed && pub.x === want.x) reuseOk += 1
      else reuseBroken = '公钥对不上'
    } catch (error) {
      reuseBroken = String(error)
    }
  }
  check(
    '私钥→公钥 往返 40 轮全部一致（身份迁移的基础）',
    reuseOk === 40,
    reuseBroken ? ` —— 第 ${reuseOk + 1} 轮失败：${reuseBroken}` : ` （${reuseOk}/40）`,
  )

  console.log('\n=== 指纹 / 安全码 ===')

  const fpA = await fingerprintOf(alicePub)
  const fpB = await fingerprintOf(bobPub)
  const fpA2 = await fingerprintOf(await exportPublic(await importSecret(aliceSecret)))
  check(`指纹稳定`, fpA === fpA2, ` → ${fpA}`)
  check('不同的人指纹不同', fpA !== fpB, ` → ${fpB}`)
  check('指纹长度固定（16 字符 + 3 个连字符）', fpA.length === 19)

  // 只换 Ed 公钥、X 不动，指纹也必须变（否则可以偷换其中一个）
  const halfSwapped = { ed: bobPub.ed, x: alicePub.x }
  check('换掉其中一个公钥指纹就变', (await fingerprintOf(halfSwapped)) !== fpA)

  const snA = await safetyNumber(alicePub, bobPub)
  const snB = await safetyNumber(bobPub, alicePub)
  check('安全码双方算出来一致（顺序无关）', snA === snB, ` → ${snA.slice(0, 23)}…`)
  check('安全码是 60 位数字', snA.replace(/ /g, '').length === 60)

  console.log('\n=== 编号（身份指纹短哈希）===')

  // 编号 = 指纹去掉连字符后的前 8 个 base32 字符。界面上「名字旁边永远跟着」
  // 的那个串就是它，服务器名册里那一栏也是它。两边各自实现了一遍，必须逐字节一致：
  // 分叉了不会报错，只会「本地算出来的编号」和「别人看到的编号」对不上。
  const numA = await numberOf(alicePub)
  const numB = await numberOf(bobPub)
  check('编号是 8 个 Crockford base32 字符（无 I/L/O/U）', /^[0-9A-HJKMNP-TV-Z]{8}$/.test(numA), ` → ${numA}`)
  check('编号稳定', (await numberOf(await exportPublic(await importSecret(aliceSecret)))) === numA)
  check('不同的人编号不同（160 位里取 40 位）', numA !== numB, ` → ${numB}`)
  check('换掉其中一个公钥编号就变', (await numberOf(halfSwapped)) !== numA)
  check('编号 = 指纹去掉连字符后的前 8 位', numA === fpA.replace(/-/g, '').slice(0, 8), ` → 指纹 ${fpA}`)

  // ★ 与一份**独立实现**逐字节对拍。
  const indepFp = independentFingerprint(alicePub.ed, alicePub.x)
  const indepNum = indepFp.replace(/-/g, '').slice(0, 8)
  check('独立实现算的指纹与客户端一致', indepFp === fpA, ` → 客户端 ${fpA} / 独立 ${indepFp}`)
  check('独立实现算的编号与客户端一致', indepNum === numA, ` → 客户端 ${numA} / 独立 ${indepNum}`)
  check(
    '独立实现对另一个人的编号也对得上',
    independentFingerprint(bobPub.ed, bobPub.x).replace(/-/g, '').slice(0, 8) === numB,
    ` → 客户端 ${numB}`,
  )
  // 编号是 ed 和 x **一起**算的。只喂一半（x 空）必须算出另一个编号 ——
  // 否则「换掉 X25519 公钥」这条换不来新编号，两个人可以共用一个编号。
  check(
    '只喂一半公钥算出来的是另一个编号',
    independentFingerprint(alicePub.ed, '') !== fpA,
  )

  console.log('\n=== X25519 协商 ===')

  const aliceShared = await deriveSharedKey(alice.xPrivate, await importPublicX(bobPub.x), 'test-v1')
  const bobShared = await deriveSharedKey(bob.xPrivate, await importPublicX(alicePub.x), 'test-v1')

  const probe = await seal(aliceShared, '只有两边能看', 'aad-1')
  const bobSees = await open(bobShared, probe, 'aad-1')
  check('两边各自协商出同一把钥匙', bobSees === '只有两边能看')

  // info 不同 → 派生出的密钥必须不同
  const bobOther = await deriveSharedKey(bob.xPrivate, await importPublicX(alicePub.x), 'other-v1')
  check('info 不同就是另一把钥匙（用途隔离）', (await open(bobOther, probe, 'aad-1')) === null)

  console.log('\n=== AES-GCM 信封 ===')

  const key = await generateSessionKey()

  const env = await seal(key, '档案室的借阅登记从本周起改成电子流', 'sess-1|1|u_admin|1')
  check('封→开 原样还原', (await open(key, env, 'sess-1|1|u_admin|1')) === '档案室的借阅登记从本周起改成电子流')

  const otherKey = await generateSessionKey()
  check('拿错钥匙打不开', (await open(otherKey, env, 'sess-1|1|u_admin|1')) === null)

  // AAD 绑定了 会话/密钥版本/发送者/序号 —— 任何一项被挪动都该失效
  check('AAD 里会话被换掉 → 打不开', (await open(key, env, 'sess-2|1|u_admin|1')) === null)
  check('AAD 里发送者被冒名 → 打不开', (await open(key, env, 'sess-1|1|u_lizhiyan|1')) === null)
  check('AAD 里序号被重放 → 打不开', (await open(key, env, 'sess-1|1|u_admin|2')) === null)

  // 密文被改一个字节
  const ct = fromB64(env.ct)
  ct[Math.floor(ct.length / 2)] ^= 0x01
  const tampered = { ...env, ct: toB64(ct) }
  check('密文被改动一个字节 → 打不开', (await open(key, tampered, 'sess-1|1|u_admin|1')) === null)

  // IV 被改
  const iv = fromB64(env.iv)
  iv[0] ^= 0x01
  check('IV 被改动 → 打不开', (await open(key, { ...env, iv: toB64(iv) }, 'sess-1|1|u_admin|1')) === null)

  // 同一个密钥封两次，IV 必须不同（GCM 重用 IV 是致命的）
  const e1 = await seal(key, '同一句话', 'x')
  const e2 = await seal(key, '同一句话', 'x')
  check('每条消息 IV 都不同（GCM 的命根子）', e1.iv !== e2.iv && e1.ct !== e2.ct)

  console.log('\n=== 会话密钥分发 ===')

  const sessionKey = await generateSessionKey()
  const rawKey = await exportAesKey(sessionKey)

  const aliceToBob = await wrapSessionKey(
    alice.xPrivate, await importPublicX(bobPub.x), sessionKey, 's_1', 'u_alice', 'u_bob',
  )
  const bobUnwrapped = await unwrapSessionKey(
    bob.xPrivate, await importPublicX(alicePub.x), aliceToBob, 's_1', 'u_alice', 'u_bob',
  )
  check('包起来 → 对方解得开', bobUnwrapped !== null && (await exportAesKey(bobUnwrapped)) === rawKey)

  // 服务器只有密文，它没有任何私钥 —— 这就是「服务器读不到」的证据
  check('信封里不含明文密钥', JSON.stringify(aliceToBob).indexOf(rawKey) < 0)

  // 包被人转发给第三方，AAD 里的收件人对不上
  const carol = await generateIdentityKeys()
  const carolTry = await unwrapSessionKey(
    carol.xPrivate, await importPublicX(alicePub.x), aliceToBob, 's_1', 'u_alice', 'u_carol',
  )
  check('把给 B 的包转给 C → 解不开', carolTry === null)

  // 用错人的钥匙也解不开
  const wrongTry = await unwrapSessionKey(
    bob.xPrivate, await importPublicX(bobPub.x), aliceToBob, 's_1', 'u_alice', 'u_bob',
  )
  check('拿错公钥（自己和自己）→ 解不开', wrongTry === null)

  // ★ 把包搬到**另一个会话**里也必须解不开。
  //
  // 这是 AAD 里加上 sessionId 之前真实存在的洞，而且方向是「读别人的消息」：
  // Mallory 同时是 S1 和 S2 的成员，她把「爱丽丝为 S1 写给鲍勃的那份包」
  // 原样塞进 S2 的 key 事件。鲍勃解出来的是爱丽丝的 S1 密钥，于是在 S2 里
  // 用 S1 的钥匙加密 —— 而 Mallory 手里有 S1 的钥匙，鲍勃在 S2 说的话她全能读。
  // 少了 sessionId 时这一条返回的是非 null（也就是解开了）。
  const crossSession = await unwrapSessionKey(
    bob.xPrivate, await importPublicX(alicePub.x), aliceToBob, 's_2', 'u_alice', 'u_bob',
  )
  check('★ 把 S1 的包搬进 S2 → 解不开', crossSession === null)

  // 反过来：同一个会话里再解一次仍然要成功（别把 AAD 绑死到某一次的随机量上）。
  const sameSessionAgain = await unwrapSessionKey(
    bob.xPrivate, await importPublicX(alicePub.x), aliceToBob, 's_1', 'u_alice', 'u_bob',
  )
  check('同一会话重复解包仍然成功', sameSessionAgain !== null)

  console.log('\n=== 性能（对一个大对象，比如 data URL 图片）===')

  const bigKey = await importAesKey(rawKey)
  const bigPlain = 'A'.repeat(1024 * 1024 * 4) // 4MB 的 base64 字符串

  let t0 = performance.now()
  const bigEnv = await seal(bigKey, bigPlain, 'perf')
  const sealMs = performance.now() - t0

  t0 = performance.now()
  const back = await open(bigKey, bigEnv, 'perf')
  const openMs = performance.now() - t0

  check('4MB 封→开 内容无损', back === bigPlain)
  console.log(
    `       封 ${sealMs.toFixed(1)} ms / 开 ${openMs.toFixed(1)} ms` +
      `  （${(4 / (sealMs / 1000)).toFixed(0)} MB/s 加密）`,
  )

  // 开销：信封比原文大多少
  const overhead = JSON.stringify(bigEnv).length - bigPlain.length
  console.log(`       4MB 内容的信封额外开销：约 ${overhead} 字节（IV 12 + 标签 16 + base64 膨胀）`)

  // ---------------------------------------------------------- 会话密钥管理
  console.log('\n=== 会话密钥管理（CryptoSessionManager）===')

  const aliceId = await generateIdentityKeys()
  const bobId = await generateIdentityKeys()
  const eveId = await generateIdentityKeys()
  const alicePub2 = await exportPublic(aliceId)
  const bobPub2 = await exportPublic(bobId)

  const alicePeer: PeerIdentity = { ...alicePub2, id: 'u_admin' }
  const bobPeer: PeerIdentity = { ...bobPub2, id: 'u_lizhiyan' }

  const mgrA = new CryptoSessionManager(aliceId, 'u_admin')
  const mgrB = new CryptoSessionManager(bobId, 'u_lizhiyan')
  const mgrE = new CryptoSessionManager(eveId, 'u_eve')

  const SESSION = 's_direct_1'
  const bundle = await mgrA.createFor(SESSION, [alicePeer, bobPeer])
  check('发起方能生成会话密钥', mgrA.hasKey(SESSION))
  // **要包含自己那一份**：建钥匙的人原来只在内存里留钥匙，服务器上只有
  // 发给别人的包，于是刷新一次就把自己的钥匙弄丢了 —— 然后重新生成一把、
  // 被服务器静默丢弃（同版本只补空缺），结果自己发的旧消息解不开、
  // 新消息所有人都解不开。给自己包一份，刷新后就能取回来。
  check(
    '给自己也包一份（刷新后靠它把钥匙找回来）',
    Object.keys(bundle.wrapped).sort().join(',') === 'u_admin,u_lizhiyan',
  )

  // 自己那一份要能被自己解开，而且解开后仍然记得「这钥匙是我建的」
  // （不然补包功能会在刷新后失效）。
  const mineMgr = new CryptoSessionManager(aliceId, 'u_admin')
  const mineOk = await mineMgr.accept(
    SESSION, 'u_admin', alicePub2, bundle.keyVersion, bundle.wrapped.u_admin,
  )
  check('自己能解开自己那一份', mineOk)
  check(
    '认领回来的钥匙仍然被记成「我建的」',
    (await mineMgr.wrapFor(SESSION, [bobPeer])) !== null,
  )

  const accepted = await mgrB.accept(
    SESSION, 'u_admin', alicePub2, bundle.keyVersion, bundle.wrapped.u_lizhiyan,
  )
  check('收件人能解开密钥包', accepted && mgrB.hasKey(SESSION))

  const env2 = await mgrA.encrypt(SESSION, 'u_admin', 7, '档案室的借阅登记从本周起改成电子流')
  check('发起方加密成功', env2 !== null)
  check(
    '收件人解密还原',
    (await mgrB.decrypt(SESSION, 1, 'u_admin', 7, env2!)) === '档案室的借阅登记从本周起改成电子流',
  )

  // 这条是整套方案的安全底线：没拿到密钥包的人，即使拿到密文也打不开。
  await mgrE.accept(SESSION, 'u_admin', alicePub2, bundle.keyVersion, bundle.wrapped.u_lizhiyan)
  check('把给 B 的包给 C → 解不开', !mgrE.hasKey(SESSION))
  check('C 没有钥匙时解密返回 null', (await mgrE.decrypt(SESSION, 1, 'u_admin', 7, env2!)) === null)

  // AAD 四条绑定，逐条验。
  check(
    '冒名发消息（改 authorId）→ 解不开',
    (await mgrB.decrypt(SESSION, 1, 'u_lizhiyan', 7, env2!)) === null,
  )
  check(
    '重放第 2 条冒充第 1 条（改 seq）→ 解不开',
    (await mgrB.decrypt(SESSION, 1, 'u_admin', 6, env2!)) === null,
  )

  // 降级攻击：有人拿 v1 的包想把已经有 v2 的会话退回去。
  const bobV2 = new CryptoSessionManager(bobId, 'u_lizhiyan')
  await bobV2.installForTest(SESSION, (await mgrB.exportKeyForTest(SESSION)) ?? '', 2)
  const downgrade = await bobV2.accept(SESSION, 'u_admin', alicePub2, 1, bundle.wrapped.u_lizhiyan)
  check('拿旧版本包降级 → 被拒', !downgrade && bobV2.keyVersion(SESSION) === 2)

  // 序列化往返 —— 密钥包要能塞进 JSON 走网络、落盘。
  const wire = serializeKeyBundle(bundle)
  const backEnv = deserializeKeyEnvelope(wire.wrapped.u_lizhiyan)
  check('密钥包 JSON 往返后结构不变', backEnv !== null && typeof backEnv.ct === 'string')
  const bob2 = new CryptoSessionManager(bobId, 'u_lizhiyan')
  const ok2 = await bob2.accept(SESSION, 'u_admin', alicePub2, wire.keyVersion, backEnv!)
  check('往返后的包仍然解得开', ok2 && (await bob2.decrypt(SESSION, 1, 'u_admin', 7, env2!)) !== null)

  check('畸形密钥包返回 null 而不是抛异常', deserializeKeyEnvelope('这不是 base64!!!') === null)

  // ---------------------------------------------------------- 补包（后上线的人）
  //
  // 这一段是回归测试：建群时有人还没登录过 → 服务器名单里没有他的公钥 →
  // 当时包不了他。等他上线拿到公钥之后，建钥匙的那个人必须能**沿用同一把
  // 钥匙**给他补一份，而不是造一把新的（造新的会让已经发出去的消息全废）。
  console.log('\n=== 补包：建群时不在的人，上线后补上 ===')

  const carolId = await generateIdentityKeys()
  const carolPub = await exportPublic(carolId)
  const carolPeer: PeerIdentity = { ...carolPub, id: 'u_zhuangfy' }

  const BACKFILL = 's_group_backfill'
  const mgrBack = new CryptoSessionManager(aliceId, 'u_admin')

  // 第一步：只有 Bob 有公钥，Carol 还没上线，名单里没有她。
  const first = await mgrBack.createFor(BACKFILL, [alicePeer, bobPeer])
  // 名单里只认识 Bob，所以收件人是 Bob + 我自己（见上面那条的解释）。
  check(
    '建群时只包了名单里已有公钥的人（加上自己）',
    Object.keys(first.wrapped).sort().join(',') === 'u_admin,u_lizhiyan',
  )
  mgrBack.markWrapped(BACKFILL, Object.keys(first.wrapped))

  // 第二步：Carol 上线，名单补齐。这时要补包，不是重建。
  const missing = mgrBack.missingPeers(BACKFILL, [alicePeer, bobPeer, carolPeer])
  check('missingPeers 报出还没份的人', missing.join(',') === 'u_zhuangfy')

  const extra = await mgrBack.wrapFor(BACKFILL, [alicePeer, bobPeer, carolPeer])
  check('补包只给还没份的人', extra !== null && Object.keys(extra!.wrapped).join(',') === 'u_zhuangfy')
  check('补包沿用同一把钥匙（版本没变）', extra!.keyVersion === first.keyVersion)

  // 第三步：Carol 用补来的包解开 —— 且解的是**补包之前**就已经发出去的消息。
  const beforeBackfill = await mgrBack.encrypt(BACKFILL, 'u_admin', 1, '这条是补包之前发的')
  const mgrCarol = new CryptoSessionManager(carolId, 'u_zhuangfy')
  const carolOk = await mgrCarol.accept(
    BACKFILL, 'u_admin', alicePub2, extra!.keyVersion, extra!.wrapped.u_zhuangfy,
  )
  check('后上线的人能解开补来的包', carolOk && mgrCarol.hasKey(BACKFILL))
  check(
    '而且能读到补包之前发的消息',
    (await mgrCarol.decrypt(BACKFILL, extra!.keyVersion, 'u_admin', 1, beforeBackfill!)) ===
      '这条是补包之前发的',
  )

  // 第四步：把「补包之前那把钥匙」也验证一遍 —— 老成员不受影响。
  const mgrBobBack = new CryptoSessionManager(bobId, 'u_lizhiyan')
  await mgrBobBack.accept(BACKFILL, 'u_admin', alicePub2, first.keyVersion, first.wrapped.u_lizhiyan)
  check(
    '补包不影响老成员读同一条消息',
    (await mgrBobBack.decrypt(BACKFILL, first.keyVersion, 'u_admin', 1, beforeBackfill!)) ===
      '这条是补包之前发的',
  )

  // 第五步：都补完了就不该再报缺人，否则每次名单更新都会重包一遍。
  mgrBack.markWrapped(BACKFILL, Object.keys(extra!.wrapped))
  check(
    '补完之后 missingPeers 为空（不会重复补）',
    mgrBack.missingPeers(BACKFILL, [alicePeer, bobPeer, carolPeer]).length === 0,
  )

  // 第六步：**关键回归** —— 已经建过钥匙的会话再调 createFor，绝不能换钥匙。
  // 早期版本在这里无条件 generateSessionKey()，于是「补一次包」
  // 就等于「把自己的钥匙换掉」，连原本能读的人都读不了了。
  const keyBefore = await mgrBack.exportKeyForTest(BACKFILL)
  const again = await mgrBack.createFor(BACKFILL, [alicePeer, bobPeer, carolPeer])
  const keyAfter = await mgrBack.exportKeyForTest(BACKFILL)
  check('重复 createFor 不会换掉已有的钥匙', keyBefore !== null && keyBefore === keyAfter)
  check('重复 createFor 版本号也没变', again.keyVersion === first.keyVersion)

  // 第七步：不是建钥匙的人，补包这条路走不通（返回 null，而不是造一把）。
  const mgrOutsider = new CryptoSessionManager(carolId, 'u_zhuangfy')
  check('没钥匙的人 wrapFor 返回 null', (await mgrOutsider.wrapFor(BACKFILL, [alicePeer])) === null)
  const carolMissing = mgrOutsider.missingPeers(BACKFILL, [alicePeer, bobPeer, carolPeer])
  check('没钥匙的人 missingPeers 也是空（不该由他来补）', carolMissing.length === 0)

  // ---------------------------------------------------------- base64 边界
  //
  // 分块编码的 off-by-one 极容易写错，而且只在特定长度上才暴露。
  // 这里把「刚好跨块 / 差一个 / 多一个」的长度都过一遍。
  console.log('\n=== base64 分块边界 ===')
  const lengths = [0, 1, 2, 3, 4, 5, 6, 7, 0x7ffe, 0x7fff, 0x8000, 0x8001, 0x8002, 0x10000, 0x10001]
  let b64Bad: number[] = []
  for (const n of lengths) {
    const raw = randomBytes(n)
    const text = toB64(raw)
    if (text !== Buffer.from(raw).toString('base64')) b64Bad.push(n)
    const parse = fromB64(text)
    if (parse.length !== n || parse.some((byte, i) => byte !== raw[i])) b64Bad.push(-n)
  }
  check(
    `base64 在各种分块边界往返一致（${lengths.length} 个长度）`,
    b64Bad.length === 0,
    b64Bad.length ? ` 失败长度：${b64Bad.join(',')}` : '',
  )

  // 大一点的一块：4 MB，验的是「不会爆栈 / 不会截断」。
  const big = randomBytes(4 * 1024 * 1024)
  const bigText = toB64(big)
  const bigBack = fromB64(bigText)
  check(
    '4 MB 数据 base64 往返一致',
    bigBack.length === big.length && bigBack[0] === big[0] && bigBack[big.length - 1] === big[big.length - 1],
  )

  // ------------------------------------------------ 小阶点 X25519 公钥
  //
  // 一个成员的 X25519 公钥如果是小阶点，`deriveBits` 会抛 `OperationError`。
  // 原来 `createFor` / `wrapFor` 的封包循环**没有 per-peer 保护**，异常会
  // 穿透出去 → `keyPublish` 永不执行 → **整个会话谁都没有钥匙** → 所有人
  // 静默降级成明文（界面上还没有任何提示）。而公钥来自对端自己发的 profile
  // 事件，谁都能写，所以这条路是能被打出来的。
  console.log('\n=== 小阶点 X25519 公钥 ===')

  for (const [label, bytes] of [
    ['全零', new Uint8Array(32)],
    ['0x01 + 全零', Uint8Array.from([1, ...new Uint8Array(31)])],
  ] as const) {
    let message = '（没抛）'
    try {
      await importPublicX(toB64(bytes))
    } catch (error) {
      message = error instanceof Error ? error.message : 'unknown'
    }
    check(`拒收小阶点公钥（${label}）`, message.includes('小阶点'), ` → ${message}`)
  }

  {
    const goodId = await generateIdentityKeys()
    const goodPub = await exportPublic(goodId)
    check('正常公钥照常收下', (await importPublicX(goodPub.x)) instanceof CryptoKey)

    const goodPeer: PeerIdentity = { ...goodPub, id: 'u_good' }
    // 身份本身合法（ed/x 都是真的），只是把 x 换成全零 —— 这正是攻击者
    // 能做到的：profile 事件里的 `x` 由他自己填，而 signature 只证明
    // 「这个事件是那个 Ed25519 私钥签的」，不证明 x 是个像样的公钥。
    const poisonPeer: PeerIdentity = { ...goodPub, id: 'u_poison', x: toB64(new Uint8Array(32)) }

    const mgr = new CryptoSessionManager(goodId, 'u_me')
    // 这里必须自己接住异常，而不是让它冒到 `main().catch` —— 后者只会把栈打到
    // stderr、连一行 FAIL 都不输出，于是这条不变式在变异检查里会被判成
    // 「非零退出但没断言」（是崩了，不是抓住了）。异常本身就是要断言的事实。
    let bundle: Awaited<ReturnType<typeof mgr.createFor>> | null = null
    let threw = ''
    try {
      bundle = await mgr.createFor('s_poison', [goodPeer, poisonPeer])
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check(
      '有毒成员不会让整个会话建不出钥匙',
      bundle !== null,
      threw ? ` → createFor 直接抛了：${threw}` : '',
    )
    check(
      '有毒成员被跳过，好成员照常拿到包',
      bundle !== null && Object.keys(bundle.wrapped).sort().join(',') === 'u_good,u_me',
      ` → ${bundle ? Object.keys(bundle.wrapped).sort().join(',') : '（整个会话没建出来）'}`,
    )
  }


  // ------------------------------------------------- 谁有资格给我发钥匙
  //
  // 这条规则是**唯一**不依赖对端状态的那道闸门（报告 M1/M4）：正常对端本来就
  // 会通过，所以它写错、或者少一个出口，外面完全看不出来。以前它只有两个出口
  // （收 / 拒），漏掉的正是「建钥人换人了」—— 于是新 owner 永久卡死。
  console.log('\n=== 谁有资格给我发钥匙 ===')
  {
    const judge = judgeKeySource

    check('发件人就是建钥人 → 收', judge({ owner: 'u_a', selfId: 'u_c', senderId: 'u_a' }) === 'accept')

    // ★ 建钥人换到了本机：不能收旧建钥人的包（形状上和抢注一样），
    // 但必须给信号让本机去建一把新的，而不是判死。
    check(
      '★ 建钥人换成本机 → 不是拒收，而是「该我重建」',
      judge({ owner: 'u_b', selfId: 'u_b', senderId: 'u_a' }) === 'stale_owner',
    )
    check(
      '建钥人没换到我 → 拒收（等真的建钥人）',
      judge({ owner: 'u_b', selfId: 'u_c', senderId: 'u_a' }) === 'reject',
    )

    // 会话还没折进本地状态时算不出建钥人 —— **不能当作没有规则要守**：
    // 同步批次里 key 事件先于 session 事件到达是合法的，攻击者能制造这个时机。
    check(
      '★ 算不出建钥人时既不放行、也不该自己建',
      judge({ owner: null, selfId: 'u_b', senderId: 'u_a' }) === 'reject',
    )
    check(
      '★ 算不出建钥人、而且发件人自称是本机 → 仍然拒收',
      judge({ owner: null, selfId: 'u_a', senderId: 'u_a' }) === 'reject',
    )
  }

  // ------------------------------------------------- 密钥轮换：换钥匙 ≠ 丢历史
  //
  // 报告 M2 的终态是「谁都不敢换钥匙」：`version` 写死 1，而 `accept` 对不高于
  // 自己的版本一律拒收（单向棘轮），于是「钥匙坏了 → 重建一把」这条自愈路径
  // 实际不可用。这里盯住三件事：版本真的往上走、旧版本仍然读得出来、
  // 平级/更低仍然被拒。
  console.log('\n=== 密钥轮换：换钥匙不等于丢历史 ===')
  {
    const aliceKeys = await generateIdentityKeys()
    const bobKeys = await generateIdentityKeys()
    const alicePub = await exportPublic(aliceKeys)
    const bobPub = await exportPublic(bobKeys)
    const alice = new CryptoSessionManager(aliceKeys, 'u_alice')
    const bob = new CryptoSessionManager(bobKeys, 'u_bob')

    // 第 1 版由 alice 建（她是成员 id 最小的那个）。bob 当时离线，没收到。
    const v1 = await alice.createFor('s_rotate', [{ id: 'u_bob', ...bobPub }])
    check('第一次建钥匙是第 1 版', v1.keyVersion === 1, ` → ${v1.keyVersion}`)

    const oldMsg = await alice.encrypt('s_rotate', 'u_alice', 1, '轮换之前发的')
    check('轮换前先发一条（第 1 版）', oldMsg !== null)

    // 建钥人换成了 bob（alice 退了 / 来了个更小的 id）。bob 本地没有钥匙，
    // 但他从日志里看到过第 1 版 —— 必须从第 2 版开始建。
    const v2 = await bob.createFor('s_rotate', [{ id: 'u_alice', ...alicePub }], { minVersion: 1 })
    check('★ 新 owner 从更高版本开始（否则对端静默丢弃）', v2.keyVersion === 2, ` → ${v2.keyVersion}`)
    check('新 owner 能把自己那把也留下', Boolean(v2.wrapped.u_bob))

    check(
      'alice 收下第 2 版',
      await alice.accept('s_rotate', 'u_bob', bobPub, v2.keyVersion, v2.wrapped.u_alice),
    )

    // ★ 这一条就是轮换能不能用的全部意义：收下更高版本之后，用旧版本写出去的
    // 消息还得读得出来，否则「重建钥匙」的代价是丢掉全部历史。
    check(
      '★ 收下更高版本之后，旧版本写的消息仍然读得出来',
      (await alice.decrypt('s_rotate', 1, 'u_alice', 1, oldMsg!)) === '轮换之前发的',
    )

    const newMsg = await bob.encrypt('s_rotate', 'u_bob', 1, '轮换之后发的')
    check(
      '新版本的消息双方都读得出',
      (await alice.decrypt('s_rotate', 2, 'u_bob', 1, newMsg!)) === '轮换之后发的' &&
        (await bob.decrypt('s_rotate', 2, 'u_bob', 1, newMsg!)) === '轮换之后发的',
    )

    // 单向棘轮不能被这次改动松掉：平级 / 更低的包一律拒收，防降级。
    check(
      '★ 平级的包仍然被拒（防降级）',
      !(await alice.accept('s_rotate', 'u_bob', bobPub, 2, v2.wrapped.u_alice)),
    )
  }

  // ------------------------------------------------- 身份包：导入必须先自洽
  console.log('\n=== 身份包：导入必须先自洽 ===')

  {
    // Node 里没有 localStorage —— 装一个最小的替身。`device.ts` 只在函数体里
    // 碰它，所以在这里装就够（模块求值阶段不会读存储）。
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    }

    const bundle = await exportDeviceIdentity()
    const declared = (JSON.parse(bundle) as { fingerprint: string }).fingerprint
    check('导出的包里有 fingerprint', typeof declared === 'string' && declared.length > 0, ` → ${declared}`)

    const imported = await importDeviceIdentity(bundle)
    check('正常身份包装得进去，返回的指纹是算出来的那个', imported === declared, ` → ${imported}`)

    // ★ 指纹和密钥对不上的包必须被拒。
    //
    // 先前这条检查**完全没有** —— `exportDeviceIdentity` 明明写了 `fingerprint`
    // 字段，导入侧却当它不存在。于是一份「声称是 A、实际装着 B 的私钥」的身份包
    // 可以顺利导入，而界面随后显示的是本地算出来的那个（B）指纹，用户手上
    // 没有任何东西能对出来「换人了」。
    const tampered = JSON.parse(bundle) as { fingerprint: string }
    tampered.fingerprint = 'AAAA-BBBB-CCCC-DDDD'
    let tamperMessage = '（居然收下了）'
    try {
      await importDeviceIdentity(JSON.stringify(tampered))
    } catch (error) {
      tamperMessage = error instanceof Error ? error.message : 'unknown'
    }
    check('★ 指纹对不上的包被拒收', tamperMessage.includes('对不上'), ` → ${tamperMessage}`)

    // 没有 `fingerprint` 字段的包同样拒收：没法确认它装的是谁的密钥。
    const noFingerprint = JSON.parse(bundle) as { fingerprint?: string }
    delete noFingerprint.fingerprint
    let missingMessage = '（居然收下了）'
    try {
      await importDeviceIdentity(JSON.stringify(noFingerprint))
    } catch (error) {
      missingMessage = error instanceof Error ? error.message : 'unknown'
    }
    check('没有 fingerprint 字段的包被拒收', missingMessage.includes('没有 fingerprint'), ` → ${missingMessage}`)

    // ★ 被拒之后本机现有的身份必须**一个字节都没动** —— 拒绝导入的意义
    // 就在于「别动我现在的身份」，要是先写了再报错就等于把用户锁在门外。
    const after = await exportDeviceIdentity()
    check('★ 拒收不动本机现有的身份', (JSON.parse(after) as { fingerprint: string }).fingerprint === declared)
  }

  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('炸了：', error)
  process.exit(1)
})

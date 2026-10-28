/**
 * 信封：把一段明文变成只有收件人能打开的一坨字节。
 *
 * 一条消息在网上的完整旅程：
 *
 *   明文 ──AES-256-GCM(会话密钥, 随机IV, AAD)──> { iv, ct } ──> 聊天的其他人
 *                                                                  ↑
 *                                                        经手的人只搬这坨字节，
 *                                                        他们没有会话密钥，
 *                                                        所以打不开。
 *
 * 会话密钥怎么来的：X25519 协商 → HKDF 派生。见 deriveSharedKey。
 *
 * 为什么是 AES-GCM 而不是 ChaCha20-Poly1305：
 * 两者安全性同级，但 AES-GCM 在 x86 和 ARM 上都有专门的指令（AES-NI / PMULL），
 * 实测 1.1 GB/s，而 ChaCha20 是纯软件实现。桌面端和手机端都更快。
 */

import {
  aadOf,
  authMaterial,
  authMaterialV2,
  fromB64,
  randomBytes,
  toB64,
  utf8,
  type Bytes,
} from './core'

/** 网上传的那种「一坨字节」。v 是版本号，将来换算法时靠它兼容。 */
export interface Envelope {
  v: 1
  /** 12 字节随机 IV，base64。 */
  iv: string
  /** 密文 + 16 字节 GCM 认证标签，base64。 */
  ct: string
}

/**
 * 从 X25519 协商出一个 AES-256-GCM 密钥。
 *
 * 三步：
 *  1. ECDH：两边各自用「我的私钥 + 对方的公钥」算出同一个点。
 *     偷看的人只有两个公钥，算不出来（这是离散对数问题）。
 *  2. HKDF：ECDH 的原始输出不是均匀随机的，不能直接当密钥用。
 *     HKDF 把它「压平」成一把规规矩矩的 32 字节密钥。
 *  3. `info` 参数把用途绑进去 —— 同一个 ECDH 结果，换个 info 就是完全不同的
 *     密钥。这样「用来包会话密钥的钥匙」和「用来聊天内容的钥匙」不会撞车。
 */
export async function deriveSharedKey(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
  info: string,
): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'X25519', public: theirPublic },
    myPrivate,
    256,
  )
  // 全零的 ECDH 结果说明对方给的是**低阶点**公钥（0、1，以及另外几个）。
  // HKDF 会把全零「压平」成一把看起来完全正常的密钥 —— 而攻击者手里
  // 有同一个全零输入，能算出同一把。必须在这里就断掉，不能让 HKDF
  // 把一个退化的协商结果洗白成合法密钥。
  if (new Uint8Array(bits).every((b) => b === 0)) {
    throw new Error('X25519 协商出全零共享密钥：对方给的是低阶点公钥')
  }
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: utf8(info),
    },
    material,
    256,
  )
  return crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/**
 * 生成一把新的会话密钥（32 字节随机）。
 *
 * 会话密钥是整个加密体系里唯一「随便生成」的东西 —— 它不需要协商，
 * 因为它会被协商出来的钥匙包住再发出去。
 */
export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
}

export async function exportAesKey(key: CryptoKey): Promise<string> {
  return toB64(await crypto.subtle.exportKey('raw', key))
}

export async function importAesKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64(raw), { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt',
  ])
}

// ---------------------------------------------------------------- 封 / 开

/** 把明文封成信封。aad 见下面 open 的注释。 */
export async function seal(
  key: CryptoKey,
  plaintext: string,
  aad: string,
): Promise<Envelope> {
  const bytes = utf8(plaintext)
  return sealBytes(key, bytes, aad)
}

export async function sealBytes(
  key: CryptoKey,
  bytes: Bytes,
  aad: string,
): Promise<Envelope> {
  // 每条消息一个全新的随机 IV。**这条不能省** ——
  // GCM 在同一个密钥下重用 IV 会直接泄露明文异或值，是致命错误。
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadOf(aad) },
    key,
    bytes,
  )
  return { v: 1, iv: toB64(iv), ct: toB64(ct) }
}

/**
 * 拆信封。打不开就返回 null（不抛异常 —— 收到一条坏消息不该让整个界面对不起）。
 *
 * `aad`（附加认证数据）是关键的一道锁：它不加密，但参与完整性校验。
 * 我们把「哪个会话、第几版密钥、谁发的、第几条」拼进 AAD，于是
 * **任何一个人挪动这些字段，GCM 的标签就对不上，消息直接作废**。
 * 具体挡住了三类攻击：
 *   - 把 A 会话的消息挪到 B 会话（sessionId 变了）
 *   - 把别人发的消息冒充成自己发的（senderId 变了）
 *   - 把旧消息重放一遍（seq 变了）
 */
export async function open(
  key: CryptoKey,
  envelope: Envelope,
  aad: string,
): Promise<string | null> {
  const bytes = await openBytes(key, envelope, aad)
  if (!bytes) return null
  return new TextDecoder().decode(bytes)
}

export async function openBytes(
  key: CryptoKey,
  envelope: Envelope,
  aad: string,
): Promise<Bytes | null> {
  if (!envelope || envelope.v !== 1 || !envelope.iv || !envelope.ct) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(envelope.iv), additionalData: aadOf(aad) },
      key,
      fromB64(envelope.ct),
    )
    return new Uint8Array(plain)
  } catch {
    // 标签校验失败 = 密钥不对、被改过、或者 AAD 对不上。三种都当作「打不开」。
    return null
  }
}

// ---------------------------------------------------------------- 包会话密钥

/**
 * 用自己的 X25519 私钥 + 对方的公钥，把会话密钥包起来。
 *
 * 这就是「端到端」的落点：这一坨只有对方能打开，经手的人也打不开，
 * 因为它既没有你的私钥、也没有对方的私钥，两边都算不出那把派生钥匙。
 *
 * ## AAD 里为什么必须带上 `sessionId`
 *
 * 原来 AAD 只有 `wrap|senderId|recipientId`。这个绑定挡住的是「把给 A 的包
 * 转给 B」「把 A 发的包说成自己发的」，**但挡不住把包在会话之间搬运**：
 * 同一对 sender/recipient 在两个群里都在，包就能互换。
 *
 * 攻击是真实可行的，而且是**读别人的消息**：Mallory 同时是 S1 和 S2 的成员，
 * 她把日志里「爱丽丝为 S1 写给鲍勃的那份包」原样塞进 S2 的 `key` 事件里。
 * 鲍勃解出来的是爱丽丝的 **S1** 密钥，于是他在 S2 里用 S1 的钥匙加密 ——
 * 而 Mallory 有 S1 的钥匙，于是鲍勃在 S2 里说的每一句话她都能读。
 * 对爱丽丝则表现为「鲍勃的 S2 消息全是打不开的气泡」。
 *
 * 把它写进 AAD 之后，包只在它出生的那个会话里能解开，搬到别的会话
 * 标签就对不上，`openBytes` 直接返回 null。
 */
export async function wrapSessionKey(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
  sessionKey: CryptoKey,
  sessionId: string,
  senderId: string,
  recipientId: string,
): Promise<Envelope> {
  const wrapper = await deriveSharedKey(myPrivate, theirPublic, 'baker-session-key-v1')
  const raw = await crypto.subtle.exportKey('raw', sessionKey)
  return sealBytes(wrapper, new Uint8Array(raw), wrappedKeyAad(sessionId, senderId, recipientId))
}

export async function unwrapSessionKey(
  myPrivate: CryptoKey,
  theirPublic: CryptoKey,
  envelope: Envelope,
  sessionId: string,
  senderId: string,
  recipientId: string,
): Promise<CryptoKey | null> {
  const wrapper = await deriveSharedKey(myPrivate, theirPublic, 'baker-session-key-v1')
  const raw = await openBytes(wrapper, envelope, wrappedKeyAad(sessionId, senderId, recipientId))
  if (!raw) return null
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

/**
 * 密钥包的 AAD。抽出来是为了让它**只有一个来源** ——
 * 打包和解包两边各写一遍字符串，早晚会改歪一边，而改歪的表现是
 * 「所有人都收不到钥匙」，不是一条报错。
 *
 * 注意这里**没有**给旧格式留兼容分支：带上 `sessionId` 之后，改造之前
 * 发出去的那些包一律解不开。这是有意的取舍 —— 留兼容就等于把上面那个
 * 跨会话搬运的洞留着。代价是可恢复的：本地取不回自己的那把时，
 * `ensureSessionKey` 会走「重建 / 补包」那条路重新发一份，
 * 不需要用户做任何事。
 */
function wrappedKeyAad(sessionId: string, senderId: string, recipientId: string): string {
  return `wrap|${sessionId}|${senderId}|${recipientId}`
}

// ---------------------------------------------------------------- 握手签名
//
// 这一整节（`signChallenge` 及其调用的 `authMaterial` / `authMaterialV2`）
// **在 P2P 版里已经没有调用者了**。它是 1.x 的登录仪式：服务器发一个 nonce，
// 客户端签回来证明「我拿着这把私钥」。没有服务器就没有人在问这个问题 ——
// 现在每一条事件各自带签名，收的人自己验（`src/p2p/event.ts` 的 `verifyEvent`）。
//
// 留在文件里而不是删掉，是为了让 1.x 时代的签名仍然可读（archive 里的
// `server/src/identity.mjs` 与它逐字节对应）。**不要拿它给新东西签名。**

/**
 * 给挑战值签名，回答「你是你吗」。
 *
 * 签名覆盖 nonce + serverId + handle 三样：
 *   - nonce 让签名一次性，截获了也没法重放
 *   - serverId 让签名绑死这台服务器，A 服务器骗到的签名不能拿去骗 B 服务器
 *   - handle 让签名绑死这个名字，防止拿自己的钥匙去冒充别人
 *
 * 有 `x` 时走 **v2**，把 X25519 公钥也签进去（理由见 `authMaterialV2`）：
 * 不签的话，中间人能把第一个 auth 帧里的 x 换成自己的，而签名照样有效 ——
 * 服务器回 verified: true，但之后所有人的会话密钥都包给攻击者。
 * 服务器那边对「带了 x 的登录」只认 v2，所以这里必须跟着换。
 */
export async function signChallenge(
  edPrivate: CryptoKey,
  nonce: string,
  serverId: string,
  handle: string,
  x?: string | null,
): Promise<string> {
  const material = x
    ? authMaterialV2(nonce, serverId, handle, x)
    : authMaterial(nonce, serverId, handle)
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, edPrivate, material)
  return toB64(sig)
}

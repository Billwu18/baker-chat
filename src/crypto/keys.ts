/**
 * 身份 = 两对密钥。
 *
 *   Ed25519  —— 签名。用来给每一条事件盖章（收的人自己验，见
 *               `src/p2p/event.ts` 的 `verifyEvent`），以及给导出的身份包盖章。
 *   X25519   —— 密钥协商。用来和别人算出一个只有两边知道的共享密钥，
 *               再拿它包住会话密钥。
 *
 * 关键设计：**身份不是字符串，是公钥。**
 * 之前 `selfId: 'u_lizhiyan'` 只是个名字，谁都打得出来 —— 没人分得清
 * 谁是真李织烟。现在「李织烟」是这个人 Ed25519 公钥的一个标签，
 * 名册里认的也是公钥。名字可以改，公钥不会变。
 *
 * 私钥永远不出这台设备。它是身份本身，丢了就找不回来（见 identity.ts 的导出）。
 */

import { concat, fromB64, fromB64Url, group, toB64, toBase32, utf8 } from './core'

export interface IdentityKeys {
  /** 签名用。私钥只在本地。 */
  edPrivate: CryptoKey
  edPublic: CryptoKey
  /** 密钥协商用。私钥只在本地。 */
  xPrivate: CryptoKey
  xPublic: CryptoKey
}

/** 可以安全地发出去的那一半。 */
export interface PublicIdentity {
  /** Ed25519 公钥，raw 32 字节的 base64。 */
  ed: string
  /** X25519 公钥，raw 32 字节的 base64。 */
  x: string
}

/** 私钥的序列化形式 —— 这几行东西就是「你」。 */
export interface SecretIdentity {
  ed: string
  x: string
}

// ---------------------------------------------------------------- 生成

export async function generateIdentityKeys(): Promise<IdentityKeys> {
  // Promise.all 会把 generateKey 的重载信息抹掉（返回 CryptoKey | CryptoKeyPair），
  // 所以这里显式断言成密钥对。
  const [ed, x] = (await Promise.all([
    // extractable=true 是为了能导出私钥做身份迁移。纯本地密钥理论上可以设为
    // 不可导出，但那样「换台机器还是同一个人」就做不到了 —— 这是刻意的取舍。
    crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']),
    crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']),
  ])) as [CryptoKeyPair, CryptoKeyPair]
  return {
    edPrivate: ed.privateKey,
    edPublic: ed.publicKey,
    xPrivate: x.privateKey,
    xPublic: x.publicKey,
  }
}

// ---------------------------------------------------------------- 导出 / 导入

export async function exportSecret(keys: IdentityKeys): Promise<SecretIdentity> {
  const [ed, x] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', keys.edPrivate),
    crypto.subtle.exportKey('pkcs8', keys.xPrivate),
  ])
  return { ed: toB64(ed), x: toB64(x) }
}

export async function importSecret(secret: SecretIdentity): Promise<IdentityKeys> {
  const [edPrivate, xPrivate] = await Promise.all([
    crypto.subtle.importKey('pkcs8', fromB64(secret.ed), { name: 'Ed25519' }, true, ['sign']),
    crypto.subtle.importKey('pkcs8', fromB64(secret.x), { name: 'X25519' }, true, ['deriveBits']),
  ])
  // 公钥是从私钥里推出来的 —— 不用单独存，也就不可能存错。
  const edJwk = await crypto.subtle.exportKey('jwk', edPrivate)
  const xJwk = await crypto.subtle.exportKey('jwk', xPrivate)
  const [edPublic, xPublic] = await Promise.all([
    crypto.subtle.importKey(
      'jwk',
      { ...edJwk, d: undefined, key_ops: ['verify'] } as JsonWebKey,
      { name: 'Ed25519' },
      true,
      ['verify'],
    ),
    crypto.subtle.importKey('raw', fromB64Url(publicFromJwk(xJwk)), { name: 'X25519' }, true, []),
  ])
  return { edPrivate, edPublic, xPrivate, xPublic }
}

/**
 * 从私钥 JWK 里把公钥那半取出来。
 *
 * X25519 的 pkcs8 里内嵌了公钥，但 WebCrypto 不给直接读的口子；
 * JWK 里 `x` 就是公钥，这是唯一一条不重新协商就能拿到它的路。
 */
function publicFromJwk(jwk: JsonWebKey): string {
  if (!jwk.x) throw new Error('私钥里没有公钥（JWK.x 缺失）')
  return jwk.x
}

export async function exportPublic(keys: IdentityKeys): Promise<PublicIdentity> {
  const [ed, x] = await Promise.all([
    crypto.subtle.exportKey('raw', keys.edPublic),
    crypto.subtle.exportKey('raw', keys.xPublic),
  ])
  return { ed: toB64(ed), x: toB64(x) }
}

/** 把别人的公钥导进来，用来验签 / 算共享密钥。 */
export async function importPublicEd(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromB64(raw), { name: 'Ed25519' }, true, ['verify'])
}

/**
 * 把别人的 X25519 公钥导进来，用来算共享密钥。
 *
 * 这里先挡掉最常见的两个「小阶点」公钥：全零、以及 `0x01` 后跟全零。
 * 它们让 ECDH 直接算不出来（`deriveBits` 抛 `OperationError`），
 * 而那个异常本身不是重点 —— 重点是**它会顺着调用栈一路炸上去**：
 * 会话封包循环里只要有一个成员的公钥长这样，整次建钥就没了，
 * 结果不是「这个人收不到钥匙」而是**整个会话谁都没有钥匙**，
 * 于是全员静默降级成明文。公钥来自对端的 profile 事件，谁都能写，
 * 所以这条路是能被打出来的。
 *
 * 剩下几个低阶点过不了 `deriveSharedKey` 里那道「全零共享密钥」检查。
 * 这里只把这两种早点挡掉，是为了给出一句说得清的错误。
 */
export async function importPublicX(raw: string): Promise<CryptoKey> {
  const bytes = fromB64(raw)
  if (bytes.length !== 32 || bytes.every((b) => b === 0) || (bytes[0] === 1 && bytes.every((b, i) => i === 0 || b === 0))) {
    throw new Error('这个 X25519 公钥是小阶点，用它算不出共享密钥')
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'X25519' }, true, [])
}

// ---------------------------------------------------------------- 指纹

/**
 * 身份指纹：两个公钥一起哈希，取前 10 字节，编成 16 个 base32 字符。
 *
 * 为什么把 Ed 和 X 两个公钥一起算：这样指纹同时锁住「签名身份」和
 * 「加密身份」。如果只锁一个，攻击者可以换掉另一个而指纹不变。
 *
 * 这个串的用途是**线下核对** —— 当面 / 电话里念一遍，确认名册里那份公钥
 * 没有被掉包。这就是为什么用去掉 I/L/O/U 的字母表：它是要念出来的。
 */
export async function fingerprintOf(pub: PublicIdentity): Promise<string> {
  const material = concat(fromB64(pub.ed), fromB64(pub.x))
  const digest = await crypto.subtle.digest('SHA-256', material)
  return group(toBase32(new Uint8Array(digest).subarray(0, 10)), 4)
}

/**
 * 用户编号：指纹的前 8 个 base32 字符（40 位），形如 `EK3M7PQR`。
 *
 * **只是给人看的短码，不是身份。** 40 位意味着 2^20 次尝试就能造出另一个
 * 编号相同、而钥匙完全不同的身份 —— 所以 P2P 版里 `author` 用的是
 * `src/p2p/event.ts` 的 `identityOf`（SHA-256，256 位），名册上的权威 id
 * 也是它。这个函数的产物进不了任何判断「你是不是你」的地方。
 *
 * 它是**算出来的，不是存下来的**，这一点是刻意的：库里只有公钥，
 * 编号每次要用时现算，所以不会出现「存的编号和实际公钥对不上」这种
 * 只能靠人工核对才发现的不一致。
 *
 * 1.x 里它必须和已归档的 `server/src/identity.mjs` 的 `numberOf` 逐字节一致
 * （那时服务器拿它当 id）。P2P 版没有这个对端了，但**仍然不要改字母表或
 * 补位规则**：改了之后旧人机界面上记得的编号会对不上，而没有任何测试会告诉你。
 */
export async function numberOf(pub: PublicIdentity): Promise<string> {
  return (await fingerprintOf(pub)).replace(/-/g, '').slice(0, 8)
}

/**
 * 两个人的「安全码」：60 位数字，分 12 组。
 *
 * 和指纹的关系：指纹是「你自己是谁」，安全码是「咱俩之间这条线干不干净」。
 * 两个人各自算出来的安全码必须一模一样；不一样就说明中间有人换过公钥。
 * 双方公钥先排序再哈希，所以谁算都得到同一个结果。
 */
export async function safetyNumber(a: PublicIdentity, b: PublicIdentity): Promise<string> {
  const [first, second] = [a.ed + a.x, b.ed + b.x].sort()
  const seed = await crypto.subtle.digest('SHA-256', utf8(`baker-safety-v1|${first}|${second}`))
  // 32 字节不够 60 位数字，再哈希一轮凑够 64 字节。
  const more = await crypto.subtle.digest('SHA-256', seed)
  const bytes = concat(new Uint8Array(seed), new Uint8Array(more))
  let digits = ''
  // 每组 2 字节凑 5 位数字，12 组 = 60 位。位数固定，方便人对着念。
  for (let i = 0; i < 24; i += 2) {
    digits += String((bytes[i] * 256 + bytes[i + 1]) % 100000).padStart(5, '0')
  }
  return group(digits, 5, ' ')
}

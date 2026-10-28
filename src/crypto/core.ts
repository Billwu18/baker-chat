/**
 * 加解密用得到的小工具：字节、base64、随机数、常量时间比较。
 *
 * 为什么不用现成的库（tweetnacl / libsodium / @noble）：
 * 浏览器和 Node 现在都原生带着我们要的全部原语 ——
 * X25519、Ed25519、HKDF-SHA256、AES-256-GCM，一行 import 都不用加。
 * AES-GCM 走的是 CPU 的 AES-NI 指令，实测 Node 里 1.1 GB/s、浏览器里 378 MB/s，
 * 比它要保护的那条网络链路快三个数量级。
 *
 * 少一个依赖就少一份供应链风险，这个模块里没有任何第三方代码。
 */

/**
 * WebCrypto 的类型签名要求 `ArrayBufferView<ArrayBuffer>`，
 * 而 TS 里裸写 `Uint8Array` 默认是 `Uint8Array<ArrayBufferLike>`（可能是 SharedArrayBuffer），
 * 于是到处报「不能赋给 BufferSource」。这个别名把「确定是普通 ArrayBuffer 背着的」
 * 这件事写进类型里，省掉一堆 as any。
 */
export type Bytes = Uint8Array<ArrayBuffer>

// ---------------------------------------------------------------- 字节与编码

export function utf8(text: string): Bytes {
  return new TextEncoder().encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * 一段密码学安全的随机字节。
 *
 * ⚠️ **必须分块**：`crypto.getRandomValues` 一次最多只给 65536 字节，
 * 超了直接抛 `QuotaExceededError: The requested length exceeds 65,536 bytes`。
 *
 * 这是个很容易埋进去的雷：会话 IV 只要 12 字节，永远不会触发；
 * 等哪天有人拿它去生成大一点的盐或者填充，就变成「跑小数据好好的、
 * 跑大数据才炸」——和 base64url 那个坑一模一样的形状。
 */
export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length)
  const MAX = 65536
  for (let at = 0; at < length; at += MAX) {
    crypto.getRandomValues(out.subarray(at, Math.min(at + MAX, length)))
  }
  return out
}

/**
 * Node 的 `Buffer` 的最小结构类型。
 *
 * 这里**故意不引 `@types/node`** —— 这个模块是给浏览器打包的，
 * 引进来会把整套 Node 全局塞进客户端的类型空间，然后 `setTimeout` 的返回类型
 * 之类的都会跟着变（返回 `Timeout` 而不是 `number`），牵连一大片无关代码。
 *
 * 我们真正用到的只有「编码成 base64」和「从 base64 解码」这两件事，
 * 所以只描述这两件事。声明式的好处是：**如果哪天 Node 改了签名，这里会编译不过**，
 * 而不是运行到一半才炸。
 */
interface NodeBufferLike {
  from(data: ArrayBuffer, byteOffset: number, length: number): { toString(encoding: 'base64'): string }
  from(data: string, encoding: 'base64'): Uint8Array
}

/**
 * 运行在 Node 里吗？在的话 base64 可以交给原生 `Buffer` ——
 * 它是 SIMD 加速的，比 JS 里任何写法都快一个数量级（实测 1422 MB/s vs 102 MB/s）。
 *
 * 用 `globalThis` 探测而不是 `import { Buffer } from 'node:buffer'`：
 * 那条 import 会让这个模块没法在浏览器里打包。
 */
const NODE_BUFFER: NodeBufferLike | undefined = (globalThis as { Buffer?: NodeBufferLike }).Buffer

/**
 * 字节 → 标准 base64。
 *
 * ## 为什么这个函数值得这么多注释
 *
 * 加密路径上真正的瓶颈是**这里**，不是 AES。实测（Node 22，4 MB）：
 *
 * | 写法 | 耗时 | 吞吐 |
 * |---|---|---|
 * | `binary += String.fromCharCode(...chunk)` | 171 ms | 23 MB/s |
 * | 分块进数组再 `join` | 168 ms | 24 MB/s |
 * | **`String.fromCharCode.apply(null, chunk)` + `join`** | **39 ms** | **102 MB/s** |
 * | 手写查表 + 分块 `fromCharCode` | 69 ms | 58 MB/s |
 * | Node 原生 `Buffer.toString('base64')` | 2.8 ms | 1422 MB/s |
 *
 * 同一批数据 AES-256-GCM 只要 4 ms。也就是说**旧写法让加密慢了 40 倍**，
 * 而瓶颈全在一个跟密码学无关的地方。
 *
 * 换掉的原因很具体：`String.fromCharCode(...chunk)` 是**展开调用**，
 * 每个字节都要过一遍参数列表；`apply` 传的是数组，V8 有专门的快路径。
 * 相差 4.4 倍就在这一个字符的区别上。
 *
 * 试过但没赢的写法（别重复踩）：
 *   - 手写查表 3→4 再 `fromCharCode`：58 MB/s，比 apply 慢
 *   - `TextDecoder('latin1')` + `btoa`：直接抛 `InvalidCharacterError` ——
 *     WHATWG 里 latin1 是 windows-1252 的别名，0x80–0x9F 会映射成 U+20AC 之类的码点
 *   - 每块单独 `btoa` 再拼：只慢一点点，但要拼 4/3 长度的多份字符串，不划算
 */
export function toB64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (NODE_BUFFER) {
    return NODE_BUFFER.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).toString(
      'base64',
    )
  }
  // 只在没有 Buffer 的环境（浏览器）走到这里。
  const CHUNK = 0x8000
  const parts: string[] = []
  for (let i = 0; i < view.length; i += CHUNK) {
    // apply 而不是展开 —— 这一处差别是 4.4 倍。见上面的表。
    //
    // `as unknown as number[]` 是必要的谎言：运行时 `apply` 完全接受
    // TypedArray（它只要求有 length 和数字下标），但 TS 的签名写死了 `number[]`。
    // 转成真数组就得复制一遍，正好把这里省的性能赔进去。
    parts.push(String.fromCharCode.apply(null, view.subarray(i, i + CHUNK) as unknown as number[]))
  }
  return btoa(parts.join(''))
}

export function fromB64(text: string): Bytes {
  // Node 走原生解码（4 MB 只要 4 ms，而 atob + 逐字节循环要 16 ms）。
  if (NODE_BUFFER) return Uint8Array.from(NODE_BUFFER.from(text, 'base64'))
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * base64url（RFC 7515）→ 字节。
 *
 * JWK 里的 `x` / `d` 等字段用的是 base64url：`+` `/` 被换成 `-` `_`，而且不带 `=` 填充。
 * `atob` 只认标准 base64，直接塞进去会抛 `InvalidCharacterError`。
 *
 * ⚠️ 这个坑的可怕之处在于它是**概率性**的：43 个字符里恰好没出现 `-`/`_` 时能跑通，
 * 而那有约 26% 的概率 —— 也就是说大约 1/4 的密钥能过、3/4 的当场炸。
 * 第一版就是这么写的，第一次跑碰巧过了，第二次才暴露。
 */
export function fromB64Url(text: string): Bytes {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
  return fromB64(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

/**
 * 字节 → base64url（RFC 7515）：`+` `/` 换成 `-` `_`，去掉 `=` 填充。
 *
 * 和 `fromB64Url` 配成一对。之前只有解码没有编码，因为解码那一半是
 * JWK 逼出来的（浏览器给的 `x`/`d` 就是 base64url），而编码一直没需求。
 *
 * 现在有了：P2P 的**事件 id** 是内容哈希，会出现在分享串、调试日志和
 * `since` 游标里。用标准 base64 的话 `+` 在 query string 里会被解成空格、
 * `/` 在文件名里会被当成路径分隔符 —— 又是一类「大多数输入看着都对、
 * 特定哈希才炸」的 bug，所以从一开始就用 URL 安全的字母表。
 */
export function toB64Url(bytes: Uint8Array | ArrayBuffer): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function concat(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** 把字符串按 UTF-8 拼成 AAD 用的字节串。 */
export function aadOf(...parts: string[]): Bytes {
  return utf8(parts.join('\u0000'))
}

/**
 * 1.x 登录挑战要签的那段文本。
 *
 * **P2P 版里已经没有任何调用者了**（唯一调用者是 `envelope.ts` 的
 * `signChallenge`，而它也没有调用者）：登录是「服务器给你一段 nonce、
 * 你签回来证明你是你」—— 没有服务器就没有这场仪式。身份现在就是一对钥匙，
 * 每一条事件各自带签名（见 `src/p2p/event.ts`）。
 *
 * 留着是因为它是**旧格式的历史定义**：archive 里的 `server/src/identity.mjs`
 * 与它逐字节对应，将来若要读 1.x 时代的签名才需要它。改这里不会影响任何
 * 在跑的东西；反过来，**不要再照这个格式签新的东西**。
 *
 * 三段之间用 \0 分隔：\0 不可能出现在 nonce（base64）、serverId 或 handle 里，
 * 所以不存在「两段拼起来和另一组拼起来字节相同」的歧义
 * （否则 `("ab","c")` 和 `("a","bc")` 会签出同一个签名）。
 *
 * 版本号 `baker-auth-v1` 也在里面：将来要换算法或换格式时，
 * 老客户端会因为版本号不匹配而明确失败，而不是悄悄用一个错的格式登进去。
 */
export function authMaterial(nonce: string, serverId: string, handle: string): Bytes {
  return utf8(['baker-auth-v1', nonce, serverId, handle].join('\u0000'))
}

/**
 * v2 的签名材料：把 X25519 公钥（x）也签进去。
 *
 * 和 {@link authMaterial} 一样，**P2P 版里没有调用者**，留着只为了让 1.x
 * 的旧签名可读。下面是它当初非加不可的理由，那是个真实的教训，留着有用：
 *
 * v1 的签名材料里没有 x，于是一段合法签名可以原样配
 * **任意一个** x 使用。中间人只要在第一个 auth 帧里把受害者的 x 换成自己的，
 * 服务器照样回 `verified: true`、roster 看起来完全正常，但从此这个人的
 * 会话密钥全部包给攻击者 —— 承载机密性的正是 x，不是 ed。
 *
 * P2P 版没有「登录帧」这个可以被替换的位置，但同一类错误在这里换了张脸：
 * 所以 `src/p2p/event.ts` 的 `identityOf` 把 **ed 和 x 一起**哈希进去，
 * 而 `src/p2p/log.ts` 的 `verifyProfile` 要求 `author` 等于它 —— 只认 ed
 * 的编号会让「换掉加密公钥仍然冒充同一个人」重新成立。
 *
 * x 是 32 字节的 base64（44 字符，含 `=`），里面不可能有 \0，所以直接拼安全。
 */
export function authMaterialV2(
  nonce: string,
  serverId: string,
  handle: string,
  x: string,
): Bytes {
  return utf8(['baker-auth-v2', nonce, serverId, handle, x].join('\u0000'))
}

/**
 * 常量时间比较。
 *
 * 不能写成 `a === b` —— 字符串比较会在第一个不同的字符处提前返回，
 * 攻击者能靠计时差一个字节一个字节地把值猜出来。这里不管相不相等都跑满全程。
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

// ---------------------------------------------------------------- 人类可读的编码

/**
 * Crockford base32 —— 去掉了 I、L、O、U 四个字母。
 *
 * 去掉是因为它们是「看起来像别的字符」的重灾区：
 * I/L 像 1、O 像 0、U 容易和 V 混。配对码、指纹、安全码都用它，
 * 因为这些字符串是给人念出来、抄下来、对着核的。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function toBase32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function fromBase32(text: string): Bytes | null {
  const clean = text.toUpperCase().replace(/[^0-9A-Z]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) return null
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** 把一串字符按固定长度分段，方便念和抄：`BK1-XXXXX-XXXXX`。 */
export function group(text: string, size: number, sep = '-'): string {
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts.join(sep)
}

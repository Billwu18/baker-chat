import type { UserId } from '../protocol/types'

/**
 * 配对码 —— 把「加谁」编成一次粘贴。
 *
 *   BK2-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXX
 *            ↓ 解出来
 *   { userId: "9tQ…43 个字符…", name: "李织烟" }
 *
 * ## 和服务器版（BK1）的差别：**码里没有地址**
 *
 * 1.x 的码是
 * `{ serverUrl: "ws://101.102.103.87:8787/ws", userId: "u_lizhiyan", name: … }`
 * —— 因为那时候「对方在哪台服务器上」是个必须传过去的信息，不告诉你，
 * 你连不上任何人。
 *
 * P2P 版里**没有这个问题**：同一个局域网里的人靠组播自己走到一起，不需要
 * 任何人告诉你去哪。所以码里只剩「我要加的那个人是谁」。地址从这个码里
 * 消失，顺带消失的是一整类问题 —— 码里带的地址是别人发来的不可信输入，
 * 1.x 得专门写一个 `sanitizeServerUrl` 去挡 `file://` 之类的东西；
 * 现在没有可被指向的目标了。
 *
 * ## 码里为什么必须带 userId
 *
 * 因为 userId 就是公钥的 SHA-256（见 `src/p2p/event.ts` 的 `identityOf`）。
 * 把它抄对了，就等于把对方的公钥抄对了 —— 而这正是安全模型里唯一需要
 * 手工传递的一环：任何中间人都没法把一个假公钥塞进这条码里，因为它算不出
 * 一个和码里 userId 对得上的公钥。
 *
 * ## 校验位
 *
 * 1.x 的码**没有校验位**，所以抄错一位的表现是「加了一个不存在的 id」——
 * 不报错，只是永远加不上。这里补了 4 个字符的 FNV-1a 校验（不是密码学用途，
 * 只为了挡住手抄/OCR 的错），抄错时会当场说「这串码不对」，而不是安静地
 * 加一个查无此人。
 *
 * 编码用 Crockford base32：去掉了 I / L / O / U，手抄和口述都不容易错。
 * （编号也用同一套字母表，所以两边念起来是同一套规则。）
 */

/** 去掉了 I L O U —— 这几个最容易和 1 0 看混、听错 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const PREFIX = 'BK2'
const VERSION = '2'
/** 每段长度，纯粹为了好读好抄 */
const GROUP = 5
/** 校验位长度。4 个 base32 字符 = 20 位，够挡住随手抄错。 */
const CHECK_LENGTH = 4

export interface PairCode {
  /** 对方是谁。就是他的公钥指纹，抄对了就等于把公钥抄对了。 */
  userId: UserId
  /** 对方名字，只用来在「要加上 X 吗」这句提示里显示 */
  name: string
}

// ------------------------------------------------------------------ base32

function encodeBase32(input: string): string {
  const bytes = new TextEncoder().encode(input)
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

function decodeBase32(input: string): string {
  // 抄错是常态：统一大写、丢掉非字母数字、把易混的三个字母折回去
  const clean = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[ILO]/g, (c) => (c === 'O' ? '0' : '1'))

  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch)
    if (index < 0) continue // U 之类不在字母表里，直接跳过而不是整串作废
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

// ------------------------------------------------------------------ 校验位

/**
 * FNV-1a 32 位。**不是密码学哈希**，只用来发现「抄错了」。
 *
 * 不引 SHA-256 是因为这里必须是同步的：`parsePairCode` 在 render 里被调用，
 * 而 `crypto.subtle.digest` 只能异步。校验位的职责只有「挡住打字错误」，
 * 挡住伪造是签名层的事，不需要在这里做。
 */
function checksumOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    // 乘 16777619，用移位凑，避免 Math.imul 之外的精度问题
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  let out = ''
  let value = hash
  for (let i = 0; i < CHECK_LENGTH; i += 1) {
    out += ALPHABET[value & 31]
    value >>>= 5
  }
  return out
}

// ------------------------------------------------------------------ 生成

/** 把「我是谁」编成一串配对码。 */
export function makePairCode({ userId, name }: PairCode): string {
  const payload = [VERSION, userId, name].join('|')
  const body = encodeBase32(payload)
  const groups: string[] = []
  for (let i = 0; i < body.length; i += GROUP) groups.push(body.slice(i, i + GROUP))
  groups.push(checksumOf(body))
  return [PREFIX, ...groups].join('-')
}

// ------------------------------------------------------------------ 解析

/**
 * 解析配对码。认不出来就返回 null —— 调用方据此把输入当成「对方 id」再试一次。
 *
 * 补一个容易踩的坑：base32 的长度是 5 的倍数、字节是 8 的倍数，
 * 两者不整除时末尾会多出 1~4 个填充位。解码时最后那几位不足以拼出一个字节，
 * 会被自然丢掉，所以这里的容错是「宁可多解几个字符，也不要因为长度不对就整串拒绝」。
 */
export function parsePairCode(input: string): PairCode | null {
  const text = String(input ?? '').trim()
  if (!text) return null

  const upper = text.toUpperCase()
  const start = upper.indexOf(PREFIX)
  if (start < 0) return null

  // 从 BK2 之后开始取，中间的连字符和空格由 decodeBase32 自己吃掉
  const rest = upper.slice(start + PREFIX.length)
  const compact = rest.replace(/[^0-9A-Z]/g, '')
  if (compact.length <= CHECK_LENGTH) return null

  const body = compact.slice(0, -CHECK_LENGTH)
  const saidCheck = compact.slice(-CHECK_LENGTH)
  // 校验位对不上 = 抄错了。**必须在这里返回 null**，不能放过去 ——
  // 放过去的话症状是「加了一个查无此人」，用户看到的是「加不上」而不是
  // 「码错了」，于是会去怀疑网络。
  if (checksumOf(body) !== saidCheck) return null

  let decoded: string
  try {
    decoded = decodeBase32(body)
  } catch {
    return null
  }

  const parts = decoded.split('|')
  if (parts.length < 3) return null
  if (parts[0] !== VERSION) return null

  const userId = parts[1].trim()
  if (!userId) return null

  // 名字是可选的第 3 段
  const name = (parts[2] ?? '').trim() || userId
  return { userId, name }
}

/** 粗判一段文本是不是配对码，用来决定输入框走哪条分支。 */
export function looksLikePairCode(input: string): boolean {
  return String(input ?? '').toUpperCase().includes(PREFIX)
}

/**
 * 一段文本看着像**旧版**（服务器版）的配对码。
 *
 * 单独认它，是为了能说一句人话。把 `BK1-…` 丢给 `parsePairCode` 会得到 null，
 * 而 null 的默认解释是「你抄错了」—— 可人家没抄错，是版本变了。这两种情况
 * 给的下一步完全不同：一个让人重新复制，一个让人去要新码。
 */
export function looksLikeLegacyPairCode(input: string): boolean {
  return String(input ?? '').toUpperCase().includes('BK1')
}

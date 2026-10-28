/**
 * 本机身份 —— 这台设备的长期密钥对，存在 localStorage 里。
 *
 * ## 为什么这个东西是整个安全模型的地基
 *
 * 在它出现之前，「我是谁」完全取决于我在连接时**声称**自己是谁。
 * 旧服务端只有一行 `store.identities[userId]`，谁都能往里写。
 * 也就是说：每个人都能当管理员，谁想当李织烟都行。
 *
 * 有了它之后，身份变成一对只存在这台机器上的私钥。要证明「我是我」，
 * 得当场签一段只有我能签出来的话。**名字只是贴在公钥上的标签。**
 *
 * ## 私钥存在 localStorage 里 —— 这个取舍要说清楚
 *
 * localStorage 不是安全存储：同源的脚本、任何浏览器扩展、以及能读到
 * 这个 profile 目录的人都能拿到它。真正的做法是 WebCrypto 的
 * 不可导出密钥（或系统钥匙串）。
 *
 * 但我们**刻意**选了可导出 —— 因为「换台机器还是同一个人」是这个应用
 * 明确要的功能（见 docs/加密与身份.md 的「身份迁移」）。两者不可兼得。
 *
 * 减轻措施：导出私钥要用户手动触发，不会自动上传，界面上会明确
 * 警告「这几行字就是你的身份，别发给别人」。
 */

import {
  generateIdentityKeys,
  exportPublic,
  exportSecret,
  importSecret,
  fingerprintOf,
  type IdentityKeys,
  type PublicIdentity,
  type SecretIdentity,
} from './keys'

/** 存身份用的 key。和 `baker.config.v1` 分开，清配置不会顺手毁掉身份。 */
const STORAGE_KEY = 'baker.identity.v1'

interface StoredIdentity {
  /** 密钥对主体 */
  secret: SecretIdentity
  /** 生成时间，只用于界面展示 */
  createdAt: number
}

let cached: IdentityKeys | null = null
let cachedPublic: PublicIdentity | null = null

/**
 * 本机存着身份、但读不出来（格式坏了、算法名变了……）。
 *
 * 单独一个类型是为了让上层能区分「这台设备还没有身份」（正常，生成一把）
 * 和「有身份但坏了」（不正常，**绝不能**顺手生成一把顶上去）。
 */
export class DeviceIdentityUnreadableError extends Error {
  /** 存坏了的原始字节。留着，别覆盖 —— 它可能是唯一的恢复线索。 */
  readonly raw: string | null

  constructor(raw: string | null, cause?: unknown) {
    super(
      '本机存的身份读不出来了。它没有被覆盖，恢复之前请不要重置身份。' +
        '（想从这里继续：先导出/备份 localStorage 里的 baker.identity.v1）',
    )
    this.name = 'DeviceIdentityUnreadableError'
    this.raw = raw
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * 这台设备的身份。第一次调用时生成并落盘，之后一直复用。
 *
 * @throws DeviceIdentityUnreadableError 存着身份但读不出来。**不会**生成一把新的
 *   覆盖上去 —— 覆盖等于换了个人，而旧身份已经没了，换回来只能靠那份备份。
 *   宁可让上层报错。
 */
export async function getDeviceIdentity(): Promise<IdentityKeys> {
  if (cached) return cached

  const stored = readStored()

  if (stored.kind === 'corrupt') {
    throw new DeviceIdentityUnreadableError(stored.raw, stored.error)
  }

  if (stored.kind === 'ok') {
    try {
      cached = await importSecret(stored.value.secret)
      cachedPublic = await exportPublic(cached)
      return cached
    } catch (error) {
      // 能解析、但导入不进去（算法名变了之类）。同样不重建、不覆盖。
      throw new DeviceIdentityUnreadableError(stored.raw, error)
    }
  }

  // kind === 'none'：这台设备确实还没有身份，正常生成一把。
  const fresh = await generateIdentityKeys()
  await saveDeviceIdentity(fresh)
  cached = fresh
  cachedPublic = await exportPublic(fresh)
  return fresh
}

/** 已经有的身份（不同步生成）。给「只是想知道指纹」这类只读场景用。 */
export async function peekDeviceIdentity(): Promise<PublicIdentity | null> {
  if (cachedPublic) return cachedPublic
  const stored = readStored()
  if (stored.kind !== 'ok') return null
  try {
    cached = await importSecret(stored.value.secret)
    cachedPublic = await exportPublic(cached)
    return cachedPublic
  } catch {
    return null
  }
}

/** 本机身份的公开部分 + 指纹，给设置界面展示用。 */
export async function deviceFingerprint(): Promise<string | null> {
  const pub = await peekDeviceIdentity()
  if (!pub) return null
  return fingerprintOf(pub)
}

/** 本机身份建立了多久 —— 用来在界面上提示「这台设备于 X 认领了身份」。 */
export function deviceIdentityCreatedAt(): number | null {
  const stored = readStored()
  return stored.kind === 'ok' ? stored.value.createdAt : null
}

// ------------------------------------------------------------- 身份迁移

/**
 * 导出身份包。**这几行字就是你**，等于私钥。
 *
 * 调用方必须在界面上明确警告，不要写进日志、不要自动上传。
 */
export async function exportDeviceIdentity(): Promise<string> {
  const keys = await getDeviceIdentity()
  const secret = await exportSecret(keys)
  const pub = await exportPublic(keys)
  const fingerprint = await fingerprintOf(pub)
  return JSON.stringify(
    {
      v: 1,
      kind: 'baker-identity',
      fingerprint,
      exportedAt: Date.now(),
      secret,
    },
    null,
    2,
  )
}

/**
 * 把一份身份包装进这台设备。
 *
 * 做两件事，别把它们混起来：
 *
 *   - **不校验它属于谁**。包里那把私钥能不能用，等它第一次给事件盖章、
 *     收的人验过去了才算数 —— 本地没有第三方可以问，提前判没有任何意义。
 *   - **但校验包自己是不是自洽的**：里面声明的 `fingerprint` 必须等于由
 *     这把私钥算出来的指纹。先前这一条完全没有，于是「一份声称是 A、
 *     实际装着 B 的私钥」的身份包可以顺利导入 —— `exportDeviceIdentity`
 *     明明写了 `fingerprint` 字段，导入侧却当它不存在。界面随后显示的是
 *     本地算出来的那个（B）指纹，用户手上没有任何东西能对出来「换人了」。
 *
 * @returns 装进去之后的指纹（由私钥现场算出，不是包里声明的那个）
 */
export async function importDeviceIdentity(bundle: string): Promise<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(bundle)
  } catch {
    throw new Error('这不是一段合法的 JSON')
  }

  const secret = (parsed as { secret?: unknown }).secret
  if (
    !secret ||
    typeof (secret as SecretIdentity).ed !== 'string' ||
    typeof (secret as SecretIdentity).x !== 'string'
  ) {
    throw new Error('里面没有 Ed25519 / X25519 私钥，不像是一个身份包')
  }

  // 先试着真的导入一遍：格式不对的包要在**覆盖现有身份之前**就失败，
  // 否则用户会既丢了旧身份、又没拿到新的。
  const keys = await importSecret(secret as SecretIdentity)
  const pub = await exportPublic(keys)
  const fingerprint = await fingerprintOf(pub)

  // ★ 包自洽性检查。放在 `saveDeviceIdentity` **之前** —— 拒绝导入时
  // 本机上现有的身份一个字节都不能动。
  //
  // 「对不上」只可能是包被改过、或者几份包被拼错了；两种情况用户想要的
  // 都是「别动我现在的身份」，所以这里是拒收而不是警告后照收。
  const declared = (parsed as { fingerprint?: unknown }).fingerprint
  if (typeof declared !== 'string' || declared.length === 0) {
    throw new Error('身份包里没有 fingerprint 字段，无法确认它装的是谁的密钥')
  }
  if (declared !== fingerprint) {
    throw new Error('身份包的指纹和里面的密钥对不上 —— 这份包被改过，已拒绝导入')
  }

  await saveDeviceIdentity(keys)
  cached = keys
  cachedPublic = pub
  return fingerprint
}

/** 换一把全新的身份（相当于「重新做人」）。旧身份对应的账号就再也登不上了。 */
export async function resetDeviceIdentity(): Promise<string> {
  cached = null
  cachedPublic = null
  const fresh = await generateIdentityKeys()
  await saveDeviceIdentity(fresh)
  cached = fresh
  cachedPublic = await exportPublic(fresh)
  return fingerprintOf(cachedPublic)
}

// ------------------------------------------------------------- 内部

/**
 * 读本机存的身份。
 *
 * 三态是必须的：**「没有」和「坏了」要走完全不同的路**。
 * 早先这里把两者都塌成 `null`，于是「存着但解析不了」（比如 `JSON.parse` 抛错）
 * 会径直走到「生成一把新的并覆盖」—— 用户看到的是「登不上去」，
 * 而真正的原因（本机身份坏了）和唯一的恢复线索（旧字节）都已经被抹掉。
 */
function readStored():
  | { kind: 'none' }
  | { kind: 'ok'; value: StoredIdentity; raw: string }
  | { kind: 'corrupt'; raw: string | null; error: unknown } {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    // localStorage 本身读不到（隐私模式、被策略禁掉）。当成「还没有身份」——
    // 和「存的东西坏了」不同：这里没有任何已有字节会被覆盖的风险
    //（真读不到存储的话，后面的 save 也会当场抛错，不会静默吞掉）。
    return { kind: 'none' }
  }
  if (!raw) return { kind: 'none' }

  try {
    const parsed = JSON.parse(raw) as StoredIdentity
    if (!parsed?.secret?.ed || !parsed?.secret?.x) {
      return { kind: 'corrupt', raw, error: new Error('存的不是一份身份（缺 ed/x 字段）') }
    }
    return { kind: 'ok', value: parsed, raw }
  } catch (error) {
    return { kind: 'corrupt', raw, error }
  }
}

async function saveDeviceIdentity(keys: IdentityKeys): Promise<void> {
  const payload: StoredIdentity = {
    secret: await exportSecret(keys),
    createdAt: Date.now(),
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
}

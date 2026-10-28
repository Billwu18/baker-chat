import type { UserId } from './protocol/types'

/**
 * 本机配置。
 *
 * 存在 localStorage 里。**里面没有任何地址** —— 这是 P2P 版和服务器版
 * 最大的差别，值得单独讲清楚：
 *
 *   - 服务器版需要一个 `serverUrl`（连哪台机器）和一份 `servers` 列表
 *     （记住用过的每一台）。那是因为「别人」住在某台服务器上，你得先
 *     知道去找谁。
 *   - P2P 版没有这回事。人在同一个局域网里就自己互相发现了 —— 组播会
 *     把所有人带到一起，**没有「去哪里」这个决定**，所以配置里也就没有
 *     可以被配错、被改坏的地址。
 *
 * 于是剩下的只有「我是谁、我叫什么」：
 *
 *   - **身份**是这台设备的一对密钥（`src/crypto/keys.ts`，存在 device
 *     密钥表里），它是**设备级**的、算出来的，不是填进去的。`selfId`
 *     是它的派生缓存，每次启动都会重算覆盖。
 *   - **名字和头像**是给人看的，随便改，改完广播给别人。
 *
 * 一个推论：**换一台机器就是换一个人。** 身份跟着设备密钥走，密钥不在
 * 这台机器上，你就不是原来那个 id —— 指纹也会变，对方要重新核对。
 * 这不是缺陷，是「不经过任何第三方」必然的代价：没有任何人有能力
 * 替你证明你是谁。
 */

export interface AppConfig {
  /**
   * 本机 id。
   *
   * **它就是 `src/p2p/event.ts` 的 `identityOf()` 算出来的值**
   * （公钥的 SHA-256，43 字符 base64url），不是用户能随便填的一个名字。
   *
   * 这里存的是**上一次算出来的缓存**，不是事实来源：`prepareTransport()`
   * 每次启动都会重算并覆盖。设备密钥换了（清了站点数据但配置还在）而这里
   * 留着旧值的话，界面会拿着一个已经不存在的 id 去显示自己 —— 而那个 id
   * 是任何人用旧公钥算出来的，等于身份对不上。
   *
   * 空串 = 「还没派生」，是一个合法状态（见 `DEFAULT_CONFIG` 的注释）。
   */
  selfId: UserId
  /**
   * 给别人看的显示名。空串表示「还没起名字」，界面会退回显示短码。
   *
   * 和 selfId 的分工要拿稳：selfId 是算出来的、改不了；名字是随便改的，
   * 谁都能叫「管理员」。所以名字**不能**被当成身份用，界面上一律配着
   * 编号显示。
   */
  displayName: string
  /**
   * 头像。两种取值：内置相册的 key（见 `src/data/avatars.ts`），
   * 或者用户上传后压出来的 `data:` URL。
   *
   * 上传的头像走 data: URL 而不是上传到某处 —— P2P 里根本没有「某处」。
   * 它跟着 `profile` 事件在局域网里走，天然可用。代价是事件会变大，
   * 所以上传前客户端会压小。
   */
  avatarKey: string
}

const STORAGE_KEY = 'baker.config.v1'

export const DEFAULT_CONFIG: AppConfig = {
  // 空串 = 还没算过。真实的 id 由 prepareTransport() 从设备公钥派生后写回来。
  // 这里**不能**放一个像 'u_admin' 的默认值：那样所有人会先以同一个身份出现，
  // 而且看起来一切正常（界面照样有名字），是最难查的一类。
  selfId: '',
  displayName: '',
  avatarKey: '',
}

// ---------------------------------------------------------------- 读写

/**
 * 逐字段校验。
 *
 * localStorage 里的东西可能被手改过，也可能是旧版本写下的。
 *
 * **故意只取认识的字段**：服务器版写下的 `serverUrl` / `token` / `servers`
 * 会被安静地丢掉。这正是想要的 —— 一个从 1.x 升上来的用户不该因为
 * 配置里还留着 `ws://…` 而看到界面上多出一个连不上的东西。
 */
function normalize(raw: unknown): AppConfig {
  const record = (raw ?? {}) as Record<string, unknown>
  // selfId 允许是空串 —— 「还没派生」是一个合法状态，所以判据是
  // 「是不是字符串」而不是「是不是非空」。
  return {
    selfId: typeof record.selfId === 'string' ? record.selfId : DEFAULT_CONFIG.selfId,
    displayName:
      typeof record.displayName === 'string' ? record.displayName : DEFAULT_CONFIG.displayName,
    avatarKey: typeof record.avatarKey === 'string' ? record.avatarKey : DEFAULT_CONFIG.avatarKey,
  }
}

export function loadConfig(): AppConfig {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    return normalize(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const next = normalize({ ...loadConfig(), ...patch })
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // 隐私模式下写不了，忽略即可，本次会话仍然生效
    }
  }
  return next
}

export function resetConfig(): AppConfig {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 同上
  }
  return { ...DEFAULT_CONFIG }
}

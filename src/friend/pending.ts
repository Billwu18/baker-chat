import type { UserId } from '../protocol/types'

/**
 * 「待加好友」的临时记号。
 *
 * 为什么需要它：粘贴配对码之后要切换服务器、切身份，而这两件事都是
 * `saveConfig()` + `window.location.reload()`（见 SettingsPanel —— 热切换会让
 * 已经建立的会话状态半新半旧）。可是**加好友这个动作必须发生在重载之后**，
 * 因为那时才连上对方的服务器。
 *
 * 所以配对码流程被切成两半：
 *   现在：解析码 → 存配置 → 记下「重载后要 pin 谁」→ reload
 *   重载后：连上 → 把这个记号取出来 pin 掉 → 销毁记号
 *
 * 用 localStorage 而不是内存变量，原因就是中间隔了一次页面重载。
 * 取名带 v1、取完立刻删，避免「一次粘贴永久每天加一次好友」这种鬼故事。
 */
const KEY = 'baker.pendingFriend.v1'

/** 记下重载后要去 pin 谁。 */
export function setPendingFriend(userId: UserId): void {
  try {
    localStorage.setItem(KEY, userId)
  } catch {
    // 隐私模式下写不了，那就只能放弃这一次自动添加，不影响连接
  }
}

/**
 * 取出并**立刻销毁**待加好友记号。
 * 返回 null 表示没有待处理的（绝大多数情况下都是 null）。
 */
export function takePendingFriend(): UserId | null {
  try {
    const value = localStorage.getItem(KEY)
    if (!value) return null
    localStorage.removeItem(KEY)
    return value
  } catch {
    return null
  }
}

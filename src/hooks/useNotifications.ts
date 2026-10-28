import { useEffect, useRef } from 'react'
import { useChatState, useChatStore } from '../store/ChatProvider'
import { useUiSettings } from '../store/uiSettings'
import { personOf } from '../data/person'

/**
 * 收到新消息时提醒用户。
 *
 * 三种提醒方式，按「用户在不在看」逐级降级：
 *   1. 正在看那个会话 → 什么都不做（消息就在眼前）
 *   2. 窗口没聚焦      → 系统通知（网页版走 Notification API，桌面壳里同样可用）
 *   3. 窗口聚焦但看别的会话 → 只闪任务栏
 *
 * 免打扰的会话一律不提醒 —— 未读照常计，但别弹东西。
 *
 * 实现上刻意用「消息 id 集合」去重而不是监听事件：store 没有对外的
 * 「新消息」事件口，而重连、翻历史、对账乐观消息都会导致列表变化，
 * 按 id 差集判断可以保证既不多提醒也不漏提醒。
 */
/**
 * 「已提醒过」的 id 集合的上限。
 *
 * 这张表只在**进程存活期间**有意义（它就是为了让重连 / 翻历史 / 对账乐观消息
 * 引起的列表变化不重复弹通知），刷新之后从头开始 —— 所以它没有任何理由
 * 无限增长。原来它是只加不减的 `Set<string>`：聊一整天就是几万个字符串
 * 常驻，而且每次 state 变化都要拿它查一遍。
 *
 * 超过上限就按「现在还活在消息列表里的 id」重建。丢掉一个还在列表里的 id
 * 才会重新弹一次通知，所以宁可重建得保守一点。
 */
const MAX_SEEN = 4_000

export function useNotifications(): void {
  const state = useChatState()
  const store = useChatStore()
  const { settings } = useUiSettings()
  const seen = useRef<Set<string>>(new Set())
  const primed = useRef(false)

  // 权限在挂载时就要到手，不能等第一条消息 —— 那一条会赶不上（还没放行就丢了）。
  useEffect(() => {
    ensureNotificationPermission()
  }, [])

  // 原生通知的「被点击」是 Rust 那边发回来的事件（见 src-tauri/src/notify.rs）。
  // 网页版的点击走 `shown.onclick`，到不了这里。
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let stop: (() => void) | null = null
    let cancelled = false
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ sessionId: string; messageId: string }>('baker://notify-click', (event) => {
          void focusMainWindow().then(() =>
            store.focusMessage(event.payload.sessionId, event.payload.messageId),
          )
        }),
      )
      .then((off) => {
        if (cancelled) off()
        else stop = off
      })
      .catch(() => {})
    return () => {
      cancelled = true
      stop?.()
    }
  }, [store])

  useEffect(() => {
    // 第一次拿到消息列表时先全部记下来，不然一启动就会把历史消息全提醒一遍
    if (!primed.current) {
      if (Object.keys(state.messages).length === 0) return
      for (const list of Object.values(state.messages)) {
        for (const message of list) seen.current.add(message.id)
      }
      primed.current = true
      return
    }

    for (const [sessionId, list] of Object.entries(state.messages)) {
      const message = list[list.length - 1]
      if (!message || seen.current.has(message.id)) continue
      for (const entry of list) seen.current.add(entry.id)

      if (message.authorId === state.self.id) continue
      if (sessionId === state.activeSessionId && document.hasFocus()) continue
      if (store.isMuted(sessionId)) continue

      const session = state.sessions.find((s) => s.id === sessionId)
      const title = session ? session.name : personOf(state.roster, message.authorId).name
      const body =
        message.kind === 'text'
          ? (message.text ?? '')
          : message.kind === 'sticker'
            ? '[贴纸]'
            : '[图片]'

      if (!document.hasFocus()) {
        notify(
          title,
          `${personOf(state.roster, message.authorId).name}：${body}`,
          sessionId,
          message.id,
          () => {
            void focusMainWindow().then(() => store.focusMessage(sessionId, message.id))
          },
        )
      }
      if (settings.flashOnMessage) flashWindow()
    }

    // 见 `MAX_SEEN`：只在超限时才重建，免得每次 state 变化都白遍历一遍。
    if (seen.current.size > MAX_SEEN) {
      const live = new Set<string>()
      for (const list of Object.values(state.messages)) {
        for (const entry of list) live.add(entry.id)
      }
      seen.current = live
    }
  }, [state.messages, state.sessions, state.activeSessionId, state.self.id, store, settings.flashOnMessage])
}

function notify(
  title: string,
  body: string,
  sessionId: string,
  messageId: string,
  onClick: () => void,
): void {
  // 桌面壳里走 **Rust 的原生通知**，不用网页的 Notification API。
  //
  // 原因写在 `src-tauri/src/notify.rs` 开头：把 WebView2 的通知权限打开之后
  // `Notification.permission` 确实变 `granted` 了，但通知**根本到不了 Windows
  // 通知中心**（实测通知数据库一个字节都没动），而且不报错。自己发才有。
  if ('__TAURI_INTERNALS__' in window) {
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('notify_toast', { sessionId, messageId, title, body }))
      .catch((error) => console.warn('[notify] 系统通知没发出去：', error))
    return
  }

  // 网页版（`npm run dev` 直接在浏览器里看界面）退回标准通知。
  try {
    if (typeof Notification === 'undefined') return

    // 还没放行就先要一次权限，并且**这条不弹**。正常情况下挂载时已经问过了。
    if (Notification.permission !== 'granted') {
      void Notification.requestPermission().catch(() => {})
      return
    }

    // `tag` 用会话 id：同一个人连发五条，只留一条横幅（后一条顶掉前一条），
    // 而不是把屏幕右下角铺满。
    const shown = new Notification(title, { body, tag: sessionId })
    shown.onclick = () => {
      onClick()
      shown.close()
    }
  } catch {
    // 通知失败不该影响收消息本身
  }
}

/** 挂载时问一次通知权限：等到第一条消息来了再问，那一条就赶不上了。 */
export function ensureNotificationPermission(): void {
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'default') return
    void Notification.requestPermission().catch(() => {})
  } catch {
    // 浏览器/壳里没有通知能力，忽略
  }
}

/** 让任务栏图标闪一下。Tauri 下有效，浏览器里静默跳过。 */
function flashWindow(): void {
  if (!('__TAURI_INTERNALS__' in window)) return
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow, UserAttentionType }) =>
      // Critical 会一直闪到用户点开窗口为止，普通提醒用这个刚好
      getCurrentWindow().requestUserAttention(UserAttentionType.Critical),
    )
    .catch(() => {})
}

/**
 * 把窗口叫到前面来。
 *
 * `show()` 管「被隐藏」，`unminimize()` 管「最小化」，`setFocus()` 管「在别的
 * 窗口后面」。三个都得调：少一个就会出现「点了通知，窗口动了一下但没上桌面」。
 */
export async function focusMainWindow(): Promise<void> {
  if (!('__TAURI_INTERNALS__' in window)) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    await win.unminimize().catch(() => {})
    await win.show().catch(() => {})
    await win.setFocus().catch(() => {})
  } catch {
    // 拿不到窗口就算了，会话还是会切过去
  }
}

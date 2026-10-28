import { useChatState, useChatStore } from '../store/ChatProvider'

/**
 * 全局错误条。
 *
 * 原版没有这个组件（游戏里出错是走它自己的 toast / 对话框），
 * 这边用一个贴在底部的深红条，任何 transport 报错都会经由 store 冒到这里。
 */
export function ErrorBanner() {
  const { error } = useChatState()
  const store = useChatStore()

  if (!error) return null

  return (
    <div id="error-banner" role="alert">
      <span>{error}</span>
      <button type="button" onClick={() => store.dismissError()} aria-label="关闭">
        ×
      </button>
    </div>
  )
}

/**
 * 断线时盖在消息区上的提示。
 * 挂在 #session-main 里面，用绝对定位铺满 —— 对应 CSS 里的 #connection-overlay。
 */
export function ConnectionOverlay() {
  const { connection, connectionReason } = useChatState()

  if (connection === 'connected' || connection === 'idle') return null

  const text =
    connection === 'connecting'
      ? '正在启动…'
      : connection === 'reconnecting'
        ? '正在重连…'
        : '没连上局域网'

  return (
    <div id="connection-overlay">
      <span>{text}</span>
      {connectionReason && <span style={{ opacity: 0.5, fontSize: '0.85em' }}>{connectionReason}</span>}
    </div>
  )
}

/**
 * 「这个会话里有消息是明文发的」提示条，挂在会话头下面。
 *
 * 为什么需要它：端到端加密拿不到会话密钥时，代码的选择是「照常发出去」——
 * 这个取舍本身没错（建一把钥匙要跑 X25519 加一次网络往返，不该挡在发消息前面），
 * 但**必须让人知道**。原来这条路上只有一行 `console.warn`，界面上完全看不出来，
 * 于是用户以为自己在聊私密内容，实际上正文是明文走局域网的（报告 M3）。
 *
 * 用 `role="status"` 而不是 `alert`：它既不是错误也不会打断打字，
 * 频繁弹出 `alert` 反而会被无视。做成一条常驻的、需要手动收起的条。
 */
export function PlaintextNotice() {
  const { unencrypted, activeSessionId } = useChatState()
  const store = useChatStore()

  const sessionId = activeSessionId
  if (!sessionId || !unencrypted[sessionId]) return null

  return (
    <div id="plaintext-notice" role="status">
      <span>
        这个会话里有消息是<b>未加密</b>发出去的 —— 当时还没拿到会话密钥，正文在局域网里是明文。
      </span>
      <button type="button" onClick={() => store.dismissPlaintextNotice(sessionId)}>
        知道了
      </button>
    </div>
  )
}

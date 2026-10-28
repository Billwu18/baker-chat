import { iconUrl } from '../assets/registry'

/**
 * 顶部标签栏。
 *
 * 游戏里 Baker 是手机上的一个应用，屏幕顶端有一条居中的 SNS 标签栏：
 * 搜索 / Baker（当前页，高亮成 Baker 黄）/ 公告 / 好友，最右边一个快捷键提示。
 * 上一版没做这条，整个界面就没有「游戏内 HUD」的味道。
 *
 * 图标直接取游戏原版素材（extracted/icon）：
 *   btn_SNS                     Baker 的双气泡图标
 *   icon_sns_chat_07            公告/通知（带 ! 的纸张）
 *   icon_sns_friend_title_number 好友（人形）
 * 搜索和设置原版素材里没有，用内联 SVG 画：**不用 CSS 拼图形** ——
 * 拼出来的放大镜把手是单独一个旋转的小方块，换分辨率/换缩放就错位、边缘发虚。
 */
export function BakerTabBar({
  onSearch,
  onNotice,
  onFriend,
  onSettings,
  unread,
  noticeUnread,
  friendUnread,
}: {
  onSearch: () => void
  onNotice: () => void
  onFriend: () => void
  /** 原来只有「点标题」一条路能打开设置，太隐蔽 */
  onSettings: () => void
  unread: number
  /** 有没看过的新公告 */
  noticeUnread: boolean
  /** 有人加了你（对方 pin 了你但还没成好友），挂个点提示去看看 */
  friendUnread: boolean
}) {
  return (
    <div id="baker-tabbar">
      <button
        className="tabbar-btn tabbar-search"
        type="button"
        aria-label="搜索"
        title="搜索会话与消息（Ctrl+K）"
        onClick={onSearch}
      >
        {/* 放大镜：一个正圆 + 一根 45° 把手，把手起点压在圆边上，接缝才连得上 */}
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="10" cy="10" r="6.6" />
          <path d="M14.6 14.6 20.3 20.3" />
        </svg>
      </button>

      <button className="tabbar-btn tabbar-tab" type="button" aria-label="会话消息" aria-current="page">
        <img src={iconUrl('btn_SNS')} alt="" />
        {unread > 0 && <span className="tabbar-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>

      <button
        className="tabbar-btn"
        type="button"
        aria-label="公告"
        title="公告"
        onClick={onNotice}
      >
        <img src={iconUrl('icon_sns_chat_07')} alt="" />
        {noticeUnread && <span className="tabbar-dot" aria-hidden="true" />}
      </button>

      <span className="tabbar-divider" aria-hidden="true" />

      <button
        className="tabbar-btn"
        type="button"
        aria-label="好友"
        title="加好友 / 配对码"
        onClick={onFriend}
      >
        <img src={iconUrl('icon_sns_friend_title_number')} alt="" />
        {friendUnread && <span className="tabbar-dot" aria-hidden="true" />}
      </button>

      {/*
        原来是原版那个「快捷键 E」的描边小方块 —— 但桌面壳里根本没有 E 这个快捷键，
        一个提示着不存在的键的方框就是纯装饰。改成真按钮：齿轮，点开设置。
      */}
      <button
        className="tabbar-btn tabbar-settings"
        type="button"
        aria-label="设置"
        title="设置"
        onClick={onSettings}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" />
        </svg>
      </button>
    </div>
  )
}

/**
 * 右上角关闭按钮。
 *
 * 在桌面壳里走 Tauri 的窗口 API 正常关窗；在浏览器里跑（vite preview / 网页版）
 * 就退回到 window.close()。动态 import 是为了让浏览器构建也能通过。
 */
export function CloseButton() {
  return (
    <button
      id="baker-close"
      type="button"
      aria-label="关闭"
      onClick={async () => {
        try {
          if ('__TAURI_INTERNALS__' in window) {
            const { getCurrentWindow } = await import('@tauri-apps/api/window')
            await getCurrentWindow().close()
            return
          }
        } catch {
          // 不在桌面壳里，往下走浏览器分支
        }
        window.close()
      }}
    >
      ✕
    </button>
  )
}

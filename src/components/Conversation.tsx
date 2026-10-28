import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReplyRef } from '../protocol/types'
import { useChatState, useChatStore, useActiveMessages, useActiveSession, useTypingNames } from '../store/ChatProvider'
import { useUiSettings } from '../store/uiSettings'
import { buildTimeline } from '../utils/grouping'
import { personOf } from '../data/person'
import { DayDivider, MessageRow, TypingIndicator } from './MessageRow'
import { InputArea } from './InputArea'
import { ConnectionOverlay, PlaintextNotice } from './ErrorBanner'
import { ImageLightbox } from './ImageLightbox'
import { SessionSettingsDialog } from './SessionSettingsDialog'
import { decorateUrl, decoUrl } from '../assets/registry'

/**
 * 右侧会话区。
 *
 * 原版结构（baker-dx session.rs:111-133）：
 *   #session.flex.flex-column
 *     ├─ #session-header.flex.flex-column > span          会话名
 *     ├─ #session-main.flex.flex-column
 *     │    ├─ SessionMainContent                           消息列表
 *     │    ├─ InputArea
 *     │    └─ MainContentTopDecoration                    会话区顶部那条细线 + 右侧彩条
 *     └─ img#session-decorate                              右下角背景装饰
 */
export function Conversation() {
  const state = useChatState()
  const store = useChatStore()
  const session = useActiveSession()
  const messages = useActiveMessages()
  const typingNames = useTypingNames()
  const { settings } = useUiSettings()

  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 用户往上翻历史时，底下攒了多少条新消息 */
  const [pendingNew, setPendingNew] = useState(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  // 「是否贴在底部」同时要有两份：ref 给 effect / 事件回调同步读，state 给渲染用。
  //
  // 原来只有 ref，于是下面那个「回到最新」按钮是在**渲染期读 ref** ——
  // ref 的变化不触发重渲染，那个「回到最新」按钮的出现/消失完全靠别的状态顺带
  // 把它带上，滚一下不回最新也不会立刻消失。ref 和 state 用同一个 setter 一起改，
  // 不会出现两边不一致。
  const stickRef = useRef(true)
  const [stick, setStick] = useState(true)
  const markStick = (value: boolean) => {
    if (stickRef.current === value) return
    stickRef.current = value
    setStick(value)
  }

  const timeline = useMemo(
    () => (session ? buildTimeline(messages, state.self.id) : []),
    [messages, session, state.self.id],
  )

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    markStick(true)
    setPendingNew(0)
  }

  // 只有用户本来就贴在底部时才自动跟随，免得正在翻历史被硬拽下来
  useEffect(() => {
    if (stickRef.current) scrollToBottom()
    else setPendingNew((count) => count + 1)
    // 用 messages.length 而不是 timeline.length：插入日期分隔线不该算成新消息
  }, [messages.length, session?.id])

  useLayoutEffect(() => {
    // 切会话时直接跳到底部，不做动画
    markStick(true)
    setPendingNew(0)
    setReplyTo(null)
    scrollToBottom()
  }, [session?.id])

  // 搜索结果 / 引用条要求「滚到这条消息」。等 DOM 里确实有它了再滚。
  useEffect(() => {
    const focus = state.focus
    if (!focus || focus.sessionId !== session?.id) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${focus.messageId}"]`)
    if (!el) return
    markStick(false)
    el.scrollIntoView({ block: 'center' })
    el.classList.add('is-flashing')
    const timer = window.setTimeout(() => el.classList.remove('is-flashing'), 1600)
    store.clearFocus()
    return () => window.clearTimeout(timer)
  }, [state.focus, session?.id, store, timeline.length])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    markStick(atBottom)
    if (atBottom && pendingNew) setPendingNew(0)
    if (el.scrollTop < 60 && session && state.hasMore[session.id] && !state.loadingMore) {
      void store.loadMore()
    }
  }

  // 没有选中会话时，整个右栏就是一块空状态（原版也是这样：不画会话头和输入区，
  // 只在中间摆宝石图形 + 点阵 + 一条横线，横线上压一块深色标签写「- 请选择会话 -」）。
  if (!session) {
    return (
      <div id="session" className="flex flex-column">
        <div id="session-not-chosen">
          <div className="not-chosen">
            <span className="not-chosen-grid" aria-hidden="true" />
            <span className="not-chosen-gem" aria-hidden="true" />
            <span className="not-chosen-line" aria-hidden="true" />
            <span className="not-chosen-label">- 请选择会话 -</span>
            <span className="not-chosen-empty">EMPTY</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div id="session" className="flex flex-column">
      {/* 用 div 而不是 button：全局样式里有 `button{border-style:none}`，
          会把会话头那条 2px 边框吃掉 */}
      <div
        id="session-header"
        className="flex flex-column"
        role="button"
        tabIndex={0}
        onClick={() => setSettingsOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setSettingsOpen(true)
          }
        }}
        title="会话设置"
      >
        <span>
          {session.pinned && <i className="session-pin" aria-label="已置顶" />}
          {session.name}
          {session.muted && <i className="session-mute" aria-label="已免打扰" />}
          <em className="session-member-count">
            {session.kind === 'group' ? `${session.memberIds.length} 人` : '私聊'}
          </em>
        </span>
      </div>

      <PlaintextNotice />

      <div id="session-main" className="flex flex-column">
        <div
          id="session-main-content"
          className="flex flex-column"
          ref={scrollRef}
          onScroll={onScroll}
        >
          {state.loadingMore && (
            <div className="state">
              <span>正在读取更早的消息…</span>
            </div>
          )}

          {timeline.length === 0 && (
            <div className="state">
              <span>暂无消息</span>
            </div>
          )}

          {timeline.map((entry) =>
            entry.kind === 'divider' ? (
              <DayDivider key={entry.key} at={entry.at} />
            ) : (
              <MessageRow
                key={entry.key}
                row={entry.row}
                author={personOf(state.roster, entry.row.authorId)}
                showNames={settings.showSenderNames}
                onRecall={(message) => void store.recall(message)}
                onReact={(message, emojiKey) => void store.toggleReaction(message, emojiKey)}
                onRetry={(message) => void store.retry(message)}
                onReply={setReplyTo}
                onOpenImage={setLightbox}
                onSaveFile={(message) => store.saveFile(message)}
                onDelete={(message) => store.deleteMessage(message)}
                onJumpTo={(messageId) => void store.focusMessage(session.id, messageId)}
              />
            ),
          )}

          <TypingIndicator names={typingNames} />
        </div>

        {!stick && (
          <button type="button" className="jump-to-bottom" onClick={() => scrollToBottom(true)}>
            {pendingNew > 0 ? `${pendingNew} 条新消息 ↓` : '回到最新 ↓'}
          </button>
        )}

        <InputArea replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />

        <div id="main-content-top-decoration">
          <div id="main-content-top-decoration-left" />
          <div id="main-content-top-decoration-right" />
          <img id="main-content-top-decoration-colors" src={decoUrl('colors')} alt="" />
        </div>

        <ConnectionOverlay />
      </div>

      <img id="session-decorate" src={decorateUrl('deco_sns_tweet_decorate_10')} alt="" />

      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
      {settingsOpen && <SessionSettingsDialog session={session} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

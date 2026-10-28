import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message, Session } from '../protocol/types'
import { personOf } from '../data/person'
import { avatarUrl } from '../assets/registry'
import { useChatState, useChatStore } from '../store/ChatProvider'
import { formatClock } from '../utils/time'

type Scope = 'all' | 'current'

/** 正文里能把命中位置标出来：把搜到的片段前后各留一点，中间加标记。 */
function highlight(text: string, needle: string): React.ReactNode {
  const index = text.toLowerCase().indexOf(needle.toLowerCase())
  if (index === -1) return text
  const from = Math.max(0, index - 18)
  const to = Math.min(text.length, index + needle.length + 40)
  const head = text.slice(from, index)
  const hit = text.slice(index, index + needle.length)
  const tail = text.slice(index + needle.length, to)
  return (
    <>
      {from > 0 && '…'}
      {head}
      <mark>{hit}</mark>
      {tail}
      {to < text.length && '…'}
    </>
  )
}

/**
 * 全局搜索。
 *
 * 会话名和消息正文一起搜 —— 顶栏那颗放大镜在游戏里就是干这个的。
 * 只在已经拉到本机的消息里找 —— P2P 里没有谁替你存着全部历史，
 * 能搜到的就是本机手上有的那些。
 */
export function SearchPanel({ onClose }: { onClose: () => void }) {
  const state = useChatState()
  const store = useChatStore()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const trimmed = query.trim()
  const scopeSession = scope === 'current' ? state.activeSessionId : null

  const sessionHits = useMemo<Session[]>(() => {
    if (!trimmed) return []
    return state.sessions.filter((s) => s.name.toLowerCase().includes(trimmed.toLowerCase()))
  }, [state.sessions, trimmed])

  const messageHits = useMemo<{ session: Session; message: Message }[]>(() => {
    if (!trimmed) return []
    const needle = trimmed.toLowerCase()
    const out: { session: Session; message: Message }[] = []
    for (const session of state.sessions) {
      if (scopeSession && session.id !== scopeSession) continue
      for (const message of state.messages[session.id] ?? []) {
        if (message.recalled) continue
        const body = message.text ?? message.systemText ?? ''
        if (body.toLowerCase().includes(needle)) out.push({ session, message })
      }
    }
    return out.slice(0, 60)
  }, [state.sessions, state.messages, trimmed, scopeSession])

  const open = async (sessionId: string, messageId: string) => {
    await store.focusMessage(sessionId, messageId)
    onClose()
  }

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search-panel" onClick={(event) => event.stopPropagation()}>
        <div className="search-bar">
          <span className="search-glyph" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="搜索会话与消息"
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="search-close" onClick={onClose} aria-label="关闭搜索" />
        </div>

        <div className="search-scope">
          <button
            type="button"
            className={scope === 'all' ? 'is-active' : undefined}
            onClick={() => setScope('all')}
          >
            全部会话
          </button>
          <button
            type="button"
            className={scope === 'current' ? 'is-active' : undefined}
            disabled={!state.activeSessionId}
            onClick={() => setScope('current')}
          >
            仅当前会话
          </button>
        </div>

        <div className="search-results">
          {!trimmed && <p className="search-hint">输入关键词</p>}

          {trimmed && sessionHits.length === 0 && messageHits.length === 0 && (
            <p className="search-hint">没有匹配「{trimmed}」的内容</p>
          )}

          {sessionHits.length > 0 && (
            <>
              <p className="search-group">会话 · {sessionHits.length}</p>
              {sessionHits.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="search-row"
                  onClick={() => {
                    void store.selectSession(session.id)
                    onClose()
                  }}
                >
                  <img className="search-avatar" src={avatarUrl(session.avatarKey)} alt="" />
                  <span className="search-main">
                    <span className="search-title">{session.name}</span>
                    <span className="search-sub">
                      {session.kind === 'group' ? `${session.memberIds.length} 位成员` : '私聊'}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}

          {messageHits.length > 0 && (
            <>
              <p className="search-group">消息 · {messageHits.length}</p>
              {messageHits.map(({ session, message }) => (
                <button
                  key={message.id}
                  type="button"
                  className="search-row"
                  onClick={() => void open(session.id, message.id)}
                >
                  <img
                    className="search-avatar"
                    src={avatarUrl(personOf(state.roster, message.authorId).avatarKey)}
                    alt=""
                  />
                  <span className="search-main">
                    <span className="search-title">
                      {personOf(state.roster, message.authorId).name}
                      <i> · {session.name}</i>
                    </span>
                    <span className="search-sub">
                      {highlight(message.text ?? message.systemText ?? '', trimmed)}
                    </span>
                  </span>
                  <span className="search-time">{formatClock(message.sentAt)}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

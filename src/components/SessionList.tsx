import { useMemo, useState } from 'react'
import { useChatState, useChatStore } from '../store/ChatProvider'
import { avatarUrl } from '../assets/registry'
import type { Message, Session } from '../protocol/types'
import { formatRelative, summarize } from '../utils/time'
import { useDraftIds } from '../store/drafts'
import { NewSessionDialog } from './NewSessionDialog'

/** 会话列表的筛选口径。原版底部那颗按钮就是干这个的（漏斗图标 + 「全部显示」）。 */
type Filter = 'all' | 'unread' | 'group' | 'direct'

const FILTER_LABEL: Record<Filter, string> = {
  all: '全部显示',
  unread: '仅未读',
  group: '仅群聊',
  direct: '仅私聊',
}

/**
 * 左侧会话列表。
 *
 * 对应原版结构： #cards-wrapper > #session-cards > .card*
 * 每张卡 420×85、padding 6/6/6/8、gap 18、边框 #737373 2px、圆角 5px。
 *
 * 底部那颗胶囊按钮原版是**筛选器**（漏斗 + 「全部显示」），不是「添加新会话」——
 * 新建会话作为菜单里的一项保留下来。
 */
export function SessionList() {
  const { sessions, activeSessionId, messages } = useChatState()
  const store = useChatStore()
  const drafts = useDraftIds()
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [menuOpen, setMenuOpen] = useState(false)

  const visible = useMemo(() => {
    if (filter === 'unread') return sessions.filter((s) => (s.unread ?? 0) > 0)
    if (filter === 'group') return sessions.filter((s) => s.kind === 'group')
    if (filter === 'direct') return sessions.filter((s) => s.kind === 'direct')
    return sessions
  }, [sessions, filter])

  return (
    <div id="cards-column">
      <div id="cards-wrapper">
        <div id="session-cards">
          {visible.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              hasDraft={Boolean(drafts[session.id])}
              onSelect={() => void store.selectSession(session.id)}
              lastText={summarize(
                lastMessageText(messages[session.id]),
                session.kind === 'group' ? `${session.memberIds.length} 位成员` : '还没有消息',
              )}
            />
          ))}

          {visible.length === 0 && (
            <p className="cards-empty">
              {sessions.length === 0 ? '暂无会话' : '没有符合条件的会话'}
            </p>
          )}
        </div>
      </div>

      <div id="cards-filter">
        <button
          id="cards-new"
          type="button"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span>{FILTER_LABEL[filter]}</span>
          <FilterGlyph />
        </button>

        {menuOpen && (
          <div className="filter-menu">
            <p className="filter-menu-title">显示范围</p>
            {(['all', 'unread', 'group', 'direct'] as Filter[]).map((key) => (
              <button
                key={key}
                type="button"
                className={filter === key ? 'is-selected' : undefined}
                onClick={() => {
                  setFilter(key)
                  setMenuOpen(false)
                }}
              >
                {FILTER_LABEL[key]}
              </button>
            ))}
            <p className="filter-menu-title">会话</p>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                setCreating(true)
              }}
            >
              新建会话…
            </button>
          </div>
        )}
      </div>

      {creating && <NewSessionDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

/** 会话卡第二行显示的最后一条消息摘要。 */
function lastMessageText(list: Message[] | undefined): string | undefined {
  const last = list?.[list.length - 1]
  if (!last) return undefined
  if (last.recalled) return '消息已被撤回'
  if (last.kind === 'sticker') return '[贴纸]'
  if (last.kind === 'image') return '[图片]'
  return last.text
}

function SessionCard({
  session,
  active,
  hasDraft,
  onSelect,
  lastText,
}: {
  session: Session
  active: boolean
  hasDraft: boolean
  onSelect: () => void
  lastText: string
}) {
  const unread = session.unread ?? 0

  return (
    <div
      className={`card flex flex-row${active ? ' is-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="card-avatar">
        <div id="card-img-wrapper">
          <img src={avatarUrl(session.avatarKey)} alt="" />
        </div>
        {/* 有未读时头像左上角挂一个小角标，原版就是这个造型 */}
        {unread > 0 && <span className="card-avatar-flag">”</span>}
      </div>

      <div className="card-name">
        <span>
          {session.pinned && <i className="card-pin" aria-label="已置顶" />}
          {session.name}
          {session.muted && <i className="card-mute" aria-label="已免打扰" />}
        </span>
        {/* 原版卡片里没有这一行，默认由 CSS 藏起来（body.show-preview 才显示） */}
        <span className="card-last">
          {session.lastActiveAt ? `${formatRelative(session.lastActiveAt)} · ` : ''}
          {lastText}
        </span>
        {hasDraft && <span className="card-draft">有没发出去的草稿</span>}
      </div>

      {/* 未读：右上角外侧一枚橙色菱形（原版没有数字） */}
      {unread > 0 && <span className="card-unread" aria-label={`${unread} 条未读`} />}

      {/* 右下角的圆形展开钮，原版每张卡都有 */}
      <span className="card-chevron" aria-hidden="true" />
    </div>
  )
}

/** 「全部显示」按钮右侧的漏斗图标，对应原版那颗筛选按钮。 */
function FilterGlyph() {
  return <span className="filter-glyph" aria-hidden="true" />
}

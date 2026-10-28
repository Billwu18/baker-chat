import { useEffect, useState } from 'react'
import type { Session } from '../protocol/types'
import { personOf } from '../data/person'
import { avatarUrl } from '../assets/registry'
import { useChatState, useChatStore } from '../store/ChatProvider'
import { formatRelative } from '../utils/time'

/**
 * 会话设置。
 *
 * 对应原版「更多」面板里那一页：会话名、参与者列表、以及一个红色的删除入口
 * （原版文案是「消息会永久消失！」）。这里在此基础上把两个常用的本地开关
 * ——置顶和免打扰——也放进来，它们只影响这台机器。
 */
export function SessionSettingsDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const store = useChatStore()
  const state = useChatState()
  const [confirming, setConfirming] = useState<'none' | 'clear' | 'leave'>('none')

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

  const members = session.memberIds.map((id) => personOf(state.roster, id))
  const online = members.filter((op) => store.isOnline(op.id)).length

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog session-settings" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>{session.name}</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭" />
        </div>

        <div className="dialog-content">
          <p className="dialog-field-title">
            参与者 · {members.length} 人{online > 0 ? `（${online} 人在线）` : ''}
          </p>
          <div className="dialog-members">
            {members.map((op) => {
              const isOnline = store.isOnline(op.id)
              return (
                <p key={op.id} className="dialog-member">
                  <img src={avatarUrl(op.avatarKey)} alt="" />
                  <span className="dialog-member-name">{op.name}</span>
                  <span className="dialog-member-number">#{op.number}</span>
                  {op.id === store.getSnapshot().self.id && <span className="dialog-member-tag">我</span>}
                  <span className={`dialog-member-dot${isOnline ? ' is-online' : ''}`} aria-label={isOnline ? '在线' : '离线'} />
                </p>
              )
            })}
          </div>

          <p className="dialog-field-title">本机设置</p>
          <div className="dialog-choices">
            <button
              type="button"
              className={`dialog-choice${session.pinned ? ' is-active' : ''}`}
              onClick={() => store.pinSession(session.id, !session.pinned)}
            >
              {session.pinned ? '已置顶' : '置顶会话'}
            </button>
            <button
              type="button"
              className={`dialog-choice${session.muted ? ' is-active' : ''}`}
              onClick={() => store.muteSession(session.id, !session.muted)}
            >
              {session.muted ? '已免打扰' : '免打扰'}
            </button>
          </div>

          {session.lastActiveAt && (
            <p className="dialog-hint">最后一条消息：{formatRelative(session.lastActiveAt)}</p>
          )}

          <p className="dialog-field-title">危险操作</p>
          <div className="dialog-choices">
            <button
              type="button"
              className="dialog-choice dialog-choice-danger"
              onClick={() => {
                if (confirming === 'clear') {
                  store.clearHistory(session.id)
                  onClose()
                } else {
                  setConfirming('clear')
                }
              }}
            >
              {confirming === 'clear' ? '真的清空？再点一次' : '清空本机记录'}
            </button>
            <button
              type="button"
              className="dialog-choice dialog-choice-danger"
              onClick={() => {
                if (confirming === 'leave') {
                  void store.leaveSession(session.id)
                  onClose()
                } else {
                  setConfirming('leave')
                }
              }}
            >
              {confirming === 'leave' ? '真的要退出？再点一次' : '退出此会话'}
            </button>
          </div>

          <div className="dialog-actions">
            <button type="button" className="dialog-button" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

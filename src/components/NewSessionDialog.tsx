import { useEffect, useState } from 'react'
import { useChatState, useChatStore } from '../store/ChatProvider'
import { nameOrNumber } from '../data/person'
import { avatarUrl } from '../assets/registry'

/**
 * 新建会话对话框。
 *
 * 外观照搬游戏原版的 `.dialog`（menu.css）：
 *   米白半透明底 + backdrop-filter 模糊 + 8px 圆角 + 投影，
 *   标题栏 32px 高、内容区 padding 12px，容器内一切文字为黑色。
 * 对应游戏里 Baker 左上角「＋」新建频道的那个弹窗。
 */
export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const store = useChatStore()
  const state = useChatState()
  const selfId = state.self.id
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'group' | 'direct'>('group')
  const [members, setMembers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  // 候选就是名册里的人，自己不进候选
  const candidates = state.roster.filter((operator) => operator.id !== selfId)

  // Esc 关掉。
  //
  // 这个弹窗是全屏里唯一**没有任何退路**的：根节点是裸的 `<div className="dialog">`，
  // 既没有 backdrop 可点、也没有关闭按钮，`Esc` 再不吃就只剩「选一个会话」
  // 这一条路 —— 而用户可能根本不想建会话，只是误点了「＋」。
  // 写法照抄 `SessionSettingsDialog`（那已经是这个仓库里弹窗处理键盘的样子）。
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

  const canSubmit = name.trim().length > 0 && (kind === 'group' ? members.length > 0 : members.length === 1)

  const submit = async () => {
    if (!canSubmit || busy) return
    setBusy(true)
    await store.createSession({
      name: name.trim(),
      kind,
      memberIds: [selfId, ...members],
    })
    setBusy(false)
    onClose()
  }

  return (
    <div className="dialog">
      <div className="dialog-title">
        <span>新建会话</span>
      </div>

      <div className="dialog-content">
        <label className="dialog-field">
          <span>会话名称</span>
          <input
            type="text"
            value={name}
            autoFocus
            placeholder="例如：帝江号值班组"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <div className="dialog-field">
          <span>类型</span>
          <div className="dialog-choices">
            <button type="button" className={kind === 'group' ? 'is-active' : ''} onClick={() => setKind('group')}>
              群聊
            </button>
            <button
              type="button"
              className={kind === 'direct' ? 'is-active' : ''}
              onClick={() => {
                setKind('direct')
                setMembers((cur) => cur.slice(0, 1))
              }}
            >
              私聊
            </button>
          </div>
        </div>

        <div className="dialog-field">
          <span>成员（已选 {members.length} 人）</span>
          <div className="dialog-members">
            {candidates.map((operator) => {
              const selected = members.includes(operator.id)
              return (
                <button
                  key={operator.id}
                  type="button"
                  className={`dialog-member${selected ? ' is-active' : ''}`}
                  onClick={() =>
                    setMembers((cur) => {
                      if (cur.includes(operator.id)) return cur.filter((id) => id !== operator.id)
                      if (kind === 'direct') return [operator.id]
                      return [...cur, operator.id]
                    })
                  }
                >
                  <img src={avatarUrl(operator.avatarKey)} alt="" />
                  <span>{nameOrNumber(operator)}</span>
                </button>
              )
            })}
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="is-primary" disabled={!canSubmit || busy} onClick={() => void submit()}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

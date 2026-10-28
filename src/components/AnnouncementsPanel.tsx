import { useEffect, useState } from 'react'
import { useChatState, useChatStore } from '../store/ChatProvider'
import { formatRelative } from '../utils/time'

/**
 * 公告面板。
 *
 * 顶栏那个「带 ! 的纸张」按钮（原版素材 icon_sns_chat_07）点开就是这个。
 *
 * ## 和 1.x 的差别：**谁都能发**
 *
 * 1.x 的公告只能由服务器管理页（`server/admin.html`）发布，客户端**只读**，
 * 理由是「免得任何一个人装了客户端就能往所有人屏幕上贴字」。那条理由在
 * 服务器架构下成立，因为服务器有个权威可以当这个门。
 *
 * P2P 里没有那个权威 —— 任何人都能往局域网上发广播，这是网络的性质，不是
 * 一个可以关掉的开关。所以这一版不再假装有门卫，改成一条能真正执行的约束：
 * **每条公告都带作者名，界面上必须显示**。不能禁止说话，就让每句话可追溯。
 *
 * 1.x 那个「下载邀请二维码」的按钮也删了 —— 它下载的是「怎么连上这台服务器」，
 * 而 P2P 里没有服务器可以邀请人连。
 */
export function AnnouncementsPanel({ onClose }: { onClose: () => void }) {
  const store = useChatStore()
  const state = useChatState()
  const [composing, setComposing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  // 打开就清红点；**面板开着的时候**又来新公告也照样清 —— 人正盯着看呢，
  // 再点个红点出来只会让人以为没消掉。所以这里故意不给依赖数组。
  useEffect(() => {
    store.clearAnnouncementUnread()
  })

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

  const list = state.announcements
  const connected = state.connection === 'connected'

  const post = async () => {
    setBusy(true)
    setNote('')
    try {
      const message = await store.postAnnouncement({ title, body })
      setNote(message)
      if (message === '发出去了。') {
        setTitle('')
        setBody('')
        setComposing(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog announcements" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>公告</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭" />
        </div>

        <div className="dialog-content">
          {list.length === 0 ? (
            <div className="announcements-empty">
              <p>{connected ? '暂无公告' : '未连接'}</p>
            </div>
          ) : (
            <div className="announcements-list">
              {list.map((item) => {
                return (
                  <article key={item.id} className="announcement">
                    <h3>{item.title}</h3>
                    <p className="announcement-meta">
                      {item.by} · {formatRelative(item.at)}
                    </p>
                    <p className="announcement-body">{item.body}</p>
                  </article>
                )
              })}
            </div>
          )}

          {/* 发公告。1.x 这里只有「下载邀请二维码」（已删）。 */}
          <div className="announcements-invite">
            {composing ? (
              <>
                <input
                  className="friends-input"
                  placeholder="标题"
                  value={title}
                  maxLength={80}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <textarea
                  className="friends-input"
                  placeholder="正文"
                  value={body}
                  maxLength={4000}
                  rows={4}
                  onChange={(event) => setBody(event.target.value)}
                />
                <div className="announcements-invite-row">
                  <button
                    type="button"
                    className="invite-button"
                    onClick={() => void post()}
                    disabled={busy || !title.trim() || !body.trim()}
                  >
                    {busy ? '正在发…' : '发布'}
                  </button>
                  <button
                    type="button"
                    className="dialog-button"
                    onClick={() => {
                      setComposing(false)
                      setNote('')
                    }}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <div className="announcements-invite-row">
                <button
                  type="button"
                  className="invite-button"
                  onClick={() => setComposing(true)}
                  disabled={!connected}
                >
                  发公告
                </button>
              </div>
            )}
            {note && <span className="dialog-hint">{note}</span>}
          </div>

          <div className="dialog-actions">
            <button type="button" className="dialog-button" onClick={onClose}>
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { useChatState, useChatStore } from '../store/ChatProvider'
import { nameOrNumber, personOf } from '../data/person'
import {
  makePairCode,
  parsePairCode,
  looksLikePairCode,
  looksLikeLegacyPairCode,
  type PairCode,
} from '../friend/code'
import { avatarUrl } from '../assets/registry'

/**
 * 加好友面板。
 *
 * 这里没有「搜索用户 → 发申请 → 等同意」那三步。核心是一条等式：
 *
 *     好友 = 我 pin 过的人 ∩ pin 过我的人
 *
 * 所以「加好友」和「关注」是同一个动作，两条好处直接落下来：
 *   - **对方离线也能加** —— pin 只是往我的集合里塞一个 id，不依赖对方在线；
 *   - **「拒绝」不需要存在** —— 对方不 pin 回来，交集就一直是空的，没有回执要发；
 *   - **重复点无副作用** —— 集合语义天然幂等。
 *
 * 交集一成立，1:1 会话就出现了 —— 所以「好友列表」其实就是会话列表里那些
 * direct 会话，不需要另起一套 UI。
 *
 * 两条入口：
 *   1. **配对码**（跨网段 / 隔着防火墙）—— 一次粘贴 = 加好友，不用改任何设置；
 *   2. **名单直选**（同一个局域网里）—— 从 roster 里点一下就行。
 *
 * 注意第二条才是主路径：**同一个局域网里根本不需要配对码** —— 组播会
 * 把所有人带到一起，roster 里直接能看到。配对码是给「看得见但连不上」
 * （跨网段、交换机开了隔离、防火墙挡了组播）准备的兜底。
 */
export function FriendPanel({ onClose }: { onClose: () => void }) {
  const store = useChatStore()
  const state = useChatState()

  const [code, setCode] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)

  /** 某个人的 1:1 会话（好友的物化结果就是它）。没有就返回 undefined。 */
  const directSessionOf = (userId: string) =>
    state.sessions.find((s) => s.kind === 'direct' && s.memberIds.includes(userId))

  /** 点一下「发消息」：开那个 1:1 会话并把面板关掉。 */
  const openChat = (userId: string) => {
    const session = directSessionOf(userId)
    if (!session) return
    void store.selectSession(session.id)
    onClose()
  }

  // 面板开着的时候又有人 pin 你，也直接算看过 —— 人正盯着这块看呢。
  // 所以这个 effect 故意不给依赖数组，每次渲染都跑一遍。
  useEffect(() => {
    store.markFollowersSeen()
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

  /** 我自己的配对码：只编「我是谁」—— P2P 里没有地址要传。 */
  const myCode = useMemo(
    () =>
      makePairCode({
        userId: state.self.id,
        name: nameOrNumber(state.self),
      }),
    [state.self.id, state.self.name],
  )

  /**
   * 粘贴配对码 → 直接加好友。
   *
   * 1.x 这里要 `saveConfig({serverUrl})` + `window.location.reload()`，
   * 因为码里带着对方的服务器地址，得先切过去。**P2P 里没有这一步**：
   * 码里只有「加谁」，而 pin 是纯本地的集合操作 —— 对方在不在线、
   * 连没连上都无所谓。所以整个流程从「解析 → 存配置 → 记记号 → 重载
   * → 重连 → 取出记号 → pin」缩成了一步。
   */
  const useCode = async () => {
    if (looksLikeLegacyPairCode(code) && !looksLikePairCode(code)) {
      setError('这是旧版的码，不能用了。让对方重新复制一串给你。')
      setNotice(null)
      return
    }
    const parsed: PairCode | null = parsePairCode(code)
    if (!parsed) {
      setError('这串码认不出来，检查是否复制全了。')
      setNotice(null)
      return
    }
    setError(null)
    const result = await store.pin(parsed.userId)
    setNotice(`${parsed.name}：${result.message}`)
    setCode('')
  }

  const add = async (userId: string) => {
    const result = await store.pin(userId)
    setNotice(result.message)
    setError(null)
  }

  const remove = async (userId: string) => {
    const message = await store.unpin(userId)
    setNotice(message)
    setError(null)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(myCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('复制失败，手动选中下面这串也行。')
    }
  }

  const candidates = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return state.roster.filter((op) => op.id !== state.self.id)
      .filter((op) =>
        keyword ? op.name.toLowerCase().includes(keyword) || op.number.includes(keyword) : true,
      )
      .slice(0, 40)
  }, [query, state.self.id, state.roster])

  const friendCount = state.friends.friends.length

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog friends" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-title">
          <span>加好友</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭" />
        </div>

        <div className="dialog-content">
          {/* ---------------------------------------------- 用配对码加（跨网段） */}
          <section className="friends-block">
            <h3>使用配对码</h3>
            {/* 输入框的 placeholder **故意不给一个看起来像真码的示例**：
                码里装的是整个身份（43 字符的 base32 用户 id，还可能带名字），
                实际长度是 `BK2-` + 17～20 组 + 4 位校验，一百来个字符。
                写成 `BK2-XXXXX-XXXXX-XXXXX-XXXX` 会让人以为要手抄 24 个字符，
                然后看着自己那一百多个字符怀疑界面坏了。 */}
            <div className="friends-row">
              <input
                className="friends-input"
                placeholder="粘贴配对码"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="dialog-button"
                onClick={() => void useCode()}
                disabled={!code.trim()}
              >
                加为好友
              </button>
            </div>
          </section>

          {/* ---------------------------------------------- 我的码 */}
          <section className="friends-block">
            <h3>我的配对码</h3>
            <p className="friends-code">{myCode}</p>
            <div className="friends-row">
              <button type="button" className="dialog-button" onClick={copy}>
                {copied ? '已复制' : '复制'}
              </button>
            </div>
          </section>

          {/* ---------------------------------------------- 谁想加你 */}
          {state.friends.followers.length > 0 && (
            <section className="friends-block friends-block-inbox">
              <h3>
                想加你的人
                <span className="friends-count">{state.friends.followers.length}</span>
              </h3>
              <ul className="friends-list">
                {state.friends.followers.map((id) => {
                  const op = personOf(state.roster, id)
                  return (
                    <li key={id} className="friends-item">
                      <span className="friends-avatar-wrap">
                        <img className="friends-avatar" src={avatarUrl(op.avatarKey)} alt="" />
                        {state.presence[id] === true && <i className="friends-online" title="在线" />}
                      </span>
                      <span className="friends-name">
                        {op.name}
                        <em>#{op.number}</em>
                      </span>
                      <button type="button" className="friends-link" onClick={() => void add(id)}>
                        加回去
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {/* ---------------------------------------------- 名单直选（同一局域网） */}
          <section className="friends-block">
            <h3>
              局域网里能看见的人
              {friendCount > 0 && <span className="friends-count">已有 {friendCount} 位好友</span>}
            </h3>
            <input
              className="friends-input"
              placeholder="搜名字或编号"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul className="friends-list">
              {candidates.map((op) => {
                const pinned = state.friends.pins.includes(op.id)
                const friend = state.friends.friends.includes(op.id)
                return (
                  <li key={op.id} className="friends-item">
                    <span className="friends-avatar-wrap">
                      <img className="friends-avatar" src={avatarUrl(op.avatarKey)} alt="" />
                      {state.presence[op.id] === true && <i className="friends-online" title="在线" />}
                    </span>
                    <span className="friends-name">
                      {op.name}
                      <em>#{op.number}</em>
                    </span>
                    {friend ? (
                      <span className="friends-item-actions">
                        <span className="friends-tag friends-tag-friend">已是好友</span>
                        <button type="button" className="friends-link" onClick={() => openChat(op.id)}>
                          发消息
                        </button>
                      </span>
                    ) : pinned ? (
                      <span className="friends-item-actions">
                        <span className="friends-tag">关注中</span>
                        <button type="button" className="friends-link" onClick={() => void remove(op.id)}>
                          取消
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="friends-link" onClick={() => void add(op.id)}>
                        加好友
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>

          {notice && <p className="friends-notice">{notice}</p>}
          {error && <p className="friends-error">{error}</p>}

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

import { useEffect, useRef, useState } from 'react'
import type { ReplyRef, UserId } from '../protocol/types'
import { personOf } from '../data/person'
import { useActiveSession, useChatState, useChatStore } from '../store/ChatProvider'
import { clearDraft, setDraft, useDraft } from '../store/drafts'
import { avatarUrl, EMOJI_KEYS, STICKER_KEYS, emojiUrl, stickerUrl } from '../assets/registry'

type Panel = 'none' | 'stickers' | 'emoji' | 'more'

/**
 * 底部输入区。
 *
 * 结构和原版一一对应（baker-dx session.rs:568-606）：
 *   #input-area
 *     ├─ #input-area-input
 *     │    ├─ textarea#input-area-input-input    浅灰胶囊输入框
 *     │    └─ button#input-area-submit           发送按钮，浮在胶囊右端
 *     ├─ button#input-area-stickers.input-area-button   表情/贴纸
 *     └─ button#input-area-more.input-area-button       更多（选中时图标转 45°）
 *
 * 原版的 Enter 直接发送、Shift+Enter 换行。
 */
export function InputArea({ replyTo, onCancelReply }: { replyTo: ReplyRef | null; onCancelReply: () => void }) {
  const store = useChatStore()
  const state = useChatState()
  const session = useActiveSession()
  const sessionId = session?.id ?? null

  // 草稿按会话存：切走时留着，切回来还在，发出去才清
  const draft = useDraft(sessionId)
  const [text, setText] = useState(draft)
  const [panel, setPanel] = useState<Panel>('none')
  const [stickerTab, setStickerTab] = useState<'game' | 'skland'>('game')
  /** 正在 @ 人的话，记下 @ 的位置和已经打出来的前缀 */
  const [mention, setMention] = useState<{ at: number; query: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 换会话时把输入框换成那个会话自己的草稿
  useEffect(() => {
    setText(draft)
    setPanel('none')
    setMention(null)
    // 只在会话变化时同步一次；draft 的变化由下面的 onChange 负责写回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus()
  }, [replyTo])

  const canSend = text.trim().length > 0 && session !== null

  const edit = (next: string) => {
    setText(next)
    if (sessionId) setDraft(sessionId, next)
  }

  const submit = () => {
    if (!canSend) return
    void store.sendText(text, replyTo ?? undefined)
    edit('')
    setMention(null)
    onCancelReply()
    setPanel('none')
  }

  /** 把 @ 选中的成员插进去。 */
  const pickMention = (userId: UserId) => {
    if (!mention) return
    const name = personOf(state.roster, userId).name
    const next = `${text.slice(0, mention.at)}@${name} ${text.slice(mention.at + mention.query.length + 1)}`
    edit(next)
    setMention(null)
    textareaRef.current?.focus()
  }

  /** 输入变化时判断光标前是不是正在打一个 @。 */
  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const match = /@([\u4e00-\u9fa5A-Za-z0-9_]*)$/.exec(before)
    setMention(match ? { at: match.index, query: match[1] } : null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && event.key === 'Escape') {
      event.preventDefault()
      setMention(null)
      return
    }
    if (mention && event.key === 'Enter' && mentionCandidates.length > 0) {
      event.preventDefault()
      pickMention(mentionCandidates[0].id)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
    if (event.key === 'Escape' && replyTo) onCancelReply()
  }

  const toggle = (next: Panel) => setPanel((cur) => (cur === next ? 'none' : next))

  const stickers = STICKER_KEYS.filter((key) =>
    stickerTab === 'skland' ? !/^sns_sticker_\d{3}$/.test(key) : /^sns_sticker_\d{3}$/.test(key),
  )

  const mentionCandidates = mention
    ? state.roster.filter((op) => op.id !== state.self.id).filter(
        (op) => !mention.query || op.name.includes(mention.query) || op.number.includes(mention.query),
      ).slice(0, 8)
    : []

  /**
   * 粘 / 拖 / 选进来的文件。
   *
   * 图片走内联（`sendImage`）—— 图片要立刻在气泡里看见，走内容寻址那条路
   * 得先等「声明同步过去 → 对端来要字节 → 字节到齐」一个来回，会先空一下。
   * 其余一律走 `sendFile`：几十兆的文件内联进消息体，日志再也瘦不下来。
   */
  const sendFiles = (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    if (file.type.startsWith('image/')) void store.sendImage(file)
    else void store.sendFile(file)
  }

  const clearDraftNow = () => {
    edit('')
    if (sessionId) clearDraft(sessionId)
    setPanel('none')
  }

  return (
    <div
      id="input-area"
      className={`flex flex-row${dragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => {
        if (!session) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!session) return
        event.preventDefault()
        setDragging(false)
        sendFiles(event.dataTransfer.files)
      }}
    >
      {dragging && <div className="drop-hint">松手就把文件发出去</div>}

      {replyTo && (
        <div className="reply-preview">
          <span className="reply-preview-label">正在引用 {replyTo.authorName}</span>
          <span className="reply-preview-text">{replyTo.excerpt}</span>
          <button type="button" onClick={onCancelReply} aria-label="取消引用">
            ×
          </button>
        </div>
      )}

      {mention && mentionCandidates.length > 0 && (
        <div className="mention-menu">
          <p className="mention-menu-title">选择要提醒的人</p>
          {mentionCandidates.map((op) => (
            <button key={op.id} type="button" onClick={() => pickMention(op.id)}>
              <img src={avatarUrl(op.avatarKey)} alt="" />
              <span>{op.name}</span>
              <i>#{op.number}</i>
            </button>
          ))}
        </div>
      )}

      {panel === 'stickers' && (
        <div id="stickers-menu-wrapper">
          <div className="stickers-tabs">
            <button
              type="button"
              className={stickerTab === 'game' ? 'is-active' : ''}
              onClick={() => setStickerTab('game')}
            >
              游戏贴纸
            </button>
            <button
              type="button"
              className={stickerTab === 'skland' ? 'is-active' : ''}
              onClick={() => setStickerTab('skland')}
            >
              社区表情
            </button>
          </div>
          <div className="stickers-menu">
            {stickers.map((key) => (
              <button
                key={key}
                type="button"
                title={key}
                onClick={() => {
                  void store.sendSticker(key)
                  setPanel('none')
                }}
              >
                <img src={stickerUrl(key)} alt={key} loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}

      {panel === 'more' && (
        <div id="more-menu-wrapper">
          <div className="more-menu">
            <button type="button" onClick={() => toggle('emoji')}>
              插入表情 / Emoji
            </button>
            <button type="button" onClick={() => toggle('stickers')}>
              发送贴纸
            </button>
            <button
              type="button"
              onClick={() => {
                fileRef.current?.click()
                setPanel('none')
              }}
            >
              发送文件
            </button>
            <button type="button" onClick={clearDraftNow}>
              清空草稿
            </button>
            <button type="button" onClick={() => setPanel('none')}>
              关闭
            </button>
          </div>
        </div>
      )}

      {panel === 'emoji' && (
        <div id="more-menu-wrapper">
          <div className="emoji-menu">
            {EMOJI_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                title={key}
                onClick={() => {
                  edit(`${text}[${key}]`)
                  textareaRef.current?.focus()
                }}
              >
                <img src={emojiUrl(key)} alt={key} loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}

      <div id="input-area-input">
        <textarea
          id="input-area-input-input"
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={session ? '发消息' : '先选一个会话'}
          disabled={!session}
          onChange={(event) => {
            const value = event.target.value
            edit(value)
            detectMention(value, event.target.selectionStart ?? value.length)
            store.notifyTyping()
          }}
          onKeyUp={(event) => detectMention(text, event.currentTarget.selectionStart ?? text.length)}
          onClick={(event) => detectMention(text, event.currentTarget.selectionStart ?? text.length)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            // 剪贴板里有文件就发文件（图片和普通文件都走这条路）；
            // 没有文件时**不拦截** —— 那是在粘贴文字，得让浏览器照常插进输入框。
            const file = Array.from(event.clipboardData.files)[0]
            if (!file) return
            event.preventDefault()
            sendFiles(event.clipboardData.files)
          }}
        />
        <button
          id="input-area-submit"
          type="button"
          className="input-area-button"
          disabled={!canSend}
          onClick={submit}
          aria-label="发送"
        />
      </div>

      <button
        id="input-area-stickers"
        type="button"
        className={`input-area-button${panel === 'stickers' ? ' input-area-stickers-selected' : ''}`}
        onClick={() => toggle('stickers')}
        aria-label="贴纸和表情"
      />

      <button
        id="input-area-more"
        type="button"
        className={`input-area-button${panel === 'more' || panel === 'emoji' ? ' input-area-more-selected' : ''}`}
        onClick={() => toggle('more')}
        aria-label="更多"
      />

      <input
        ref={fileRef}
        type="file"
        hidden
        onChange={(event) => {
          sendFiles(event.target.files)
          event.target.value = ''
        }}
      />
    </div>
  )
}

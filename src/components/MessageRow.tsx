import { useState } from 'react'
import type { Message, Operator, Reaction, ReplyRef } from '../protocol/types'
import { EMOJI_KEYS, avatarUrl, emojiUrl, imageUrl, stickerUrl } from '../assets/registry'
import { nameOrNumber } from '../data/person'
import { formatClock, formatDayDivider } from '../utils/time'
import { formatBytes } from '../utils/size'
import type { MessageRow as Row } from '../utils/grouping'

/**
 * 回应面板里放前 24 个 emoji（游戏一共 38 个，全铺开会挡住气泡）。
 * 顺序就是 sns_emoji_001..038，跟游戏里表情面板的顺序一致。
 */
const PICKER_EMOJI = EMOJI_KEYS.slice(0, 24)
const MAX_VISIBLE_REACTIONS = 4

/**
 * 一行消息：头像 + 气泡堆。
 *
 * 严格照原版 DOM 走（baker-dx src/session/view/session.rs 的 MessageRow）：
 *   div.flex.flex-row
 *     ├─ .message-row-avatar(.message-row-avatar-background)   ← 只有头像在左时才画 img
 *     ├─ .message-row-content.message-row-content-{left|right} ← 这一行的所有气泡
 *     └─ .message-row-avatar(.message-row-avatar-background)   ← 只有头像在右时才画 img
 *
 * 注意：原版消息行里 **不画发言人名字**，所以默认也看不到名字；
 * 「一行 = 一个人连发的若干条」这个分组在 utils/grouping.ts 里做。
 */
export function MessageRow({
  row,
  author,
  showNames,
  onRecall,
  onReact,
  onRetry,
  onReply,
  onOpenImage,
  onSaveFile,
  onDelete,
  onJumpTo,
}: {
  row: Row
  /** 发言人。由父级从名册里查好传进来 —— 这一层不再自己查数据。 */
  author: Operator
  showNames: boolean
  onRecall: (message: Message) => void
  onReact: (message: Message, emojiKey: string) => void
  onRetry: (message: Message) => void
  onReply: (ref: ReplyRef) => void
  onOpenImage: (src: string) => void
  onSaveFile: (message: Message) => void
  onDelete: (message: Message) => void
  onJumpTo: (messageId: string) => void
}) {
  const operator = author
  const [pickerFor, setPickerFor] = useState<string | null>(null)

  const avatarOnLeft = !row.isSelf
  // 原版就是「哪边有头像，哪边的头像格才带圆形底盘」
  const leftAvatarClass = `message-row-avatar${avatarOnLeft ? ' message-row-avatar-background' : ''}`
  const rightAvatarClass = `message-row-avatar${avatarOnLeft ? '' : ' message-row-avatar-background'}`

  return (
    <div className="message-row flex flex-row">
      <div className={leftAvatarClass}>{avatarOnLeft && <img src={avatarUrl(operator.avatarKey)} alt="" />}</div>

      <div className={`message-row-content message-row-content-${avatarOnLeft ? 'left' : 'right'}`}>
        {showNames && avatarOnLeft && (
          <span className="message-row-name">
            {operator.name}
            <i>#{operator.number}</i>
          </span>
        )}

        {row.messages.map((message) =>
          message.recalled ? (
            <div key={message.id} className="message-recalled">
              「{nameOrNumber(operator)}」撤回了一条消息
            </div>
          ) : (
            <div key={message.id} className="message-row-item" data-message-id={message.id}>
              <Bubble
                message={message}
                avatarOnLeft={avatarOnLeft}
                onOpenImage={onOpenImage}
                onSaveFile={onSaveFile}
                onJumpTo={onJumpTo}
              >
                <HoverActions
                  message={message}
                  authorName={nameOrNumber(operator)}
                  avatarOnLeft={avatarOnLeft}
                  onRecall={onRecall}
                  onReply={onReply}
                  onRetry={onRetry}
                  onDelete={onDelete}
                  onToggleReactions={() => setPickerFor((cur) => (cur === message.id ? null : message.id))}
                />
              </Bubble>

              {message.reactions && message.reactions.length > 0 && (
                <div className="message-reaction-wrapper">
                  {message.reactions.slice(0, MAX_VISIBLE_REACTIONS).map((reaction) => (
                    <ReactionChip
                      key={reaction.emojiKey}
                      reaction={reaction}
                      onPick={() => onReact(message, reaction.emojiKey)}
                    />
                  ))}
                </div>
              )}

              {pickerFor === message.id && (
                <div className="message-emoji-picker" role="group" aria-label="选择表情回应">
                  {PICKER_EMOJI.map((key) => (
                    <button
                      key={key}
                      type="button"
                      title={key}
                      onClick={() => {
                        onReact(message, key)
                        setPickerFor(null)
                      }}
                    >
                      <img src={emojiUrl(key)} alt={key} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
      </div>

      <div className={rightAvatarClass}>{!avatarOnLeft && <img src={avatarUrl(operator.avatarKey)} alt="" />}</div>
    </div>
  )
}

/**
 * 重新定义常量：`PICKER_EMOJI` 见上。
 * 输入框插入的是 `[sns_emoji_012]` 这样的文本标记（见 InputArea 的表情面板），
 * 渲染时要还原成行内表情图 —— 游戏原版也是行内贴图，不是 emoji 字符。
 */
const EMOJI_TOKEN = /\[(sns_emoji_\d{3})\]|@[\u4e00-\u9fa5A-Za-z0-9_]+/g

/** 把 `[sns_emoji_012]` 标记还原成行内表情图、把 @某人 高亮出来，其余按纯文本渲染。 */
function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(EMOJI_TOKEN)) {
    const at = match.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    if (match[1]) {
      parts.push(<img key={`e${at}`} src={emojiUrl(match[1])} alt={match[1]} />)
    } else {
      parts.push(
        <span key={`m${at}`} className="message-mention">
          {match[0]}
        </span>,
      )
    }
    last = at + match[0].length
  }
  if (!parts.length) return <>{text}</>
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/**
 * 图片消息。
 *
 * 加载失败时只退成一行占位文字——**绝不能顺手指向 onRetry**：
 * 那等于拿自己的身份把别人的图重新发一遍（曾经的 bug）。
 */
function MessageImage({ src, onOpen }: { src: string; onOpen: (src: string) => void }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <span className="message-image-broken">图片加载失败</span>
  return (
    <button type="button" className="message-image-button" onClick={() => onOpen(src)} title="点击查看大图">
      <img src={src} alt="" onError={() => setBroken(true)} />
    </button>
  )
}

function Bubble({
  message,
  avatarOnLeft,
  onOpenImage,
  onSaveFile,
  onJumpTo,
  children,
}: {
  message: Message
  avatarOnLeft: boolean
  onOpenImage: (src: string) => void
  onSaveFile: (message: Message) => void
  onJumpTo: (messageId: string) => void
  children: React.ReactNode
}) {
  // 原版进新消息时会让气泡从锚定侧横向展开
  const bubbleClass = `${avatarOnLeft ? 'message-bubble-others' : 'message-bubble-self'} ${
    avatarOnLeft ? 'message-bubble-animate-left' : 'message-bubble-animate-right'
  }`

  // 图片和贴纸的九宫格边框必须去掉：原版是把这个气泡类**直接挂在 image / sticker 元素上**
  // （`.message-bubble-image{border-image-source:none;...;padding:0}`），再靠
  // `.message-bubble-wrapper:has(...)` 去改外层宽度。如果像文本那样再套一层，
  // 外层就会保留 50px 的九宫格边框和内边距，图片被挤成一条。
  const common = {
    image: (
      <span className={`${bubbleClass} message-bubble-image`}>
        {/* 名册里给的是素材 key（如 sns_002_settlement），不是 URL，必须过一遍注册表 */}
        <MessageImage src={imageUrl(message.imageUrl ?? '')} onOpen={onOpenImage} />
      </span>
    ),
    sticker: (
      <div className={`${bubbleClass} message-bubble-sticker`}>
        <img src={stickerUrl(message.stickerKey ?? '')} alt="" />
      </div>
    ),
    file: (
      <div className={`${bubbleClass} message-bubble-text`}>
        <div>
          <MessageFile message={message} onSave={onSaveFile} />
        </div>
      </div>
    ),
    text: (
      <div className={bubbleClass}>
        <div>
          {message.replyTo && (
            <button
              type="button"
              className="message-quote"
              onClick={() => onJumpTo(message.replyTo!.messageId)}
              title="跳到这条消息"
            >
              <span className="message-quote-author">{message.replyTo.authorName}</span>
              <span className="message-quote-text">{message.replyTo.excerpt}</span>
            </button>
          )}
          {message.kind === 'text' ? (
            <p className="message-bubble-text">
              <RichText text={message.text ?? ''} />
            </p>
          ) : (
            <p className="message-bubble-text">
              <RichText text={message.systemText ?? ''} />
            </p>
          )}
        </div>
      </div>
    ),
  }

  return (
    <div className="message-bubble-wrapper">
      {message.kind === 'image'
        ? common.image
        : message.kind === 'sticker'
          ? common.sticker
          : message.kind === 'file'
            ? common.file
            : common.text}
      {children}
    </div>
  )
}

/**
 * 文件消息。
 *
 * 字节**不进消息体**，所以「文件」和「字节」是两条路到的：
 * `file` 事件带着文件名和大小，先到；字节随后按 id 去要。
 * 于是这里有两种状态 —— 声明到了字节还没到（占位）、字节到了（可保存）。
 *
 * 占位态**不画成可点的按钮**：点了没反应比点不动更让人困惑。
 * 自己的文件也一样：字节是本地的，但要等 `onBlob` 回环才拿得到 URL，
 * 那一下很短，但不特殊照顾就会闪一个「等待传输中」。
 */
function MessageFile({ message, onSave }: { message: Message; onSave: (message: Message) => void }) {
  const ready = Boolean(message.fileUrl)
  const size = formatBytes(message.fileSize)
  return (
    <button
      type="button"
      className={`message-file${ready ? '' : ' is-pending'}`}
      disabled={!ready}
      onClick={() => onSave(message)}
      title={ready ? '保存到本机' : '字节还没传到'}
    >
      <span className="message-file-icon" aria-hidden="true" />
      <span className="message-file-meta">
        <span className="message-file-name">{message.fileName || '未命名文件'}</span>
        <span className="message-file-sub">{ready ? size || '点击保存' : '传输中…'}</span>
      </span>
    </button>
  )
}

/**
 * 悬浮操作条。
 *
 * 时间戳也放在这里：游戏原版的消息行里既没有名字也没有时间，只有悬浮时的 .actions。
 * 把时间塞进同一个条里，静止画面仍然和游戏一致，但鼠标一放上去信息就都在了。
 */
function HoverActions({
  message,
  authorName,
  avatarOnLeft,
  onRecall,
  onReply,
  onRetry,
  onDelete,
  onToggleReactions,
}: {
  message: Message
  authorName: string
  avatarOnLeft: boolean
  onRecall: (message: Message) => void
  onReply: (ref: ReplyRef) => void
  onRetry: (message: Message) => void
  onDelete: (message: Message) => void
  onToggleReactions: () => void
}) {
  const [copied, setCopied] = useState(false)

  const isText = message.kind === 'text' || message.kind === 'system'
  const bodyText = message.kind === 'text' ? (message.text ?? '') : (message.systemText ?? '')
  const quoteExcerpt = isText
    ? bodyText
    : message.kind === 'sticker'
      ? '[贴纸]'
      : message.kind === 'file'
        ? `[文件] ${message.fileName ?? ''}`.trim()
        : '[图片]'

  const copy = async () => {
    // 表情标记是给人看的图，复制时换成可读的中文占位，别让人粘出一串 [sns_emoji_007]
    const plain = bodyText.replace(/\[sns_emoji_(\d{3})\]/g, '[$1]')
    try {
      await navigator.clipboard.writeText(plain)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // 没有剪贴板权限（http 下常见）就不提示，用户自己会重试
    }
  }

  return (
    <div className={`actions${avatarOnLeft ? ' actions-left' : ' actions-right'}`}>
      <span className="message-time">{formatClock(message.sentAt)}</span>

      {message.pending && <span className="message-state">发送中…</span>}
      {message.failed && <span className="message-state message-state-failed">发送失败</span>}
      {/*
        重发**只对能重新发出去的消息开放**。文件的字节不在消息体里，
        这条记录里只有文件名和大小 —— 重发会造出一条指向不存在字节的
        空声明，收件人永远等不到东西，而两边都不报错。
      */}
      {message.failed && message.kind !== 'file' && (
        <button type="button" onClick={() => onRetry(message)}>
          重发
        </button>
      )}

      {isText && bodyText && (
        <button type="button" onClick={() => void copy()}>
          {copied ? '已复制' : '复制'}
        </button>
      )}

      <button type="button" onClick={onToggleReactions}>
        回应
      </button>
      <button
        type="button"
        onClick={() =>
          onReply({
            messageId: message.id,
            authorName,
            excerpt: quoteExcerpt.slice(0, 40),
          })
        }
      >
        引用
      </button>

      {/* 撤回只有自己发的能撤（avatarOnLeft === false 就是自己发的） */}
      {!avatarOnLeft && !message.pending && (
        <button type="button" onClick={() => onRecall(message)}>
          撤回
        </button>
      )}
      <button type="button" onClick={() => onDelete(message)} title="从本机列表去掉">
        删掉
      </button>
    </div>
  )
}

/** 单个表情回应（原版 .message-reaction，图标 + 人数）。 */
function ReactionChip({ reaction, onPick }: { reaction: Reaction; onPick: () => void }) {
  return (
    <button
      type="button"
      className={`message-reaction${reaction.userIds.length > 0 ? ' has-votes' : ''}`}
      onClick={onPick}
      title={`${reaction.userIds.length} 人回应了 ${reaction.emojiKey}`}
    >
      <img src={emojiUrl(reaction.emojiKey)} alt={reaction.emojiKey} />
      <span>{reaction.userIds.length}</span>
    </button>
  )
}

/** 日期分隔线（原版 .state-with-hl：两侧 3px 短线 + 中间灰字）。 */
export function DayDivider({ at }: { at: number }) {
  return (
    <div className="state-with-hl">
      <span />
      <span>{formatDayDivider(at)}</span>
      <span />
    </div>
  )
}

/** 正在输入提示（原版 .state：居中灰字）。 */
export function TypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return null
  const text =
    names.length === 1 ? `${names[0]} 正在输入…` : `${names.slice(0, 2).join('、')}等 ${names.length} 人正在输入…`
  return (
    <div className="state">
      <span>{text}</span>
    </div>
  )
}

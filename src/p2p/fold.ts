/**
 * 折叠 —— 把一堆事件变成「现在的样子」。
 *
 *     state = fold(所有已验事件)
 *
 * 每个节点的状态都是**算出来的**，不是别人发过来的。没有「服务器状态」
 * 这个东西了，所以也不存在「我这儿显示的和别人不一样该怎么对齐」——
 * 只要两个人的事件集合最终相同，fold 出来的状态就逐字节相同。
 *
 * ## 确定性是硬要求
 *
 * 上面那句话只有在 fold 本身**确定性**的时候才成立，而这件事比它看起来
 * 难做。最常见的破坏方式是无意识地依赖「事件到达顺序」：
 *
 *     if (!sessions.has(id)) sessions.set(id, makeSession(body))   // ← 错
 *
 * 「先到的赢」在两个人那里会给出不同的赢家（网速不同），于是同一个会话
 * 在两个节点上名字不一样，而且谁都不觉得自己的显示是错的。
 *
 * 正确的写法是给「冲突时谁赢」一个**双方都能独立算出来**的判据：
 * 比 `(ts, id)`，小者赢。`id` 是内容哈希，`ts` 是 HLC —— 都不依赖到达顺序。
 * 下面每个「先到先得」的地方都走 `winsOver()`，不要改成本地判断。
 *
 * ## 折叠不做的事
 *
 * - **不解密**。`msg` 的正文是密文，解密要密钥，而密钥的流转在
 *   `crypto/session.ts` 那一层。这里只管「谁在什么时候发了一条密文」。
 * - **不判定内容是否得体**。这里只判定**结构上是否被允许**：
 *   作者在不在会话里、这个 kind 能不能由他发。像「同一条消息能不能被撤回
 *   两次」这种是业务规则，不在这里。
 * - **不碰网络**。纯函数，同样的输入永远同样的输出 —— 所以它能被
 *   直接拿来做自测（喂两组顺序相反的事件，断言结果相同）。
 */

import { fromB64Url, group, toBase32 } from '../crypto/core'
import type { ReplyRef } from '../protocol/types'
import type { P2pEvent, UserId } from './event'
import { tsToMillis } from './hlc'

// 引用条和 @ 列表都来自事件体（别人填的），所以在搬进状态之前先截断。
// 不是「怕不好看」：这些字段会进内存、进 localStorage、进每一帧同步，
// 一个填了 100 MB 正文的引用条能让整个节点卡住。
const MAX_REPLY_AUTHOR_CHARS = 80
const MAX_REPLY_EXCERPT_CHARS = 200
const MAX_MENTIONS = 64

// ---------------------------------------------------------------- 状态

/** 一个人的公开形象。名字和头像随时会变，`id` 不会。 */
export interface Person {
  id: UserId
  /** 给人看的 8 位短码。从 `id` 派生，只用于显示 —— 绝不是身份。 */
  number: string
  name: string
  avatarKey: string
  ed: string
  x: string
  isSelf: boolean
  /** 产生这个名字/头像的那条 profile 事件的 `(ts, id)` —— 冲突判据。 */
  ts: number
  eventId: string
}

export type P2pMessageKind = 'text' | 'image' | 'sticker' | 'file' | 'system'

export interface P2pMessage {
  id: string
  sessionId: string
  authorId: UserId
  kind: P2pMessageKind
  /** 解密后的正文。fold 填不了它 —— 由解密层在渲染前补上。 */
  text?: string
  /** 端到端加密的信封（JSON 字符串）。 */
  cipher?: string
  cipherVersion?: number
  cipherSeq?: number
  /** `kind==='image'` 时的文件 id（内容按需拉）。 */
  fileId?: string
  /** 文件名，给文件气泡显示、给保存对话框当默认值。 */
  fileName?: string
  /** MIME，尽量猜；猜不出就空串，界面按扩展名兜底。 */
  fileMime?: string
  /** 字节数。界面显示「2.3 MB」，也用来决定要不要提示「文件很大」。 */
  fileSize?: number
  /**
   * 引用条：这条消息在回哪一条。
   *
   * 折叠器**必须**把它搬进来 —— 摘要（`authorName` / `excerpt`）是发送时
   * 一起写进事件体的，不搬的话界面拿不到，引用条只在本地乐观消息上闪一下，
   * 等 `message:ack` 一到就被折叠结果整个替换掉、当场消失，对端则永远看不到。
   */
  replyTo?: ReplyRef
  /** 被 @ 到的人。同样是随事件体走，不搬就丢。 */
  mentions?: UserId[]
  /** 事件自己的 `ts` —— 排序依据，不是 `Date.now()`。 */
  sentAt: number
  recalled: boolean
  /** emojiKey → 点过的人。用 Set 而不是数组：同一个人点两次只有一个效果。 */
  reactions: Map<string, Set<UserId>>
}

export interface P2pSession {
  id: string
  name: string
  kind: 'group' | 'direct'
  memberIds: UserId[]
  avatarKey: string
  /** 定义这条会话的事件 `(ts, id)` —— 冲突时用来判谁的定义赢。 */
  ts: number
  eventId: string
}

export interface Announcement {
  id: string
  title: string
  body: string
  by: UserId
  at: number
  eventId: string
}

export interface P2pState {
  /** 我自己的 id。没有它就没法判断「这条是不是我发的」。 */
  self: UserId
  people: Map<UserId, Person>
  sessions: Map<string, P2pSession>
  messages: Map<string, P2pMessage>
  /** 消息 id，按 `(sentAt, id)` 升序。渲染直接用它。 */
  order: string[]
  /** 我 pin 过谁（单向）。好友 = 双向交集，在 `friends()` 里算。 */
  pins: Set<UserId>
  /** 别人 pin 了我而我还没回 —— 「谁想加你」。 */
  followers: Set<UserId>
  announcements: Map<string, Announcement>
}

/** 空状态。`self` 必须传 —— 见下面 `foldOnce` 里对「我发的事件」的处理。 */
export function emptyState(self: UserId): P2pState {
  return {
    self,
    people: new Map(),
    sessions: new Map(),
    messages: new Map(),
    order: [],
    pins: new Set(),
    followers: new Set(),
    announcements: new Map(),
  }
}

// ---------------------------------------------------------------- 入口

/**
 * 折叠的顺序：**按依赖，不按到达**。
 *
 * ## 为什么必须这样
 *
 * 有些事件要引用另一条事件建立起来的东西：
 *
 *     msg    引用 session（不知道会话就不能确定作者有没有资格发言）
 *     react  引用 msg
 *     recall 引用 msg
 *
 * 如果按「谁先到」处理，就会出现这种结果：
 *
 *     [m1, 群定义]  →  m1 被丢掉（还不知道群存在）
 *     [群定义, m1]  →  m1 出现
 *
 * 同一组事件，两个人因为网速不同看到的东西就不一样 —— **而且两边都不报错**。
 * 这正是 `fold` 唯一必须守住的不变量（`state = fold(集合)`，与顺序无关）被
 * 打破的地方，也是最难在网上查出来的那种差异。
 *
 * 所以先按 `phaseOf` 分档，档内再按原顺序。同档内的事件彼此不引用，
 * 于是「档内顺序」不影响结果。
 *
 * 新增 kind 时**必须**在这里给它一个档位：忘了的话它会落到最后一档，
 * 而「最后一档」意味着它引用的东西都已经建好了 —— 对大多数 kind
 * 这是安全的一侧，所以忘了也不会静默出错，只是白等一趟。
 */
const PHASE: Record<string, number> = {
  profile: 0, // 身份：谁是谁
  session: 1, // 容器：有哪些会话、谁是成员
  msg: 2, // 内容：需要会话先存在
  react: 3, // 修改：需要消息先存在
  recall: 3,
}

/** 没登记过的 kind 按最后一档处理（见上面的说明）。 */
function phaseOf(kind: string): number {
  return PHASE[kind] ?? 3
}

/**
 * 从头折叠。**不修改** `state` —— 返回一份新的。
 *
 * 为什么每次都重建而不是增量更新：事件总量在「一个局域网里几十个人聊天」
 * 这个量级（几千到几万条），全量折叠是毫秒级；而增量更新的正确性要维护
 * 一堆「这条被撤回了吗 / 我处理过它吗」的旁路状态，那才是 bug 的温床。
 *
 * 真到了需要优化的量级，正确的做法是**缓存折叠结果**（按 `log.size()`
 * 做记忆化），而不是把它改成增量 —— 增量会同时失去「同一个函数、同样的
 * 输出」这个能让自测断言顺序无关的性质。
 */
export function fold(events: readonly P2pEvent[], self: UserId): P2pState {
  const state = emptyState(self)
  // 四个档位各扫一遍。四趟而不是先分组再排：分组要额外分配数组，
  // 而这里每趟都只是「跳过大半」，对缓存反而更友好。
  for (let phase = 0; phase <= 3; phase += 1) {
    for (const event of events) {
      if (phaseOf(event.kind) === phase) foldOnce(state, event)
    }
  }
  return state
}

/**
 * 把一条事件并入状态。导出是为了让「折叠」和「排序」能分开测。
 *
 * 逐 kind 处理，每个分支都只做一件事，并且**必须**在动状态之前做完
 * 所有校验 —— 校验里任何一条不满足都直接 `return`，不留半成品。
 */
export function foldOnce(state: P2pState, event: P2pEvent): void {
  switch (event.kind) {
    case 'profile':
      return foldProfile(state, event)
    case 'session':
      return foldSession(state, event)
    case 'pin':
      return foldPin(state, event)
    case 'msg':
      return foldMessage(state, event)
    case 'recall':
      return foldRecall(state, event)
    case 'react':
      return foldReact(state, event)
    case 'announce':
      return foldAnnounce(state, event)
    case 'file':
      return foldFile(state, event)
    default:
      // 不认识的 kind：**故意什么都不做**，但也不报错。
      // 局域网里各人的版本不会永远一致；旧版本遇到新版本发的事件时，
      // 正确行为是「不认识就不显示」，而不是把整条日志判为损坏。
      return
  }
}

// ---------------------------------------------------------------- 各 kind

function foldProfile(state: P2pState, event: P2pEvent): void {
  const body = asRecord(event.body)
  if (!body) return
  const ed = asString(body.ed)
  const x = asString(body.x)
  if (!ed || !x) return

  const name = asString(body.name) ?? ''
  const avatarKey = asString(body.avatarKey) ?? ''

  // 同一个人的 profile 会随着他改名字/换头像不断产生新事件。
  // 「最新的赢」—— 但必须是双方算出同一个「最新」，所以比 (ts, id)。
  const existing = state.people.get(event.author)
  if (existing && !winsOver(event, { ts: existing.ts, id: existing.eventId })) return

  state.people.set(event.author, {
    id: event.author,
    number: shortId(event.author),
    name,
    avatarKey,
    ed,
    x,
    isSelf: event.author === state.self,
    ts: event.ts,
    eventId: event.id,
  })
}

function foldSession(state: P2pState, event: P2pEvent): void {
  const body = asRecord(event.body)
  if (!body) return
  const id = asString(body.id)
  if (!id) return
  const members = asStringArray(body.memberIds)
  if (!members) return

  const existing = state.sessions.get(id)

  // 「改成员」这件事的准入，分**建**和**改**两种情况。原来只有一条规则
  // （作者必须在新成员列表里），而它把「退出」整个挡掉了（报告 M9）：
  // 退出事件发的正是「不含作者自己」的那份成员列表，于是每台设备都把它丢掉，
  // 会话重启后又冒出来，界面上的「退出」从头到尾只是本地过滤。
  //
  // 建会话：作者必须在自己建的会话里。否则任何人都能凭空造一个
  //   「只有别人、没有自己」的会话，把不认识的人硬塞进某人的列表。
  // 改会话：作者必须**现在**是成员。「现在」而不是「新的列表里」——
  //   自己把自己去掉（也就是退出）正是这一步要做的事，用新列表判定等于
  //   要求「退出的人必须还在成员里」，自相矛盾。
  //   注意这**不**限制动别人：成员列表本来就由成员共同维护（拉人进群就是
  //   改这份列表），这次只把「退出」这条正常路径放回来，不动那套语义。
  if (!existing) {
    if (!members.includes(event.author)) return
  } else if (!existing.memberIds.includes(event.author)) {
    return // 不是（或不再是）成员，无权改成员列表
  }

  if (existing && !winsOver(event, { ts: existing.ts, id: existing.eventId })) return

  const kindBody = asString(body.kind)
  state.sessions.set(id, {
    id,
    name: asString(body.name) ?? '',
    kind: kindBody === 'direct' ? 'direct' : 'group',
    // 去重 + 排序。
    //
    // 排序不是装饰：`memberIds` 会参与「这条消息我该不该收」的判断，
    // 也会显示在成员列表里。两次 fold 出来顺序不同的话，两个人的成员
    // 列表看起来就不一样，而那种差异极难归因。
    //
    // ⚠ 这里**不能**再把 `event.author` 塞回去（原来是
    // `new Set([...members, event.author])`）。作者得在列表里这件事已经由上面的
    // 准入规则保证了 —— 建会话时强制、改会话时只要求「改之前是成员」。
    // 两处都做的话，退出事件会被就地改写成「还在成员里」，白退。
    memberIds: [...new Set(members)].sort(),
    avatarKey: asString(body.avatarKey) ?? '',
    ts: event.ts,
    eventId: event.id,
  })
}

function foldPin(state: P2pState, event: P2pEvent): void {
  const body = asRecord(event.body)
  if (!body) return
  const who = asString(body.who) ?? event.author

  if (who === state.self) {
    // 有人 pin 了我 —— 进 followers。单向集合，没有「同意/拒绝」。
    if (event.author !== state.self) state.followers.add(event.author)
    return
  }
  if (event.author === state.self) {
    // 我 pin 了谁。永远只认**我自己**签的 pin 事件 ——
    // 否则别人可以签一条 `{who: 张三}` 冒充我 pin 了张三，
    // 而好友是双向交集，这一条就足以把张三变成我的「好友」。
    state.pins.add(who)
  }
  // 别人 pin 别人：与我无关，忽略（但事件本身照常留在日志里）。
}

function foldMessage(state: P2pState, event: P2pEvent): void {
  const body = asRecord(event.body)
  if (!body) return
  const sessionId = asString(body.sessionId)
  if (!sessionId) return

  const session = state.sessions.get(sessionId)
  if (!session) return // 会话定义还没到。事件留在日志里，下一轮折叠会处理。
  if (!session.memberIds.includes(event.author)) return // 不是成员，不许发言

  if (state.messages.has(event.id)) return

  const kind = asString(body.kind)
  const message: P2pMessage = {
    id: event.id,
    sessionId,
    authorId: event.author,
    kind:
      kind === 'image' || kind === 'sticker' || kind === 'system' ? kind : 'text',
    // 明文正文。**加密的消息这里就是 undefined**（`body.text` 本来就空），
    // 解密层会在渲染前从 `cipher` 里把它补出来。
    //
    // 之前这里漏了它，后果不是「显示得难看」而是「每一条明文消息都是空的」 ——
    // 折叠器老老实实只搬了密文字段，明文没人接。明文和密文不是两条路径，
    // 是同一个字段的两个来源，所以它必须在这里落地。
    text: asString(body.text),
    cipher: asString(body.cipher),
    cipherVersion: asNumber(body.cipherVersion),
    cipherSeq: asNumber(body.cipherSeq),
    fileId: asString(body.fileId),
    fileName: asString(body.fileName),
    fileMime: asString(body.fileMime),
    fileSize: asNumber(body.fileSize),
    // 引用条和 @ 列表曾经在这里被整条丢掉：`send()` 老老实实把它们写进
    // 了事件体（`local.ts` 的 `publish` 那一段），折叠器却一个字都没搬。
    // 症状是引用条**只在本地乐观消息上闪一下** —— `message:ack` 一到，
    // `reconcileOptimistic` 用折叠结果整个替换掉本地那条，引用条当场消失，
    // 对端则从头到尾没显示过。发送方看到的是「我引用了」→ 一秒后「没了」，
    // 而协议里字段一直在，所以谁都不觉得是丢包。
    replyTo: asReplyRef(body.replyTo),
    mentions: asMentions(body.mentions),
    // `event.ts` 是**编码过的 HLC**（毫秒 × 1000 + 序号），而 `Message.sentAt`
    // 的契约是「毫秒时间戳」（见 `protocol/types.ts`）。这里是唯一的换算点，
    // 漏掉一次就会让界面上显示公元 58761 年 —— 而且日期分隔线、5 分钟分组、
    // 会话列表时间全都跟着一起错，且**不会报任何错**。
    // 用 `tsToMillis`（保留小数）而不是 `physicalMs`（取整）：取整会把同一
    // 毫秒里的两条消息压成同一个时间戳，先后就只能靠 id 兜底，而这个顺序
    // 和发送顺序无关。
    sentAt: tsToMillis(event.ts),
    recalled: false,
    reactions: new Map(),
  }
  state.messages.set(message.id, message)
  insertMessageSorted(state, message)
}

function foldRecall(state: P2pState, event: P2pEvent): void {
  const body = asRecord(event.body)
  if (!body) return
  const messageId = asString(body.messageId)
  if (!messageId) return

  const message = state.messages.get(messageId)
  if (!message) return
  // 只有作者本人能撤回自己的消息。
  //
  // 群主/管理员的「撤回他人消息」在这里**故意没有**：P2P 里没有服务器
  // 来裁定谁是管理员，而任何「谁可以先声称自己是管理员」的规则，
  // 最后都会退化成一个需要有人拍板的问题 —— 那正是我们删掉的东西。
  if (message.authorId !== event.author) return

  message.recalled = true
}

function foldReact(state: P2pState, event: P2pEvent): void {
  const body = asRecord(event.body)
  if (!body) return
  const messageId = asString(body.messageId)
  const emojiKey = asString(body.emojiKey)
  if (!messageId || !emojiKey) return

  const message = state.messages.get(messageId)
  if (!message) return
  const session = state.sessions.get(message.sessionId)
  if (!session?.memberIds.includes(event.author)) return

  // 同一个人对同一个 emoji 点两次 = 取消。这是**幂等**的：
  // 「点两次」和「两条 react 事件」结果一样，所以重传不会让计数漂移。
  let byEmoji = message.reactions.get(emojiKey)
  if (!byEmoji) {
    byEmoji = new Set()
    message.reactions.set(emojiKey, byEmoji)
  }
  if (byEmoji.has(event.author)) byEmoji.delete(event.author)
  else byEmoji.add(event.author)
  if (byEmoji.size === 0) message.reactions.delete(emojiKey)
}

/**
 * 一个文件。
 *
 * 它和 `msg` 是**两个 kind**，虽然两者都会变成一条消息：`msg` 承载的是
 * 文本（密文里可以什么都没有），而 `file` 承载的是一坨**内容寻址的字节**，
 * 那坨字节不在日志里、按需向对端要（见 `node.ts` 的 `requestMissingBlobs`）。
 * 合成一个 kind 就得在 body 里加一个「这是文件还是文字」的开关，而
 * 两种东西的生命周期（一个随日志永久同步、一个只同步声明）本来就不一样。
 *
 * 校验和 `msg` 一样：不是会话成员不许发，同一 id 不重复收。
 */
function foldFile(state: P2pState, event: P2pEvent): void {
  const body = asRecord(event.body)
  if (!body) return
  const sessionId = asString(body.sessionId)
  const fileId = asString(body.fileId)
  if (!sessionId || !fileId) return

  const session = state.sessions.get(sessionId)
  if (!session) return
  if (!session.memberIds.includes(event.author)) return
  if (state.messages.has(event.id)) return

  const mime = asString(body.mime) ?? ''
  const message: P2pMessage = {
    id: event.id,
    sessionId,
    authorId: event.author,
    // 能当图片显示的就走图片气泡（内联预览），其余走文件气泡。
    kind: mime.startsWith('image/') ? 'image' : 'file',
    fileId,
    fileName: asString(body.name) ?? '',
    fileMime: mime,
    fileSize: asNumber(body.size),
    // 同 `foldMessage`：HLC 编码值 → 毫秒。
    sentAt: tsToMillis(event.ts),
    recalled: false,
    reactions: new Map(),
  }
  state.messages.set(message.id, message)
  insertMessageSorted(state, message)
}

function foldAnnounce(state: P2pState, event: P2pEvent): void {
  const body = asRecord(event.body)
  if (!body) return
  const id = asString(body.id) ?? event.id
  const existing = state.announcements.get(id)
  if (existing && !winsOver(event, { ts: existing.at, id: existing.eventId })) return
  state.announcements.set(id, {
    id,
    title: asString(body.title) ?? '',
    body: asString(body.body) ?? '',
    by: event.author,
    at: event.ts,
    eventId: event.id,
  })
}

// ---------------------------------------------------------------- 派生

/**
 * 好友 = 我 pin 的 ∩ pin 我的。
 *
 * 这套「只有单向集合、没有状态机」的语义是 v1 就定下来的，值得保留：
 * 加好友和关注走同一条代码路径，离线也能加，重复点无副作用，
 * 「拒绝」就是什么都不做 —— 不需要任何回执，也不会有人收到「你被拒绝了」。
 */
export function friends(state: P2pState): UserId[] {
  return [...state.pins].filter((id) => state.followers.has(id)).sort()
}

/** 某个会话的消息，按时间升序。 */
export function messagesOf(state: P2pState, sessionId: string): P2pMessage[] {
  const out: P2pMessage[] = []
  for (const id of state.order) {
    const message = state.messages.get(id)
    if (message?.sessionId === sessionId) out.push(message)
  }
  return out
}

/** 会话列表，最近有消息的排前面。 */
export function sessionList(state: P2pState): (P2pSession & { lastAt: number })[] {
  const lastAt = new Map<string, number>()
  for (const message of state.messages.values()) {
    const previous = lastAt.get(message.sessionId) ?? 0
    if (message.sentAt > previous) lastAt.set(message.sessionId, message.sentAt)
  }
  return [...state.sessions.values()]
    .map((s) => ({ ...s, lastAt: lastAt.get(s.id) ?? s.ts }))
    .sort((a, b) => (b.lastAt !== a.lastAt ? b.lastAt - a.lastAt : a.id < b.id ? -1 : 1))
}

/**
 * 给人看的 8 位短码。
 *
 * **派生自 `id`，不是 `id` 的一部分** —— 这一点是安全和易用性的分界线：
 * 短码只有 40 位，作为标识符可被撞（见 `event.ts` 里 `identityOf` 的说明），
 * 但作为「念出来核对一下」的显示值完全够用。
 */
export function shortId(author: UserId): string {
  try {
    const bytes = fromB64Url(author)
    // 长度检查不是多余的：`Buffer.from(x,'base64')` 在 Node 里**不校验**输入，
    // 一串非 base64 字符会被安静地解成空数组（浏览器那边的 `atob` 反而会抛）。
    // 少了这一句，坏 id 会得到空短码 `''`，界面上就是一片空白 ——
    // 比显示 `????????` 难查得多（空白看起来像「还没加载」）。
    if (bytes.length < 10) return '????????'
    return group(toBase32(bytes.subarray(0, 10)), 4).replace(/-/g, '').slice(0, 8)
  } catch {
    return '????????'
  }
}

// ---------------------------------------------------------------- 内部

/**
 * `candidate` 是不是应该盖掉 `current`。
 *
 * 唯一的冲突判据是 `(ts, id)`：双方各自都能算，结果相同。
 * 千万不要改成「比较谁先到」或「比较谁的内容更长」之类 —— 那些
 * 都依赖本地状态，会让两个人的显示分叉。
 */
function winsOver(candidate: P2pEvent, current: { ts: number; id: string }): boolean {
  if (candidate.ts !== current.ts) return candidate.ts > current.ts
  // ts 相同（同一毫秒内跨机器）时用 id 打破平局，保证全序。
  return candidate.id > current.id
}

function insertMessageSorted(state: P2pState, message: P2pMessage): void {
  let lo = 0
  let hi = state.order.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const other = state.messages.get(state.order[mid])!
    const before =
      other.sentAt < message.sentAt ||
      (other.sentAt === message.sentAt && other.id < message.id)
    if (before) lo = mid + 1
    else hi = mid
  }
  state.order.splice(lo, 0, message.id)
}

// —— 从 `unknown` 里安全取值。
//
// 事件的 `body` 是**网络来的**，类型上只能是 `unknown`。这里每个函数
// 都返回 `undefined` 而不是抛错：一条字段畸形的坏事件不该让整个折叠
// 中断 —— 那会让界面上「看不到任何消息」，而真正的原因只是某人发了一条
// 少了个字段的 profile。

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every((v) => typeof v === 'string')) return undefined
  return value as string[]
}

/**
 * 引用摘要。三个字段齐、都是字符串才算数 —— 半截的引用条不如不画。
 *
 * `excerpt` 是**发送方**填的自由文本，而且会被原样搬进每一条引用它的消息，
 * 一路进内存、进 localStorage、进每帧同步。所以这里截断，不信长度。
 */
function asReplyRef(value: unknown): ReplyRef | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const messageId = asString(record.messageId)
  const authorName = asString(record.authorName)
  const excerpt = asString(record.excerpt)
  if (!messageId || authorName === undefined || excerpt === undefined) return undefined
  return {
    messageId,
    authorName: authorName.slice(0, MAX_REPLY_AUTHOR_CHARS),
    excerpt: excerpt.slice(0, MAX_REPLY_EXCERPT_CHARS),
  }
}

/** 被 @ 的人。空数组当没有 —— 界面上「@了 0 个人」和「没 @」是同一种样子。 */
function asMentions(value: unknown): string[] | undefined {
  const list = asStringArray(value)
  if (!list || list.length === 0) return undefined
  return list.length > MAX_MENTIONS ? list.slice(0, MAX_MENTIONS) : list
}

/**
 * Baker 界面层的数据契约
 *
 * 这里定义的是「界面组件」与「传输层」之间的形状 —— 名册、会话、消息、
 * 公告、事件名。**不涉及网络**：具体是 TCP 还是别的什么、路由怎么走，
 * 都在 `src/p2p/` 与 `src/transport/` 里，界面这一层不需要知道。
 *
 * 唯一的实现是 `src/transport/local.ts` 的 `P2pTransport`（纯局域网 P2P）。
 * 1.x 的 `src/transport/websocket.ts` 与 `server/src/` 已经删除并归档到
 * `E:\\dshdocument\\baker-archive\\v1-server-client-2026-10-16\\` ——
 * 本文件里提到「服务器」的注释都是那个时代的事，读到时候记住它已经没了。
 */

export type UserId = string
export type SessionId = string
export type MessageId = string

/**
 * 聊天里的一个人（= 名册里认过的某个身份）。
 *
 * 名字和头像都是**给别人看的**，随时能改、谁都能重名；`number` 是认人的依据。
 * 注意这个对象是**名册快照里的一行**，不是「账号」—— 账号是设备上那把密钥。
 */
export interface Operator {
  id: UserId
  /**
   * 显示名，例如「李织烟」。
   *
   * 没设过就是**空串**：名字由本人填，没人替别人编。界面上绝大多数地方是「名字 +
   * `#编号`」并排显示的，名字为空时自然只剩编号；只有名字的位置（撤回提示、
   * 引用预览）用 `src/data/person.ts` 的 `nameOrNumber()` 自己退回编号。
   */
  name: string
  /**
   * 编号 —— 公钥指纹的短哈希，8 个 Crockford 字符（不含 I/L/O/U，免得念错），
   * 形如 `7K3M9QXA`。双方都能从公钥独立算出来，名册里不存映射，所以不会出现
   * 「库里存的编号和实际公钥对不上」。少一把公钥（只有 ed 没有 x）时是 `????`，
   * 界面上照样显示 —— 宁可显示问号，也不编一个假的。
   */
  number: string
  /** 头像：内置相册的素材键，或上传后压出来的 `data:` URL。见 `src/data/avatars.ts` */
  avatarKey: string
  /** 是不是当前登录的这个人 */
  isSelf?: boolean
  isAdmin?: boolean
  /** 在线状态，由对端名册告知 */
  online?: boolean
  /**
   * Ed25519 公钥（base64）。用来验证这个人发的登录签名，
   * 也是身份指纹的一半。
   */
  ed?: string
  /**
   * X25519 公钥（base64）。端到端加密要拿它给这个人包会话密钥。
   *
   * 两个公钥都是**公开**的，随名册发出去不算泄露 ——
   * 私钥从来没离开过本人的设备。
   */
  x?: string
}

export type MessageKind = 'text' | 'image' | 'sticker' | 'file' | 'system'

/** 引用某条消息时携带的摘要，避免为了画引用条再拉一次历史。 */
export interface ReplyRef {
  messageId: MessageId
  authorName: string
  excerpt: string
}

/** 一条消息上的表情回应。 */
export interface Reaction {
  emojiKey: string
  userIds: UserId[]
}

export interface Message {
  id: MessageId
  sessionId: SessionId
  authorId: UserId
  kind: MessageKind
  /** kind=text 时的正文 */
  text?: string
  /**
   * 端到端加密的信封（JSON 字符串）。有它的时候 `text` 是空的 ——
   * 正文只有持有该会话密钥的成员解得开，经手这坨字节的对端和局外人都看不到。
   */
  cipher?: string
  /** 加密用的密钥版本，参与 AAD 校验 */
  cipherVersion?: number
  /**
   * 发送方自己编的序号，参与 AAD 校验。
   *
   * 为什么不直接用 `sentAt`：一是 `sentAt` 只有毫秒分辨率，同一毫秒连发两条会撞上；
   * 二是这个序号必须在 `await encrypt()` **之前**就定死 —— 它参与 AAD，封装用了几号、
   * 帧里就得是几号，中途被别的发送顶掉就是 GCM 校验失败（详见 `store/chatStore.ts`）。
   * 三是它还是**去重的依据**（`noteSeen`）：同一个会话里两条不同的消息拿到同一个序号，
   * 接收方就再也分不出「重放」和「新消息」。所以它必须是每个 (会话, 发送方) 的
   * 单调计数器，而且要跨重启持久化（见 `store/cryptoSeq.ts`）。
   *
   * 注意它**不需要全局唯一**：AAD 的作用是「被认证」，不是「去重」。
   * 真正必须唯一的是每条消息的随机 IV，那个由 `seal()` 保证。
   */
  cipherSeq?: number
  /** kind=image 时的图片地址（本地 blob URL） */
  imageUrl?: string
  /**
   * kind=file/image 时，内容在**本地文件仓库**里的名字。
   *
   * P2P 版没有「服务器上的附件地址」这种东西：文件是按内容寻址的一坨字节，
   * 由收件人自己向对端要（见 `src/p2p/node.ts` 的 `requestMissingBlobs`）。
   * 所以这里的 id 是内容哈希，不是路径 —— 换台机器、换个时间拿到的都是同一份。
   */
  fileId?: string
  fileName?: string
  fileMime?: string
  fileSize?: number
  /**
   * 文件的本地可用地址（`data:` / `blob:` URL）。
   *
   * 字节没到齐之前是 `undefined` —— 界面据此画「正在接收」而不是画破图。
   * 到齐之后由 transport 补上并推一条 `message:update`。
   */
  fileUrl?: string
  /** kind=sticker 时的贴纸资源键 */
  stickerKey?: string
  /** kind=system 时的系统提示文案 */
  systemText?: string
  /**
   * 发送时间，**毫秒**时间戳，取发送方本机时钟；排序按 `(sentAt, id)` 升序。
   *
   * 注意它**不是**事件里的 `ts`：`event.ts` 是编码过的 HLC
   * （毫秒 × 1000 + 同一毫秒内的序号，见 `p2p/hlc.ts`），拿去 `new Date()`
   * 会得到公元 58761 年。从事件折算成消息时必须过一遍 `physicalMs()`
   * （`p2p/fold.ts` 与 `transport/local.ts` 的 ack 路径各有一处），
   * 漏了不会报错 —— 只是界面上所有时间和日期分组一起错。
   */
  sentAt: number
  /** 本地乐观消息还没有落进日志 */
  pending?: boolean
  /** 发送失败 */
  failed?: boolean
  replyTo?: ReplyRef
  mentions?: UserId[]
  reactions?: Reaction[]
  /** 撤回：保留占位，界面上显示成系统消息样式 */
  recalled?: boolean
}

export interface Session {
  id: SessionId
  name: string
  /** group = 频道群聊；direct = 一对一 */
  kind: 'group' | 'direct'
  memberIds: UserId[]
  /** 会话卡上的头像 */
  avatarKey: string
  /** 未读数 */
  unread?: number
  /** 最后一条消息的时间，用于排序 */
  lastActiveAt?: number
  /** 置顶。纯本机偏好，对端不必知道 */
  pinned?: boolean
  /** 免打扰：不弹通知、不闪任务栏，但照常计未读 */
  muted?: boolean
}

/** 发送一条消息时交给 transport 的东西。 */
export interface SendMessageInput {
  sessionId: SessionId
  kind: MessageKind
  text?: string
  /** 端到端加密的信封（已经序列化好的 JSON）。填了它就该留空 `text`。 */
  cipher?: string
  cipherVersion?: number
  cipherSeq?: number
  imageUrl?: string
  stickerKey?: string
  replyTo?: ReplyRef
  mentions?: UserId[]
  /** 本地生成的临时 id，`message:ack` 原样带回来做对账 */
  clientId: string
}

/** 拉历史 */
export interface HistoryQuery {
  sessionId: SessionId
  /** 往前翻页的游标，第一条时不传 */
  before?: MessageId
  limit?: number
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/**
 * 局域网公告。
 *
 * **任何人都能发**，所以每条都带着作者名（`by`），界面上必须显示 ——
 * 不能禁止说话，那就让每句话都可追溯到人。
 */
export interface Announcement {
  id: string
  title: string
  body: string
  /** 发布人显示名 */
  by: string
  /** 发布时间 */
  at: number
}

export interface ChatEventMap {
  /** 连接状态变化 */
  'connection:state': { state: ConnectionState; reason?: string }
  /** 新消息（含自己发出去的） */
  'message:new': Message
  /** 消息被修改或回应变化 */
  'message:update': Message
  /** 消息被撤回 */
  'message:recall': { sessionId: SessionId; messageId: MessageId }
  /** 会话列表变化 */
  'session:update': Session
  /** 会话被移除 */
  'session:remove': SessionId
  /** 用户在线上线下 */
  'presence:update': { userId: UserId; online: boolean }
  /** 有人正在输入 */
  'typing': { sessionId: SessionId; userId: UserId; until: number }
  /** 本地乐观消息被日志确认掉了：clientId → 正式 Message */
  'message:ack': { clientId: string; message: Message }
  /** 公告被发布或删除；删除时 announcement 只有 id */
  'announcement': { action: 'post' | 'remove'; announcement: Partial<Announcement> & { id: string } }
  /** 整份公告列表（折叠完之后一次性推过来） */
  'announcements:update': Announcement[]
  /** 整份好友状态（折叠完之后一次性推过来） */
  'friends:update': FriendState
  /** 已知的完整名册，带各人的公钥（端到端加密找收件人要用） */
  'roster:update': Operator[]
  /**
   * 有人给这个会话发了新密钥包。
   * **帧里不含钥匙内容** —— 收到之后要自己去取属于自己的那一份。
   */
  'key:available': { sessionId: SessionId; keyVersion: number; senderId: UserId }
}

/**
 * 好友状态。
 *
 * 这套东西没有「申请 / 同意」的状态机 —— 只有**集合交集**：
 *
 *   friends = pins ∩ (对方 pin 的集合)
 *
 * `pins` 是我单方面 pin 过谁（等价于「关注」），`friends` 是双向都成立的。
 * 好处：加好友和关注同一条代码路径；离线也能加；重复点无副作用；
 * 「拒绝」= 什么都不做，不需要任何回执。
 */
export interface FriendState {
  /** 我 pin 过谁（单向，可能对方还没 pin 我） */
  pins: UserId[]
  /** 双向都 pin 过的（真好友，本机已经把它们物化成 1:1 会话了） */
  friends: UserId[]
  /**
   * 谁 pin 了我、而我还没 pin 回去 —— 「谁想加你」。
   *
   * 这是单向 pin 顺带得到的收件箱：不需要额外的「好友申请」表，
   * 只是把同一个集合反过来查一次。而且它**没有「拒绝」这个动作**，
   * 对方永远不会收到「你被拒绝了」。
   */
  followers: UserId[]
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline'

export type ChatEventName = keyof ChatEventMap
export type ChatEventHandler<K extends ChatEventName> = (payload: ChatEventMap[K]) => void

export type Unsubscribe = () => void

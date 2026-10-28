import type {
  ChatEventName,
  ChatEventHandler,
  ConnectionState,
  FriendState,
  HistoryQuery,
  Message,
  MessageId,
  Operator,
  Reaction,
  SendMessageInput,
  Session,
  SessionId,
  Unsubscribe,
  UserId,
} from '../protocol/types'
import type { Bytes } from '../crypto/core'

/**
 * 客户端与传输层的唯一接口。
 *
 * UI 层只认这个接口，不认具体实现。当前唯一实现是 `P2pTransport`
 * （`src/transport/local.ts`），由 `src/transport/index.ts` 这个工厂构造。
 * 换成别的线路协议（比如换个后端）只要再写一个实现同一套方法的类，
 * 在工厂里换掉返回值即可，页面代码不用动。
 */
export interface ChatTransport {
  /** 建立连接。幂等：已经连上时直接返回。 */
  connect(): Promise<void>
  /** 主动断开，不再自动重连。 */
  disconnect(): Promise<void>
  /** 当前连接状态 */
  readonly state: ConnectionState

  /**
   * 本机身份，**由密钥派生，不是用户填的**。
   *
   * 这一条放在接口上而不是让上层去读配置，是因为 P2P 里它只有一个来源：
   * 本机的密钥对。`id` 是公钥的 SHA-256，`number` 是从它派生出来给人核对的
   * 8 位短码。以前 `chatStore` 是 `loadConfig().selfId` —— 那是服务器时代的
   * 遗留（那时 id 由服务器分配、存在配置里），P2P 下它永远是空串，界面上
   * 自己和别人都显示成「未知用户 / ????」。
   */
  readonly self: Operator

  /** 拉会话列表 */
  listSessions(): Promise<Session[]>
  /** 拉某个会话的历史消息，按时间正序返回 */
  history(query: HistoryQuery): Promise<Message[]>
  /** 创建会话（群聊 / 一对一） */
  createSession(input: {
    name: string
    kind: Session['kind']
    memberIds: UserId[]
  }): Promise<Session>
  /**
   * 退出一个会话 —— 把自己从成员列表里去掉，并推 `session:remove`。
   *
   * 注意是**退出**不是**删除**：P2P 里没有一个权威能把会话从所有人的本子上
   * 划掉，本地历史也照旧留着。
   */
  removeSession(sessionId: SessionId): Promise<void>

  /** 发消息。返回值是**写进自己日志之后**的正式消息。 */
  send(input: SendMessageInput): Promise<Message>

  /**
   * 发一个文件。
   *
   * 和 `send` 最大的不同是**字节不走日志**：文件可以几十兆，事件要同步给
   * 每一个人、还要长期留着，把字节塞进去等于让日志无限膨胀。
   *
   * 所以拆成两件事，顺序不能反：
   *   1. 字节交给节点 —— 只推给**这个会话的成员**，此刻不在线的那位等上线来要；
   *   2. 发一条 `file` 事件（声明）—— 它进日志，会同步给所有人。
   *
   * 先字节后声明：声明一旦同步过去，对端就会按 id 来要，那时我这边要是还没
   * 登记字节，他第一轮只能要到个空。反过来没关系 —— 字节先到而声明还没到的
   * 对端，只是暂时不知道该拿它做什么。
   *
   * `clientId` 是调用方生成的乐观 id，用于把 `message:ack` 配回界面上那条气泡。
   */
  sendFile(input: {
    sessionId: SessionId
    bytes: Bytes
    name: string
    mime: string
    clientId: string
  }): Promise<void>
  /** 撤回 */
  recall(sessionId: SessionId, messageId: MessageId): Promise<void>
  /** 加表情回应 */
  addReaction(sessionId: SessionId, messageId: MessageId, emojiKey: string): Promise<void>
  /** 去掉表情回应 */
  removeReaction(sessionId: SessionId, messageId: MessageId, emojiKey: string): Promise<void>
  /** 告诉对端「我在输入」。瞬时信息，不进日志（见 local.ts 的实现说明）。 */
  sendTyping(sessionId: SessionId): void
  /** 标记会话已读 */
  markRead(sessionId: SessionId): Promise<void>

  /**
   * 加好友 = pin 一个人。
   *
   * 没有「申请 → 等同意」这条链路，所以：
   *   - 对方**离线也能加**，不需要对方此刻在线；
   *   - 重复调用是幂等的（集合语义）；
   *   - 「拒绝」等于对方不 pin 回来，调用方**不会**收到任何失败。
   *
   * 返回值里的 `mutual` 表示这一刻交集是否成立；成立时本机已经把 1:1 会话
   * 建好并推了 `session:update`，`session` 字段是同一份。
   */
  pin(userId: UserId): Promise<FriendState & { mutual: boolean; session?: Session }>
  /** 取消 pin（也会解除「关注」；单向 pin 的另一半没什么可撤的） */
  unpin(userId: UserId): Promise<FriendState>

  /**
   * 把会话密钥包发出去 —— 每个收件人各一条 `key` 事件。
   *
   * `wrapped` 是「每个收件人一份」的密文（base64 信封），不含自己。
   * 事件只搬运这坨字节，经手的节点都解不开 —— 他们没有成员的私钥。
   *
   * `added` 是**实际发出去**的收件人。调用方必须按它来记账（记成「已经发过的人」），
   * 而不是按自己提交的那份 —— 否则会以为某个其实没发出去的人已经发过了，
   * 然后他永远读不到消息。
   */
  keyPublish(
    sessionId: SessionId,
    keyVersion: number,
    wrapped: Record<UserId, string>,
  ): Promise<{ sessionId: SessionId; keyVersion: number; added?: UserId[]; recipients?: UserId[] }>

  /** 从本地日志里查「给我的那一份」密钥包（取版本最高的）。没有就抛错。 */
  keyFetch(sessionId: SessionId): Promise<{
    sessionId: SessionId
    senderId: UserId
    keyVersion: number
    env: string
  }>

  /** 订阅事件，返回取消订阅函数 */
  on<K extends ChatEventName>(event: K, handler: ChatEventHandler<K>): Unsubscribe

  /**
   * 发一条公告。
   *
   * **任何人都能发** —— 这是 P2P 版和 1.x 最不一样的一处。1.x 里公告只能由
   * 服务器管理页发布，客户端没有这个按钮，理由是「免得任何一个人装了客户端
   * 就能往所有人屏幕上贴字」。那条理由在服务器架构下是成立的：服务器有
   * 一个**权威**，它决定谁能说。
   *
   * P2P 里没有权威可当这个门 —— 任何人都能往局域网上发广播，这是网络的性质，
   * 不是可以关掉的选项。所以这里不去假装有门卫，而是换一条约束：
   * **每条公告都带着作者名**，界面上必须显示。不能禁止说话，那就让每句话
   * 都可追溯到人。
   *
   * 幂等性靠 `id`：不传就按内容算（同一句话重复发不会变成两条）。
   */
  announce(input: { title: string; body: string; id?: string }): Promise<void>
}

/** 消息带上当前用户视角后的状态，UI 直接读它。 */
export interface ReactionTally {
  emojiKey: string
  count: number
  mine: boolean
  userIds: UserId[]
}

/** 把事件折出来的 Reaction[] 折算成 UI 好用的形式。 */
export function tallyReactions(reactions: Reaction[] | undefined, selfId: UserId): ReactionTally[] {
  if (!reactions?.length) return []
  return reactions.map((r) => ({
    emojiKey: r.emojiKey,
    count: r.userIds.length,
    mine: r.userIds.includes(selfId),
    userIds: r.userIds,
  }))
}

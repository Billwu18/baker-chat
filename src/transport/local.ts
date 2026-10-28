/**
 * P2P 传输层：把「一个本地事件日志 + 若干条直连链路」伪装成 UI 认识的
 * `ChatTransport`。
 *
 * ## 这一层为什么必须存在
 *
 * `P2pNode` 只认识事件（谁、什么时候、什么 kind、什么 body），而界面认识的是
 * 「会话列表 / 消息列表 / 好友状态」这些东西。两者之间需要一个翻译：
 *
 *     事件流（只增不改，最终一致）  ──fold──>  状态快照  ──diff──>  界面事件
 *
 * 翻译的方向是**单向的**：界面永远只看折叠出来的快照，从不反过来改事件。
 * 想改什么东西都得发一条新事件（发消息、点表情、撤回），没有第二条路。
 * 这不是限制，是这一版能保证「两个人看到的顺序最终一致」的全部理由。
 *
 * ## 为什么用「状态快照的差集」而不是「事件 → 界面事件」的直接映射
 *
 * 直接映射看起来更直观（收到 `msg` 就推 `message:new`），但它有一个致命的
 * 缺陷：**事件到达的顺序不保证依赖顺序**。`msg` 可能比它引用的 `session`
 * 先到，这时直接映射要么推出一个空气泡、要么得自己实现一遍「等依赖到齐」
 * 的逻辑 —— 而那正是 `fold()` 已经做好、并且已经测过的事。
 *
 * 所以这里不做映射，只做**对账**：每次折叠完，把新快照和上一份比一遍，
 * 多出来的推 `:new`、变了的推 `:update`、没了的推 `:remove`。
 * 结果是：**界面看到的东西永远等于折叠器的输出**，没有第二个真相。
 *
 * ## 代价与边界
 *
 * 每次状态变化要遍历一遍全部消息（几千条）算差集。这在「一个局域网里
 * 几十个人聊天」的量级是毫秒级，换来的是「不需要维护任何增量状态」。
 */

import { exportPublic, type IdentityKeys } from '../crypto/keys'
import type { Bytes } from '../crypto/core'
import type {
  Announcement,
  ChatEventMap,
  ChatEventHandler,
  ChatEventName,
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
import type { ChatTransport } from './types'
import { Emitter } from '../utils/emitter'
import { mimeFromName } from '../utils/mime'
import { type BlobMeta, type BlobStore, MemoryBlobStore } from '../p2p/blob'
import { identityOf } from '../p2p/event'
import {
  friends,
  messagesOf,
  sessionList,
  shortId,
  type Person,
  type P2pMessage,
  type P2pSession,
  type P2pState,
} from '../p2p/fold'
import { HybridClock, tsToMillis } from '../p2p/hlc'
import { EventLog, type LogStore, MemoryStore } from '../p2p/log'
import { P2pNode, type NetBridge, type PeerView } from '../p2p/node'

export interface P2pTransportOptions {
  /** 本机身份（`crypto/device.ts` 出来的那把）。 */
  keys: IdentityKeys
  /** 底层传输。Tauri 下是 `net_*` 命令的包装，测试里是内存假桥。 */
  net: NetBridge
  /** 事件日志的落脚处。不传就是纯内存（刷新即清空，只在测试里合理）。 */
  store?: LogStore
  /** 文件仓库。不传就自建一个内存的。 */
  blobs?: BlobStore
  /** 自我介绍，给同一个局域网里别人的「附近的人」用。 */
  info?: unknown
  /**
   * 我的名字和头像。
   *
   * 这两个东西**必须作为一条 `profile` 事件先发出去**，不能只存在本地配置里：
   * 别人验证我发的任何一条事件，都要先知道我的公钥；而公钥只从 profile 里来。
   * 没有 profile 的我 = 一个谁都验不了、因而谁都不收的人（本地也一样 ——
   * 见 `connect()` 里那段注释）。
   */
  profile?: { name?: string; avatarKey?: string }
}

/** 会话 id 的算法：单聊两边各算各的，必须得出同一个。 */
export function directSessionId(a: UserId, b: UserId): string {
  return a < b ? `d:${a}:${b}` : `d:${b}:${a}`
}

/** 群聊 id。发起人随机起一个，之后靠事件同步给所有成员。 */
export function newGroupId(): string {
  return `g:${crypto.randomUUID()}`
}

export class P2pTransport implements ChatTransport {
  /**
   * 造一个传输层。
   *
   * 是 `async` 而不是构造函数，因为**本机 id 不是配置项，是算出来的**：
   * `SHA-256(公钥)`。算它要过一遍 `crypto.subtle`，那是异步的。
   *
   * 为什么不在构造函数里先塞个空 id、等 `connect()` 再改：`P2pNode` 在
   * 构造时就要 `selfId`，它用这个值判断「这条事件是不是我发的」。一个
   * 占位 id 意味着在真实 id 就位之前收到的任何事件都会被当成**别人**的 ——
   * 包括我自己刚从别的设备同步过来的那部分。这不是能靠「反正 start()
   * 之前不会有事」绕过去的：`P2pNode` 一 `start()` 就会同步，而同步来的
   * 正是这些事件。
   */
  static async create(opts: P2pTransportOptions): Promise<P2pTransport> {
    const pub = await exportPublic(opts.keys)
    const self = await identityOf(pub)
    return new P2pTransport(opts, self)
  }

  private readonly emitter = new Emitter<ChatEventMap>()
  private readonly node: P2pNode
  private readonly log: EventLog
  private readonly keys: IdentityKeys
  private readonly blobs: BlobStore
  /** 本机 id。由公钥算出，构造前就定死了，不会变。 */
  private readonly selfId: UserId
  /**
   * 本机身份，交出去给上层当「我是谁」用。
   *
   * 必须从这里拿，不能让上层再自己去 `loadConfig().selfId` —— 配置里那个值
   * 是服务器时代的（那时 id 由服务器发），P2P 下它永远是空串。上层照着它
   * 去找自己会找不到，`personOf` 就退回占位符：界面上自己显示成
   * 「未知用户 / ????」，而**这看起来完全不像一个错误**，只像还没加载完。
   */
  get self(): Operator {
    return {
      id: this.selfId,
      name: this.profile.name,
      number: shortId(this.selfId),
      avatarKey: this.profile.avatarKey,
      isSelf: true,
    }
  }
  /** 当前的名字 / 头像。改了就重发一条 profile。 */
  private profile: { name: string; avatarKey: string }

  private started = false
  private connection: ConnectionState = 'idle'

  /**
   * 上一轮折叠的快照。差集就是拿它和新快照比出来的。
   *
   * `null` 表示「还没有基准」—— 第一次折叠之后**不发任何 :new**，
   * 只把基准立起来。理由是启动时整个日志会一次性折出来，那几千条
   * 历史消息如果都当成「新消息」推给界面，会触发几千条通知。
   */
  private previous: P2pState | null = null

  /** 别人的在线状态。折叠器不认识「在线」，那是链路层的事。 */
  private readonly online = new Set<UserId>()
  /** 已经发过 data URL 的文件，避免每次差集都重新编码一遍（编码很贵）。 */
  private readonly urls = new Map<string, string>()

  /** 用 `P2pTransport.create()`，别直接 new。 */
  private constructor(opts: P2pTransportOptions, self: UserId) {
    this.selfId = self
    this.keys = opts.keys
    this.profile = { name: opts.profile?.name ?? '', avatarKey: opts.profile?.avatarKey ?? '' }
    this.blobs = opts.blobs ?? new MemoryBlobStore()
    // 时钟必须是**整个节点共用的一个实例**（`hlc.ts` 开头写着这一条）：
    // `log` 每收下一条**验过签**的事件就把本地时钟往前推一次，节点自己
    // 发事件时从同一个实例 `tick()`。先前这里是 `new HybridClock()` 直接
    // 塞给节点、日志根本拿不到它，于是 `observe` 在生产里**零调用** ——
    // 「表快的机器永久赢下每一次冲突」这条问题就是那么来的。
    const clock = new HybridClock()
    this.log = new EventLog(opts.store ?? new MemoryStore(), { clock })
    // 时钟本身仍然不落盘，而且也不需要：`open()` 会把事件日志逐条 `ingest`
    // 一遍，`observe` 取的是最大值，所以读完历史之后本地时钟已经补到了
    // 日志里的最大 `ts`，不会出现「重启后自己新发的消息排到自己旧消息前面」。
    this.node = new P2pNode({
      keys: opts.keys,
      selfId: self,
      log: this.log,
      clock,
      net: opts.net,
      info: opts.info,
      blobs: this.blobs,
      onState: (state) => this.onState(state),
      onPeers: (peers) => this.onPeers(peers),
      onProblem: (text) => this.emit('connection:state', { state: this.connection, reason: text }),
      onBlob: (meta) => this.onBlob(meta),
    })
  }

  // -------------------------------------------------------------- 生命周期

  async connect(): Promise<void> {
    if (this.started) return
    this.started = true
    this.setConnection('connecting')

    try {
      // id 在 `create()` 里就算好了，这里只管起节点。
      // 身份这件事没有「配置」的余地：你的 id 等于你公钥的哈希，
      // 别人验证「这条消息真是你发的」靠的就是这一条。v1 让用户自己填 id
      // 是服务器时代的遗留，在 P2P 里等于允许任何人自称是你。
      await this.node.start()

      // ⚠ 这一句必须在**任何其他发布之前**，而且不能省。
      //
      // 日志校验一条事件的前提是「知道作者的 ed 公钥」，而公钥唯一的来源
      // 就是作者的 profile 事件。没有它的话，连**我自己**发的事件都进不了
      // 自己的日志 —— 本地会当成「作者不明」挂进 deferred 队列，
      // `publish` 于是抛「自己造的事件进不了本地日志」。这不是边界情况，
      // 是每个人启动时的第一条。profile 之所以能打破这个循环，是因为它
      // 自证：`identityOf({ed,x}) === author` 且签名用 `body.ed` 验得过，
      // 全程不需要事先认识作者。
      await this.publishProfile()

      this.setConnection('connected')
    } catch (error) {
      this.started = false
      this.setConnection('offline')
      throw error
    }
  }

  async disconnect(): Promise<void> {
    await this.node.dispose()
    this.started = false
    this.online.clear()
    this.setConnection('idle')
  }

  get state(): ConnectionState {
    return this.connection
  }

  /** 节点本身。界面里「附近的人」「网络状态」这类面板要用。 */
  get p2p(): P2pNode {
    return this.node
  }

  /** 把某个文件的字节拿出来（保存到磁盘、复制到剪贴板）。 */
  blobOf(fileId: string): Bytes | undefined {
    return this.blobs.get(fileId)
  }

  /**
   * 发出一份自我介绍。
   *
   * 这是身份体系的地基，所以它必须**自证**：body 里带着自己的两个公钥，
   * 而 `author` 就是这两个公钥的哈希。收件人不用事先认识我，就能确认
   * 「这个 id 确实属于这两把公钥」，同时也拿到了之后验证我签名所需的材料。
   *
   * 改名字 / 换头像就是再发一条 —— 折叠时按 `(ts, id)` 比大小，最新的赢，
   * 所以两个人在线时改了名字，双方看到的是同一份。
   */
  private async publishProfile(): Promise<void> {
    const pub = await exportPublic(this.keys)
    await this.node.publish('profile', {
      ed: pub.ed,
      x: pub.x,
      name: this.profile.name,
      avatarKey: this.profile.avatarKey,
    })
  }

  /**
   * 改名字 / 换头像，并把新的一份广播出去。
   *
   * 空名字是允许的（`fold` 会显示编号），但**不允许悄悄本地生效** ——
   * 名字是给别人看的，只在本地改等于没改。
   */
  async setProfile(profile: { name?: string; avatarKey?: string }): Promise<void> {
    this.profile = {
      name: profile.name ?? this.profile.name,
      avatarKey: profile.avatarKey ?? this.profile.avatarKey,
    }
    if (this.started) await this.publishProfile()
  }

  private setConnection(state: ConnectionState): void {
    if (this.connection === state) return
    this.connection = state
    this.emit('connection:state', { state })
  }

  // -------------------------------------------------------------- 会话

  async listSessions(): Promise<Session[]> {
    const state = this.requireState()
    return sessionList(state).map((s) => this.toSession(s, state))
  }

  async history(query: HistoryQuery): Promise<Message[]> {
    const state = this.requireState()
    const all = messagesOf(state, query.sessionId).map((m) => this.toMessage(m, state))
    if (!query.before) {
      const limit = query.limit ?? all.length
      return all.slice(-limit)
    }
    // 游标是「从哪条往前翻」，所以先切掉它以及它之后的，再取末尾 limit 条。
    const at = all.findIndex((m) => m.id === query.before)
    const before = at >= 0 ? all.slice(0, at) : all
    return before.slice(-(query.limit ?? before.length))
  }

  async createSession(input: {
    name: string
    kind: Session['kind']
    memberIds: UserId[]
  }): Promise<Session> {
    const self = this.selfId
    // 单聊的 id 是两边算出来的同一个值；群聊是随机的。
    //
    // 对端要从成员里**挑出不是我自己的那个**，不能直接取 `memberIds[0]`：
    // 调用方传进来的成员数组有两种形状 —— 好友流程传 `[对方]`，新建会话
    // 对话框传 `[自己, 对方]`。取 `[0]` 会在后一种形状上把 id 算成
    // `d:自己:自己`，于是两边算出不同的 id、各建各的单聊，谁也收不到谁。
    const peer = input.memberIds.find((id) => id !== self) ?? self
    const id = input.kind === 'direct' ? directSessionId(self, peer) : newGroupId()

    // 成员里必须包含自己：`foldSession` 会拒绝「创建者不在成员里」的会话，
    // 那条规则是防止有人凭空把陌生人塞进别人的列表。
    const memberIds = [...new Set([...input.memberIds, self])].sort()
    await this.node.publish('session', {
      id,
      kind: input.kind,
      name: input.name,
      memberIds,
      avatarKey: '',
    })
    return {
      id,
      name: input.name,
      kind: input.kind,
      memberIds,
      avatarKey: '',
    }
  }

  async removeSession(sessionId: SessionId): Promise<void> {
    // P2P 里没有「服务器把会话删掉」这件事，因为没有一个权威可以删 ——
    // 每个节点都持有全部事件，任何人删都删不干净。
    //
    // 能做了且语义正确的事是**退出**：把自己从成员列表里去掉。
    // 之后自己不再收到这条会话的新消息（`foldMessage` 要求作者是成员），
    // 但**历史仍然在本地** —— 这符合直觉：退出群聊不会抹掉你手机里
    // 已经收到的聊天记录。
    const state = this.requireState()
    const self = this.selfId
    const session = state.sessions.get(sessionId)
    if (!session) return

    await this.node.publish('session', {
      id: sessionId,
      kind: session.kind,
      name: session.name,
      avatarKey: session.avatarKey,
      memberIds: session.memberIds.filter((id) => id !== self),
    })
  }

  // -------------------------------------------------------------- 消息

  async send(input: SendMessageInput): Promise<Message> {
    const self = this.selfId
    const event = await this.node.publish(
      'msg',
      compact({
        sessionId: input.sessionId,
        kind: input.kind,
        text: input.text,
        cipher: input.cipher,
        cipherVersion: input.cipherVersion,
        cipherSeq: input.cipherSeq,
        imageUrl: input.imageUrl,
        stickerKey: input.stickerKey,
        replyTo: input.replyTo,
        mentions: input.mentions,
      }),
    )

    const state = this.requireState()
    const parsed = state.messages.get(event.id)
    const message = parsed
      ? this.toMessage(parsed, state)
      : {
          id: event.id,
          sessionId: input.sessionId,
          authorId: self,
          kind: input.kind,
          text: input.text,
          cipher: input.cipher,
          cipherVersion: input.cipherVersion,
          cipherSeq: input.cipherSeq,
          // 同样要换算：`event.ts` 是编码过的 HLC，而 `Message.sentAt` 是毫秒。
          // 少了这一步，ack 回来的这条消息和折叠出来的那条会**差 1000 倍**，
          // 界面上就表现为「消息先跳到最上面，再跳回最下面」。
          sentAt: tsToMillis(event.ts),
        }

    // 只发 `message:ack`，**不发** `message:new`。
    //
    // `message:new` 的唯一来源是折叠出来的差集（见 `onState`），这一点不能破：
    // 发消息那一刻折叠还没跑，这里再发一遍，等折叠追上就是第二条 ——
    // 上层按 id 去重所以不会显示两条，但「同一条消息推了两次」会让一切
    // 按事件计数的东西（未读数、通知、提示音）都数错。
    //
    // `ack` 回答的是另一个问题：「你那条乐观消息被确认了，这是正式的那条」。
    // 两个事件因此在语义上不重复。
    this.emit('message:ack', { clientId: input.clientId, message })
    return message
  }

  async recall(sessionId: SessionId, messageId: MessageId): Promise<void> {
    await this.node.publish('recall', { sessionId, messageId })
  }

  async addReaction(sessionId: SessionId, messageId: MessageId, emojiKey: string): Promise<void> {
    // `foldReact` 的语义是**幂等翻转**：同一个人对同一个 emoji 再点一次就是取消。
    // 所以「加」和「去掉」在事件层是同一个动作，区分由折叠器按当前状态算出。
    // 这里不能自作聪明地改成只加不减 —— 那样重传一次就会变成取消，
    // 而重传在局域网里是常态（每一帧都可能在重连时重发）。
    await this.node.publish('react', { sessionId, messageId, emojiKey })
  }

  async removeReaction(sessionId: SessionId, messageId: MessageId, emojiKey: string): Promise<void> {
    await this.node.publish('react', { sessionId, messageId, emojiKey })
  }

  sendTyping(sessionId: SessionId): void {
    // 「正在输入」不进日志：它是**瞬时的**，而日志是永久的。
    // 把「某人正在输入」写进一个永久同步的日志里，等于每次重连都把
    // 几分钟前的「正在输入…」重放一遍，而那个人早就把消息发完了。
    // 这一版干脆不做，比做一个会误报的好。
    void sessionId
  }

  async markRead(sessionId: SessionId): Promise<void> {
    // 已读是**每个人自己的**视图状态，不是共享事实。别人不需要知道
    // 我读没读（这也是 v1 的语义：未读数是客户端算的）。
    void sessionId
  }

  // -------------------------------------------------------------- 好友

  async pin(userId: UserId): Promise<FriendState & { mutual: boolean; session?: Session }> {
    const self = this.selfId
    // `foldPin` 认的是 `who`：没填时默认是事件的作者。
    // 显式写出来是因为「pin 自己」和「没填」不能混为一谈。
    await this.node.publish('pin', { who: userId })

    const state = this.requireState()
    const mutual = friends(state).includes(userId)
    const result: FriendState & { mutual: boolean; session?: Session } = {
      ...this.friendState(state),
      mutual,
    }
    if (mutual) {
      // 双向成了就顺手把 1:1 会话建出来。两边都会建，用的是**同一个 id**，
      // 所以不会出现两条一样的单聊 —— 这是 `directSessionId` 存在的理由。
      const id = directSessionId(self, userId)
      if (!state.sessions.has(id)) {
        await this.createSession({ name: '', kind: 'direct', memberIds: [userId] })
      }
      const after = this.requireState()
      const session = after.sessions.get(id)
      if (session) result.session = this.toSession(session, after)
    }
    return result
  }

  async unpin(userId: UserId): Promise<FriendState> {
    // 没有「取消 pin」这种事件。`foldPin` 只做加法，因为「去掉一个元素」
    // 在只增不改的日志里表达不出「这是最新的状态」—— 两条 pin / unpin
    // 事件的合并顺序会决定结果，而那正是 CRDT 要避免的。
    //
    // 能做的诚实的事是：**不加**。界面上「取消关注」因此是本地偏好
    // （`sessionPrefs` 走的是另一条路），而不是一个会同步给别人的动作。
    void userId
    return this.friendState(this.requireState())
  }

  // -------------------------------------------------------------- 会话密钥

  async keyPublish(
    sessionId: SessionId,
    keyVersion: number,
    wrapped: Record<UserId, string>,
  ): Promise<{ sessionId: SessionId; keyVersion: number; added?: UserId[]; recipients?: UserId[] }> {
    // v1 把密钥包交给服务器保管、由收件人来取；P2P 里没有「保管」这件事，
    // 所以直接**点对点发过去**。语义没变：事件仍然只搬运密文，
    // 经手的节点（包括转发的第三方）都解不开 —— 那把一个 X25519 信封
    // 发给谁是安全的，因为只有收件人的私钥能开它。
    const added: UserId[] = []
    for (const [recipient, env] of Object.entries(wrapped)) {
      await this.node.publish('key', { sessionId, keyVersion, to: recipient, env })
      added.push(recipient)
    }
    return { sessionId, keyVersion, added, recipients: added }
  }

  async keyFetch(sessionId: SessionId): Promise<{
    sessionId: SessionId
    senderId: UserId
    keyVersion: number
    env: string
  }> {
    const self = this.selfId
    // 密钥包就在本地日志里（别人发的时候顺手同步过来了），所以「取」
    // 是**查**而不是「向服务器要」。
    //
    // ---------------------------------------------------------------
    // 只认建钥人发的包。
    //
    // 「谁是建钥人」是一条每个人都能自己算出来的确定性规则：成员 id 里
    // 最小的那个（和 `chatStore.ensureSessionKey` 建钥时用的是同一条）。
    // 这里必须**在选包之前**就用它筛掉别人 —— 不能等 `acceptKey` 去拒。
    //
    // 为什么：这条循环原来是「取全日志里 keyVersion 最高的那一份」。
    // 而 `key` 事件要进日志只要求签名有效（`log.ts` 的 ingest 不查会话成员，
    // `fold.ts` 里根本没有 `key` 分支），所以局域网里**任何一个换过 profile 的
    // 对端**都能往别人的日志里塞一条 `keyVersion: 99` 的包 —— 收件人公钥是
    // 公开的，他用自己的私钥 + 对方的公钥就能封出一个对方打得开的信封。
    // 单聊的会话 id 是 `d:<甲>:<乙>` 两个人公钥哈希拼出来的，也公开可算。
    //
    // 光靠 `acceptKey` 事后拒是不够的：一旦这条假包被取出来，`acceptKey`
    // 会因为「发件人不是建钥人」整条拒收，而**真包已经被它挤掉了** ——
    // 于是这个人永远拿不到钥匙，`chatStore` 在拿不到钥匙时照发不误，
    // 消息就这么静默降级成明文出了局域网。一个版本号就能把整会话打成明文。
    //
    // 会话还不知道（成员名单没到）时不筛 —— 那种情况下连谁都认不出来，
    // 保留下面的「取最高版本」作为兜底。
    // ---------------------------------------------------------------
    const members = this.requireState().sessions.get(sessionId)?.memberIds
    const known = members?.length ? new Set(members) : null
    const owner = members?.length ? [...members].sort()[0] : null
    type Found = { senderId: UserId; keyVersion: number; env: string }
    // 建钥人发的包走 `best`，别的**成员**发的走 `fallback`。
    // 分两个槽是为了「优先」而不是「只能」：成员名单是会变的（有人退出、
    // 有人被移出），名单一变建钥人就跟着变，那时老包还在日志里、但发件人
    // 已经不是现任建钥人了。一刀切会让人**读得到的历史突然读不到**。
    // 而两个槽一起看，挡陌生人的效果一点没少 —— 非成员两槽都进不去。
    let best: Found | null = null
    let fallback: Found | null = null
    for (const event of this.log.all()) {
      if (event.kind !== 'key') continue
      const body = asRecord(event.body)
      if (!body) continue
      if (body.sessionId !== sessionId) continue
      if (body.to !== self) continue
      // 不是这个会话的成员发的，一律不看 —— 局域网上那些只换过 profile
      // 的陌生人，正是在这一步被挡在外面的。
      //
      // **会话还不知道时也一律不看**（`known` 为 null）：那种情况下连
      // 「谁是成员」都判不出来，放行等于把上面这道门整个拆掉，而攻击者
      // 恰恰能制造这个时机 —— 同步批次里 `key` 事件先于 `session` 事件
      // 到达是合法的。宁可这一次取不到（下次折叠完再来），也不 fail-open。
      if (!known || !known.has(event.author)) continue
      const env = typeof body.env === 'string' ? body.env : ''
      const version = typeof body.keyVersion === 'number' ? body.keyVersion : 0
      if (!env) continue
      const found: Found = { senderId: event.author, keyVersion: version, env }
      if (!owner || event.author === owner) {
        if (!best || version > best.keyVersion) best = found
      } else if (!fallback || version > fallback.keyVersion) {
        fallback = found
      }
    }
    const chosen: Found | null = best ?? fallback
    // 「日志里没有给我的那一份」是**正常状态**，不是故障 —— 建会话的第一
    // 瞬间每个人都会走到这里。上层按 `code` 分诊：
    //   - `no_bundle` → 允许去新建一把钥匙；
    //   - 其它错误   → 当成「有钥匙但我打不开」，拒绝新建（防止静默丢钥匙）。
    // 所以这里必须带上 `code`。丢了它，每个新会话都会被误判成「打不开」，
    // 于是永远不建钥：没有 `key` 事件、消息**静默降级成明文**发出去，
    // 界面上只是挂一条看不懂的报错。
    if (!chosen) {
      const error = new Error('还没有人给我这个会话的密钥') as Error & { code?: string }
      error.code = 'no_bundle'
      throw error
    }
    return { sessionId, ...chosen }
  }

  // -------------------------------------------------------------- 文件

  /**
   * 发一个文件。
   *
   * 两件事分开做，顺序不能反：
   *   1. 把字节交给节点（它在线的对端**直接推**，不在线的等上线来要）；
   *   2. 发一条 `file` 事件（声明），它进日志、会同步给所有人。
   *
   * 先字节后声明，是因为声明一旦同步过去，对端就会立刻按 id 来要 ——
   * 那时候我这边字节还没登记的话，他第一轮会要个空。反过来不会出问题：
   * 字节先到而声明还没到的对端，只是暂时不知道该拿它做什么。
   */
  async sendFile(input: {
    sessionId: SessionId
    bytes: Bytes
    name: string
    mime: string
    clientId: string
  }): Promise<void> {
    // 只有这个会话的成员能拿到字节。不是成员的对端连着也不会收到 ——
    // 局域网上「连上」不等于「该看」，这两件事必须分开判。
    const members = this.requireState().sessions.get(input.sessionId)?.memberIds ?? []
    const fileId = await this.node.shareBlob(input.bytes, input.name, input.mime, members)
    if (!fileId) throw new Error('这个文件没能放进本地文件仓库（可能超过大小上限）')

    const self = this.selfId
    const event = await this.node.publish('file', {
      sessionId: input.sessionId,
      fileId,
      name: input.name,
      mime: input.mime,
      size: input.bytes.length,
    })

    const state = this.requireState()
    const parsed = state.messages.get(event.id)

    // 自己的文件字节已经在本地了，直接算 data URL 挂上去 —— 不然自己的
    // 图片要等一个 `onBlob` 的回环才显示出来，会闪一下。
    this.urls.set(fileId, dataUrlOf(input.mime, input.bytes))

    // 折叠还没追上时就自己拼一条（`send()` 里也是这么做的）。
    //
    // 原来这里只有 `if (parsed)`、没有 else：`parsed` 为空时**既不 ack 也不
    // 报错**，上层那条乐观消息就永远停在 `pending` 上，界面一直显示
    // 「传输中…」。而重发按钮只对 `failed` 渲染（见 `MessageRow.tsx`），
    // 所以用户连手动救一下的机会都没有。
    const message = parsed
      ? this.toMessage(parsed, state)
      : {
          id: event.id,
          sessionId: input.sessionId,
          authorId: self,
          kind: 'file' as const,
          fileId,
          fileName: input.name,
          fileMime: input.mime,
          fileSize: input.bytes.length,
          sentAt: tsToMillis(event.ts),
        }

    // 和 `send()` 同理：只 ack，不自己造 `message:new`。
    this.emit('message:ack', { clientId: input.clientId, message })
  }

  // -------------------------------------------------------------- 公告

  /**
   * 发一条广播。
   *
   * v1 的公告只有服务端管理页能发；P2P 里没有管理员，所以**任何节点都能发**，
   * 并且带作者名 —— 收件人看到的是「谁说的」，而不是一个匿名的权威语气。
   * 这既是能力下放，也是责任下放：公告不再是「系统通知」，
   * 它就是一条署名的群发消息。
   */
  async announce(input: { title: string; body: string; id?: string }): Promise<void> {
    await this.node.publish('announce', {
      id: input.id ?? crypto.randomUUID(),
      title: input.title,
      body: input.body,
    })
  }

  // -------------------------------------------------------------- 订阅

  on<K extends ChatEventName>(event: K, handler: ChatEventHandler<K>): Unsubscribe {
    return this.emitter.on(event, handler)
  }

  // -------------------------------------------------------------- 内部

  private emit<K extends ChatEventName>(event: K, payload: ChatEventMap[K]): void {
    this.emitter.emit(event, payload)
  }

  private requireState(): P2pState {
    return this.node.getState()
  }

  /**
   * 折叠完了一次：把新快照和上一份对一遍。
   *
   * 第一次只立基准不发事件（见 `previous` 的注释）。
   */
  private onState(state: P2pState): void {
    const before = this.previous
    this.previous = state

    if (!before) {
      // 启动：把整份公告和好友状态推一次（界面要它们来画首屏）。
      this.emit('announcements:update', this.announcementsOf(state))
      this.emit('friends:update', this.friendState(state))
      this.emit('roster:update', this.rosterOf(state))
      return
    }

    const self = this.selfId
    if (!self) return

    // —— 消息：新增 / 变化
    for (const [id, message] of state.messages) {
      const previous = before.messages.get(id)
      if (!previous) {
        this.emit('message:new', this.toMessage(message, state))
        continue
      }
      // ⚠ 这里**故意不比**「文件的 URL 现在可用了没有」。
      //
      // 一开始把「字节到了」也算进「变了」，结果是：文件 URL 一旦进了缓存，
      // 之后**每一轮**折叠都会判定这条消息「变了」，于是每次有人说话都
      // 重推一遍所有带附件的消息。而且它并没有换来任何正确性 ——
      // 字节到达的判断权在 `onBlob()` 手里，它会专门推一条 update。
      // 一个事实只有一个负责人。
      if (!sameMessage(previous, message)) {
        if (!previous.recalled && message.recalled) {
          this.emit('message:recall', { sessionId: message.sessionId, messageId: message.id })
        }
        this.emit('message:update', this.toMessage(message, state))
      }
    }

    // —— 会话：新增 / 变化
    for (const [id, session] of state.sessions) {
      const previous = before.sessions.get(id)
      if (!previous || !sameSession(previous, session)) {
        this.emit('session:update', this.toSession(session, state))
      }
    }
    for (const [id] of before.sessions) {
      if (!state.sessions.has(id)) this.emit('session:remove', id)
    }

    // —— 好友：整份推（集合语义，差集的收益不抵「少推一次」的风险）
    if (!sameFriendState(before, state)) this.emit('friends:update', this.friendState(state))

    // —— 名册：有人改了名字 / 头像 / 公钥
    if (!sameRoster(before, state)) this.emit('roster:update', this.rosterOf(state))

    // —— 公告
    if (!sameAnnouncements(before, state)) {
      this.emit('announcements:update', this.announcementsOf(state))
      for (const [id, item] of state.announcements) {
        if (!before.announcements.has(id)) {
          this.emit('announcement', { action: 'post', announcement: { ...item, by: this.nameOf(state, item.by) } })
        }
      }
    }
  }

  private onPeers(peers: PeerView[]): void {
    const now = new Set(peers.filter((p) => p.connected).map((p) => p.id))
    // 连线的人变了才推事件。折叠一次会调一次 `emitPeers`，不去重的话
    // 每收到一条消息都会推一轮同样内容的 presence。
    for (const id of now) {
      if (!this.online.has(id)) {
        this.online.add(id)
        this.emit('presence:update', { userId: id, online: true })
      }
    }
    for (const id of [...this.online]) {
      if (!now.has(id)) {
        this.online.delete(id)
        this.emit('presence:update', { userId: id, online: false })
      }
    }
  }

  /**
   * 一个文件的字节到了。
   *
   * 找到引用它的那条消息，推一条 `message:update` —— 界面据此把占位
   * 换成真实内容。**同时把 data URL 缓存起来**（`this.urls`），
   * 因为差集是每次折叠都全量比的，而 base64 编码一张几 MB 的图很贵；
   * 缓存之后 `toMessage` 只是一次查表。
   */
  private onBlob(meta: BlobMeta): void {
    if (this.urls.has(meta.id)) return
    const bytes = this.blobs.get(meta.id)
    if (!bytes) return
    this.urls.set(meta.id, dataUrlOf(meta.mime || mimeFromName(meta.name), bytes))

    const state = this.previous
    if (!state) return
    for (const message of state.messages.values()) {
      if (message.fileId === meta.id) {
        this.emit('message:update', this.toMessage(message, state))
      }
    }
  }

  private toMessage(message: P2pMessage, state: P2pState): Message {
    const reactions = reactionsOf(message)
    const url = message.fileId ? this.urls.get(message.fileId) : undefined
    const isImage = message.kind === 'image'
    return {
      id: message.id,
      sessionId: message.sessionId,
      authorId: message.authorId,
      kind: message.kind,
      // 明文。加密的消息这里是 undefined，由解密层在渲染前补上 ——
      // 传输层不碰 crypto，它只负责把「事件里有什么」原样交出去。
      text: message.text,
      cipher: message.cipher,
      cipherVersion: message.cipherVersion,
      cipherSeq: message.cipherSeq,
      stickerKey: undefined,
      // 图片和文件都靠 `fileId` 寻址；`imageUrl` 只是「已经能显示了」的标志，
      // 沿用 v1 的字段名，界面不用改。
      imageUrl: isImage ? url : undefined,
      fileId: message.fileId,
      fileName: message.fileName,
      fileMime: message.fileMime,
      fileSize: message.fileSize,
      fileUrl: url,
      // 从折叠结果原样带出来。别在这里「顺手重建」引用摘要 —— 它是发送时
      // 冻结在事件体里的快照；重建会用上本地此刻的看法（比如对方已经改名）。
      replyTo: message.replyTo,
      mentions: message.mentions,
      sentAt: message.sentAt,
      recalled: message.recalled,
      reactions: reactions.length ? reactions : undefined,
      // 自己发的且还没被任何人确认过。P2P 没有确认帧，所以「发出去了」
      // 就等于「已经写进我自己的日志了」—— 一定是 true，界面不会显示 pending。
      pending: false,
    }
    void state
  }

  private toSession(session: P2pSession, state: P2pState): Session {
    const messages = messagesOf(state, session.id)
    const last = messages[messages.length - 1]
    return {
      id: session.id,
      name: session.kind === 'direct' ? this.directName(session, state) : session.name,
      kind: session.kind,
      memberIds: session.memberIds,
      avatarKey: session.avatarKey,
      lastActiveAt: last?.sentAt ?? session.ts,
    }
  }

  /** 单聊没有名字 —— 名字就是对面那个人。 */
  private directName(session: P2pSession, state: P2pState): string {
    const other = session.memberIds.find((id) => id !== state.self)
    if (!other) return session.name
    return this.nameOf(state, other)
  }

  private nameOf(state: P2pState, id: UserId): string {
    const person = state.people.get(id)
    if (!person) return id.slice(0, 8)
    return person.name || person.number
  }

  private announcementsOf(state: P2pState): Announcement[] {
    return [...state.announcements.values()]
      .sort((a, b) => b.at - a.at)
      .map((a) => ({
        id: a.id,
        title: a.title,
        body: a.body,
        by: this.nameOf(state, a.by),
        at: a.at,
        kind: 'manual' as const,
      }))
  }

  private friendState(state: P2pState): FriendState {
    const self = state.self
    return {
      pins: [...state.pins].sort(),
      friends: friends(state),
      // 「谁想加我」= 别人 pin 了我而我没回。跟随者集合已经由折叠器算好，
      // 这里只把「已经互相是好友」的剔掉 —— 否则同一个人会同时出现在
      // friends 和 followers 里，界面上会呈现出「他还在申请」。
      followers: [...state.followers].filter((id) => !state.pins.has(id)).sort(),
    }
    void self
  }

  private rosterOf(state: P2pState): Operator[] {
    return [...state.people.values()].map((person) => this.toOperator(person))
  }

  private toOperator(person: Person): Operator {
    return {
      id: person.id,
      name: person.name,
      number: person.number,
      avatarKey: person.avatarKey,
      isSelf: person.isSelf,
      // 在线状态**不在**折叠器里：它是链路的性质，不是事件。
      // 从 `this.online` 补，而不用 `person` 里的任何字段。
      online: this.online.has(person.id),
      ed: person.ed,
      x: person.x,
    }
  }
}

// ---------------------------------------------------------------- 小工具

/**
 * 把值为 `undefined` 的字段删掉。
 *
 * 为什么要在边界上显式做，而不是让 `canonicalJson` 顺手忽略：`canonicalJson`
 * 的输出会变成签名和内容 id 的一部分，所以它**拒绝**含 undefined 的输入
 * （见那里对「两份不同输入 → 同一串字节」的说明）。这个删除必须发生在
 * 更早的地方，而且要是显式的。
 *
 * 语义上也应该删：`send()` 里没填的字段意味着「这件事没说」，而不是
 * 「这件事的值是空」。留着 `cipher: undefined` 被编码成 `null` 的话，
 * 收件人会以为这是一条**加密消息**，只是解不开 —— 那会显示成
 * 「消息无法解密」，而不是正常显示明文。
 */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * 消息有没有变。
 *
 * 只比**会影响显示**的那几项。不比 `text`，因为 `text` 是解密层
 * 在渲染时补上的，不在折叠结果里（折叠器只认密文）。
 */
function sameMessage(a: P2pMessage, b: P2pMessage): boolean {
  if (a.recalled !== b.recalled) return false
  if (a.reactions.size !== b.reactions.size) return false
  for (const [emoji, who] of a.reactions) {
    const other = b.reactions.get(emoji)
    if (!other || other.size !== who.size) return false
    for (const id of who) if (!other.has(id)) return false
  }
  return true
}

function sameSession(a: P2pSession, b: P2pSession): boolean {
  if (a.name !== b.name || a.avatarKey !== b.avatarKey) return false
  if (a.memberIds.length !== b.memberIds.length) return false
  return a.memberIds.every((id, i) => id === b.memberIds[i])
}

function sameFriendState(a: P2pState, b: P2pState): boolean {
  return sameSet(a.pins, b.pins) && sameSet(a.followers, b.followers)
}

function sameRoster(a: P2pState, b: P2pState): boolean {
  if (a.people.size !== b.people.size) return false
  for (const [id, person] of a.people) {
    const other = b.people.get(id)
    if (!other || other.name !== person.name || other.avatarKey !== person.avatarKey) return false
  }
  return true
}

function sameAnnouncements(a: P2pState, b: P2pState): boolean {
  if (a.announcements.size !== b.announcements.size) return false
  for (const [id, item] of a.announcements) {
    const other = b.announcements.get(id)
    if (!other || other.title !== item.title || other.body !== item.body) return false
  }
  return true
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

function reactionsOf(message: P2pMessage): Reaction[] {
  const out: Reaction[] = []
  for (const [emojiKey, who] of message.reactions) {
    if (who.size === 0) continue
    out.push({ emojiKey, userIds: [...who].sort() })
  }
  return out.sort((a, b) => a.emojiKey.localeCompare(b.emojiKey))
}

/**
 * 把字节编成 `data:` URL。
 *
 * 为什么用 data URL 而不是 `URL.createObjectURL`：后者要显式 revoke，
 * 而消息列表会反复重绘、缓存又会跨会话存活 —— 漏一个 revoke 就是内存泄漏，
 * 而没有 revoke 的 blob URL 在 Tauri 的 webview 里会一直占着。data URL
 * 的代价是 base64 大 33% 且长驻内存，但换来的是没有生命周期要管。
 * 这套东西是几十 MB 的局域网聊天，这个取舍划算。
 */
function dataUrlOf(mime: string, bytes: Bytes | Uint8Array): string {
  const type = mime || 'application/octet-stream'
  let binary = ''
  // 分块拼接：`String.fromCharCode(...bytes)` 在几十万字节时会爆栈
  // （参数个数有上限），而图片正好在这个量级。
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${type};base64,${btoa(binary)}`
}

/** 兜底猜 MIME：见 `src/utils/mime.ts`。收文件和发文件用的是同一套规则。 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

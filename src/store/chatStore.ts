import type {
  Announcement,
  ConnectionState,
  FriendState,
  Message,
  MessageId,
  Operator,
  ReplyRef,
  Reaction,
  Session,
  SessionId,
  SendMessageInput,
  UserId,
} from '../protocol/types'
import type { ChatTransport } from '../transport/types'
import { consumeIdentityError } from '../transport'
import { personOf } from '../data/person'
import { DEFAULT_AVATAR_KEY } from '../data/avatars'
import {
  CryptoSessionManager,
  deserializeKeyEnvelope,
  serializeKeyBundle,
  serializeKeyEnvelope,
  type PeerIdentity,
} from '../crypto/session'
import type { Envelope } from '../crypto/envelope'
import type { Bytes } from '../crypto/core'
import { getDeviceIdentity } from '../crypto/device'
import { judgeKeySource } from '../crypto/keyOwnership'
import { isPlaintextMessage } from './plaintext'
import { mimeFromName } from '../utils/mime'
import { safeImageUrl } from '../utils/safeImage'
import { takePendingFriend } from '../friend/pending'
import { applyPrefs, loadPrefs, savePrefs, type PrefsMap } from './sessionPrefs'
import { forgetSeq, nextSendSeq, noteSeen } from './cryptoSeq'

/**
 * 整个聊天状态。
 *
 * 刻意做成「单一可变 store + 快照订阅」而不是 useReducer：消息流是高频异步事件，
 * store 里能直接写有序的副作用代码（乐观插入 → 收到 ack → 对账），比往 reducer
 * 里塞一堆 action 清楚得多。React 侧用 useSyncExternalStore 订阅快照。
 */

export interface TypingEntry {
  userId: UserId
  until: number
}

export interface ChatState {
  connection: ConnectionState
  connectionReason?: string
  self: Operator
  sessions: Session[]
  activeSessionId: SessionId | null
  messages: Record<SessionId, Message[]>
  typing: Record<SessionId, TypingEntry[]>
  /** 用户在线状态，收到 presence:update 时更新 */
  presence: Record<UserId, boolean>
  /** 每个会话是否还有更早的历史可拉 */
  hasMore: Record<SessionId, boolean>
  /** 正在往前翻历史 */
  loadingMore: boolean
  /**
   * 局域网公告。任何人都能发，折叠完之后整份推一次。
   */
  announcements: Announcement[]
  /** 有没看过的新公告（顶栏那个按钮上挂个红点） */
  announcementUnread: boolean
  /**
   * 好友。没有「申请 / 同意」那套状态，就是集合交集：
   *
   *   friends = pins ∩ (对方 pin 的集合)
   *
   * `pins` 是我单方面 pin 的人（等价于「关注」），`friends` 是双向都成立的。
   * 好友的物化结果就是 `sessions` 里那些 `kind === 'direct'` 的会话，
   * 所以这里只存 id 集合，不另起一份数据源。
   */
  friends: FriendState
  /**
   * 已知的完整名册（折叠完之后推一份），带各人的公钥。
   *
   * 名字和头像从这份名单里来（`src/data/person.ts`）；公钥也只能从名册里拿，
   * 而端到端加密必须知道收件人的 X25519 公钥才能给他包会话密钥。
   */
  roster: Operator[]
  /**
   * 已经「看过了」的 followers。
   *
   * 顶栏好友按钮上的红点 = 有人 pin 了你、但你还没打开过好友面板。
   * 做成一份单独的「已读」名单而不是直接把 followers 清掉，是因为 followers
   * 是对端报过来的真实状态，不能为了 UI 把它改掉 —— 红点只是「还没看过」的意思。
   * 顺带解决了「对方一直不撤回 pin，红点就永远消不掉」这个死结。
   */
  followersSeen: UserId[]
  /** 刚 pin 了谁但交集还没成立 —— 用来在 UI 上说清「已经关注了，等对方也加你」 */
  pinnedAt: number | null
  /**
   * 「滚到这条消息并高亮」的一次性请求。
   * 搜索结果、引用条跳转都往这里写；Conversation 消费完就 clearFocus()。
   * 带 nonce 是为了让「连续两次跳同一条」也能触发副作用。
   */
  focus: { sessionId: SessionId; messageId: MessageId; nonce: number } | null
  /** 全局错误条 */
  error?: string
  /**
   * 这个会话里出现过**未加密**的消息（我发出去的，或者收到的）。
   *
   * 存在的理由：没有会话密钥时代码的选择是「照常发出去、正文也留在外面」——
   * 不阻塞用户，这个取舍本身是对的。但原来的实现只把这件事写进控制台，界面上
   * 一点都看不出来：`chatStore` 里那句「界面上会有提示」是假的，整个
   * `src/components` 里没有任何一处提过加密状态（报告 M3）。
   *
   * 于是用户以为自己在聊私密内容，其实正文是明文走局域网的。这里把它记下来，
   * 由 `PlaintextNotice` 显示出来 —— 不给提示就等于骗人。
   *
   * 用「记录」而不是「当前是否加密」：已经明文发出去的那些字节收不回来，
   * 密钥随后建好也不改变这件事，所以标记只能由用户手动消掉。
   */
  unencrypted: Record<SessionId, true>
}

const EMPTY: ChatState = {
  connection: 'idle',
  // 传输层起来之前「我是谁」是**不知道的**，不是「未知用户」。
  // 这两者要分开：`personOf` 的 `????` 意思是「名册里查不到这个人」，
  // 用在启动那一瞬间会让人以为身份出了问题。空 id + 空编号，
  // 由 `BakerTitle` 决定这时候不显示。
  self: { id: '', name: '', number: '', avatarKey: DEFAULT_AVATAR_KEY, isSelf: true },
  sessions: [],
  activeSessionId: null,
  messages: {},
  typing: {},
  presence: {},
  hasMore: {},
  loadingMore: false,
  announcements: [],
  announcementUnread: false,
  friends: { pins: [], friends: [], followers: [] },
  roster: [],
  followersSeen: [],
  pinnedAt: null,
  focus: null,
  unencrypted: {},
}

export class ChatStore {
  private state: ChatState = { ...EMPTY }
  private listeners = new Set<() => void>()
  private transport: ChatTransport
  private unsubscribers: (() => void)[] = []
  private typingSweeper: number | null = null
  /** 最近一次发 typing 的时间，用来节流 */
  private lastTypingSent = new Map<SessionId, number>()
  private started = false
  /**
   * 最近一次「初次连接失败」写进错误条的那句话。
   *
   * 初连失败之后，重连是传输层自己在退避重试的（见 `src/p2p/node.ts` 的重试循环），
   * 成功时走的是 `connection:state` → `resync()` 那条路，**没人去动错误条**。
   * 于是那句连接失败的原文会一直挂在屏幕上，明明已经连上了 ——
   * 用户看到的就是「它说我连不上，可是会话都刷出来了」。
   *
   * 这里记住那句话，等 connected 时比对：对得上才清。用户自己点 × 关掉了、
   * 或者中间又冒出别的错（身份不可用之类），字符串对不上就不动它。
   */
  private connectFailureMessage: string | null = null
  /**
   * start() 的分代号。start 里有 await（拉会话），这期间 stop() 可能被调用
   * （React StrictMode 就是挂载 → 卸载 → 再挂载）。用它判断这一轮启动是否已经作废，
   * 免得迟到的代码又建出一个没人清的定时器、或者往已经停止的 store 里写状态。
   */
  private generation = 0
  /** 置顶 / 免打扰这类本地偏好，跟 sessions 合并后再给界面 */
  private prefs: PrefsMap = loadPrefs()
  /**
   * 端到端加密的会话密钥管理器。拿不到本机身份时是 null ——
   * 那种情况下消息明文发出，但**不会假装自己加密了**。
   *
   * 这句承诺现在有落点了：明文消息会经由 `insertMessage` → `notePlaintext`
   * 记进 `ChatState.unencrypted`，再由 `PlaintextNotice` 在会话头上挂一条
   * 「这个会话里有消息是未加密发出去的」（判定规则在 `store/plaintext.ts`）。
   * 在此之前这里只有一句空洞的注释 —— 报告 M3 就是照着它查的，全目录零命中。
   */
  private crypto: CryptoSessionManager | null = null
  /**
   * 正在给某个会话建钥匙的承诺。
   *
   * 为什么需要它：进会话、拉历史、发消息三个动作几乎同时发生，
   * 都会发现「这个会话还没钥匙」。没有这层去重就会同时建出三把钥匙、
   * 发三份互相覆盖的密钥包，最后谁的都对不上。
   */
  private keySetup = new Map<SessionId, Promise<boolean>>()

  constructor(transport: ChatTransport) {
    this.transport = transport
  }

  // ------------------------------------------------------ 端到端加密

  /**
   * 给一个会话准备好钥匙。
   *
   * 只有**我自己建这个会话**（ownerId 是我）时才主动生成并分发 ——
   * 别人建的会话里，钥匙该由建的人发过来，我等着收就行。
   * 否则同一个会话会有好几个人同时建钥匙，互相覆盖。
   *
   * 建好之后要 `keyPublish` 发出去：事件只搬这坨字节，经手的人都解不开。
   */
  private ensureSessionKey(sessionId: SessionId): Promise<boolean> {
    const running = this.keySetup.get(sessionId)
    if (running) return running

    const task = (async (): Promise<boolean> => {
      const manager = this.crypto
      if (!manager) return false

      const session = this.state.sessions.find((s) => s.id === sessionId)
      if (!session) return false
      // 谁来建这把钥匙？规则：**成员 id 里最小的那个**。
      //
      // 这是确定性规则，每个人算出来都是同一个人，不需要谁多存一个
      // ownerId，也不需要协商。反过来若让谁都建，同一个会话会被建出好几把
      // 钥匙互相覆盖，最后谁都读不全。
      const creator = [...session.memberIds].sort()[0]
      const isCreator = creator === this.state.self.id

      // ---------------------------------------------------------------
      // 情况零：「属于我的那一份」还没到手，先去日志里把它取回来。
      //
      // **这一步不分谁是建钥人** —— 每个成员都得走。原来它被挡在下面
      // `isCreator` 的早退之后，于是只有建钥人有机会认领自己的包：
      //   - 建钥人刷新后靠它取回钥匙（`selfEnvelope`）；
      //   - 而**其他成员永远走不到这里** —— `key:available` 全仓没有一个
      //     emit 点（`types.ts` 只声明、下面只订阅），`acceptKey` 又没有
      //     别的调用者。结果是每对会话里只有成员 id 最小那台设备有钥匙，
      //     另一方发出的每条消息都静默降级成明文、收到的每条密文都渲染成
      //     空白气泡 —— 不是边缘情况，是常态。
      //
      // 取不到不算错：建钥人还没铺好、或者对方离线，都会走到这里，
      // 下次名单推送/会话更新时会再进来一次。
      //
      // 只在手上真的没有钥匙时才查，否则每次进会话都白跑一遍日志扫描。
      // ---------------------------------------------------------------
      // 走到「建钥人换到本机」那条路时会带上「日志里已经发布过的版本」，
      // 让下面新建的密钥版本一定比它高（否则对端静默丢弃）。
      let rotateFrom = 0
      if (!manager.hasKey(sessionId)) {
        const claimed = await this.acceptKey(sessionId)
        if (claimed.status === 'ok') return true
        if (claimed.status === 'stale_owner') {
          // -------------------------------------------------------------
          // 建钥人换到本机了，而日志里只有旧建钥人的包。
          //
          // 那份包**不能被收下**：它的形状和「抢注 owner」完全一样，而且
          // 任何成员都能造一个。但也不能像以前那样直接判死 —— 新 owner 会
          // 永远卡在「拿不到旧钥匙、也建不了新钥匙」里，会话双向全哑、
          // 全程零报错（报告 M1）。
          //
          // 出路是往下走到「情况一」**新建一把更高版本的**：对端对更高版本
          // 是会收的（单向棘轮只挡平级和更低），而且收下时会顺手把旧版本那把
          // 留进 history，所以历史消息不会因为这次轮换而丢。
          // -------------------------------------------------------------
          console.warn(
            `[crypto] 会话 ${sessionId}：建钥人换成本机了，日志里只有第 ` +
              `${claimed.publishedVersion} 版的包（旧建钥人发的）—— 不接收，` +
              `改为新建一把第 ${claimed.publishedVersion + 1} 版的。`,
          )
          rotateFrom = claimed.publishedVersion
        } else if (claimed.status === 'unreadable') {
          // -------------------------------------------------------------
          // 日志里**有**一把钥匙，但给我的那一份我打不开。
          //
          // 这里绝对不能掉进下面「情况一」去新建一把同版本的钥匙。对端
          // 对同版本是「只补空缺、不覆盖」，新钥匙会被静默丢掉、回一个
          // `added: []`；而客户端拿 `recipients` 记了账，于是
          // `missingPeers` 变空、永远不再重试。终态是：自己发的旧消息
          // 一排空气泡，新消息用一把**谁都没有**的钥匙发出去（所有人都
          // 解不开），双向全哑，全程零报错。
          //
          // 停在原地并报出来，比悄悄走进那个状态好得多。
          // -------------------------------------------------------------
          console.warn(
            `[crypto] 会话 ${sessionId}：日志里有钥匙，但我这一份打不开，` +
              `不新建（新建会被对端静默丢弃）。等能开的那一份。`,
          )
          this.set({
            error: '这个会话的密钥取不回来：对端有一份，但解不开它。',
          })
          return false
        }
        // claimed.status === 'absent'：日志里确实没有钥匙。
      }

      // 不是建钥人就到此为止：没有属于我的包，说明建钥人还没铺好钥匙，
      // 等会话/名单再更新一次就会重进这里。
      if (!isCreator) return false

      const peers = this.peersOf(session)

      // ---------------------------------------------------------------
      // 情况二：钥匙已经有了，这次是来「补包」的。
      //
      // 什么时候会出现：建群的那一刻有人还没出现，名册里没有他的
      // 公钥，包不了他。等他上线、名单推过来，这里给他补上。
      //
      // **必须沿用同一把钥匙**（同 keyVersion）。换钥匙等于作废已经发出去的
      // 所有消息。发布侧对同版本是做「合并收件人」，正好配合。
      // ---------------------------------------------------------------
      if (manager.hasKey(sessionId)) {
        const missing = manager.missingPeers(sessionId, peers)
        if (!missing.length) return true
        const extra = await manager.wrapFor(sessionId, peers)
        if (!extra) return true
        const recipients = Object.keys(extra.wrapped)
        if (!recipients.length) return true
        const published = await this.publishKey(sessionId, extra.keyVersion, extra.wrapped)
        // 发布失败就**绝对不能记账** —— 记了这个人就被永久跳过：
        // `missingPeers` 会把他当已发，从此再也没人给他补包，
        // 他读不到任何一条消息，而且全程零报错。返回 false 让上层知道
        // 这次没落地，下次名单推送时还会再进来重试。
        if (!published) return false
        manager.markWrapped(sessionId, published)
        return true
      }

      // ---------------------------------------------------------------
      // 情况一：还没有钥匙，第一次建。
      // ---------------------------------------------------------------
      const ready = peers.filter((peer) => Boolean(peer.x))
      // 一个人都没有公钥就先别建：建了也发不出去，白占一个 keyVersion。
      // 等名单推过来时会再进来一次（见 roster:update 的处理）。
      if (!ready.length) return false

      const { keyVersion, wrapped } = await manager.createFor(sessionId, ready, {
        minVersion: rotateFrom,
      })
      const recipients = Object.keys(wrapped)
      if (!recipients.length) return false
      const published = await this.publishKey(sessionId, keyVersion, wrapped)
      // 记账要用**真正发出去的那份**：同版本补发时只补空缺，
      // 拿自己提交的键去记账会把「其实没发出去的人」记成已发。
      //
      // 发布失败（`published === null`）时一个字都不能记 —— 理由同情况二。
      // 返回 false 让调用方知道钥匙还没发出去。
      if (!published) return false
      manager.markWrapped(sessionId, published)
      return true
    })()
      .catch((error) => {
        console.warn('[crypto] 建会话密钥失败：', error)
        return false
      })
      .finally(() => {
        this.keySetup.delete(sessionId)
      })

    this.keySetup.set(sessionId, task)
    return task
  }

  /**
   * 发布一份密钥包，并回传「实际发出去的收件人」。
   *
   * 失败时返回 null 而不是抛出去：调用方在外面已经 catch 了，但这里要能
   * 区分「发了」和「没发」—— 没发就绝不能记账，否则那个人会被永久跳过。
   */
  private async publishKey(
    sessionId: SessionId,
    keyVersion: number,
    wrapped: Record<UserId, Envelope>,
  ): Promise<UserId[] | null> {
    try {
      const result = await this.transport.keyPublish(
        sessionId,
        keyVersion,
        serializeKeyBundle({ keyVersion, wrapped }).wrapped,
      )
      // 记账要用「现在总共有谁有份」，而不是「这次新加了谁」：
      // 刷新过、刚认领回自己钥匙的建钥人手上是空账本，只看 added 的话
      // 会把所有人都当成还没包过，每次进会话都白重包一遍。
      return result.recipients ?? result.added ?? Object.keys(wrapped)
    } catch (error) {
      // 说清楚是谁的没发出去 —— 这条日志是排查「某个人读不到消息」的唯一线索。
      console.warn(
        `[crypto] 会话 ${sessionId} 第 ${keyVersion} 版密钥包发布失败，` +
          `${Object.keys(wrapped).length} 个收件人没拿到钥匙：`,
        error,
      )
      return null
    }
  }

  /** 会话里的别人。掉线的人也要算进来 —— 钥匙是持久的，不看在线。 */
  private peersOf(session: { memberIds: UserId[]; id: SessionId }): PeerIdentity[] {
    const selfId = this.state.self.id
    return session.memberIds
      .filter((id) => id !== selfId)
      .map((id) => {
        const op = this.operatorOf(id)
        return op?.x ? { id, ed: op.ed ?? '', x: op.x } : null
      })
      .filter((peer): peer is PeerIdentity => peer !== null)
  }

  /**
   * 名单只认折叠出来的那一份。
   *
   * v1 这里退回本地硬编码表其实是无用功 —— 硬编码项没有公钥 `x`，
   * 调用方（peersOf）拿到它照样判空。去掉之后，「名册里没有这个人」
   * 和「我本地凑巧有这个人」就不再被混为一谈。
   */
  private operatorOf(id: UserId): Operator | undefined {
    return this.state.roster.find((op) => op.id === id)
  }

  /**
   * 收到别人发的密钥包：解开它，之后这个会话就能读了。
   *
   * 帧里**不含钥匙内容**（日志谁都能读，放帧里等于广播），
   * 要自己去 `keyFetch` 取属于自己的那一份 —— 那份是用我的 X25519
   * 公钥包的，只有我的私钥能开。
   *
   * 建钥匙的人**也有一份**（`CryptoSessionManager.selfEnvelope`），
   * 所以刷新页面之后走的是同一条路：把自己那一份取回来。
   *
   * @returns 三态，调用方**必须**区分（见 `ensureSessionKey` 的说明）：
   *          - `ok`        拿到钥匙了
   *          - `absent`    哪儿都没有这个会话的钥匙 → 可以放心新建
   *          - `unreadable` 日志里**有**钥匙，但给我的那一份我打不开 → 绝不能新建
   */
  private async acceptKey(
    sessionId: SessionId,
  ): Promise<
    | { status: 'ok' }
    | { status: 'absent' }
    | { status: 'unreadable' }
    | { status: 'stale_owner'; publishedVersion: number }
  > {
    const manager = this.crypto
    if (!manager) return { status: 'absent' }
    try {
      const bundle = await this.transport.keyFetch(sessionId)

      // ---------------------------------------------------------------
      // 谁有资格给我发这个会话的钥匙？只有建钥人。
      //
      // 「谁是建钥人」是一条**每个人都能自己算出来**的确定性规则：
      // 成员 id 里最小的那个（和上面 `ensureSessionKey` 建钥时用的是同一条）。
      // 所以这里可以本地判定，不需要相信对端说的任何话。
      //
      // 为什么必须有这一道：对端对「更高版本」原来是整块覆盖，只在同版本
      // 才校验发件人。于是任何一个成员发一个 keyVersion+1 的包，就能整个
      // 接管该会话的密钥 —— 对端照收，之后所有消息都用攻击者的钥匙加密，
      // 他全都能读，而原建钥人被永久踢出（发回旧版本会被判 stale_version，
      // 是单向棘轮）。发送侧现在也钉了 ownerId，但「谁先发谁就是 owner」
      // 本身可被抢注；只有这条本地规则不依赖任何对端状态。
      // ---------------------------------------------------------------
      const session = this.state.sessions.find((s) => s.id === sessionId)
      const owner = session ? [...session.memberIds].sort()[0] : null
      // 「谁有资格给我发这个会话的钥匙」是一条安全关键的确定性规则，
      // 单独抽出来放在 `crypto/keyOwnership.ts` 里，好让它能被直接测到
      // —— 正常对端本来就会通过，所以这里写错外面看不出来。
      const verdict = judgeKeySource({
        owner,
        selfId: this.state.self.id,
        senderId: bundle.senderId,
      })
      if (verdict !== 'accept') {
        console.warn(
          `[crypto] 会话 ${sessionId} 的密钥包来自 ${bundle.senderId}，` +
            `但建钥人应该是 ${owner} —— ` +
            (verdict === 'stale_owner'
              ? '建钥人换成本机了，不接收这一份，改为新建一把更高版本的。'
              : '拒绝，疑似密钥接管。'),
        )
        if (verdict === 'stale_owner') {
          return { status: 'stale_owner', publishedVersion: bundle.keyVersion }
        }
        return { status: 'unreadable' }
      }

      const sender = this.operatorOf(bundle.senderId)
      // 发件人公钥必须来自名册里那一份。不验证的话，
      // 中间人可以塞自己的公钥把整会话的钥匙换掉。
      if (!sender?.x || !sender.ed) {
        console.warn('[crypto] 发件人没有公钥，拒绝接收密钥包：', bundle.senderId)
        return { status: 'unreadable' }
      }
      const env = deserializeKeyEnvelope(bundle.env)
      if (!env) return { status: 'unreadable' }
      const ok = await manager.accept(
        sessionId,
        bundle.senderId,
        { ed: sender.ed, x: sender.x },
        bundle.keyVersion,
        env,
      )
      if (!ok) return { status: 'unreadable' }
      // 解开之后把这个会话里还没解出来的消息补一遍
      await this.rehydrate(sessionId)
      return { status: 'ok' }
    } catch (error) {
      // 「没有给我的包」是最常见的一种，不是错误 —— 建群的第一瞬间就是它。
      // 只有这一种情况才允许上层去新建一把钥匙。
      const code = (error as { code?: string } | null)?.code
      if (code === 'no_bundle') return { status: 'absent' }
      // 其它失败（网络抖了、验签不过、认不出这个发件人…）时我们**不知道**
      // 日志里到底有没有钥匙。这时按「可能有」处理。
      console.warn('[crypto] 接收会话密钥失败：', error)
      return { status: 'unreadable' }
    }
  }

  /**
   * 把一个还带着密文的消息解成明文。
   *
   * 解不开时**不删也不丢**：保留 `cipher` 原样存着，界面渲染成
   * 「这条消息解不开」的占位。理由是没有钥匙可能是暂时的
   * （钥匙包还在路上、或者我刚错过一帧），丢掉就永远看不到了。
   * 等钥匙到了 `rehydrate()` 会把它们补出来。
   */
  private async decryptMessage(message: Message): Promise<Message> {
    if (!message.cipher || message.text) return message
    const manager = this.crypto
    if (!manager) return message
    const env = deserializeKeyEnvelope(message.cipher)
    if (!env) return message
    const plain = await manager.decrypt(
      message.sessionId,
      message.cipherVersion ?? manager.keyVersion(message.sessionId),
      message.authorId,
      message.cipherSeq ?? 0,
      env,
    )
    if (plain === null) return message

    // 密文里装的是整个消息体（正文 / 图片 / 贴纸），不止 text ——
    // 图片的 data URL 是最大的一类内容，只加密 text 等于没加密。
    try {
      const parsed: unknown = JSON.parse(plain)

      // 不是对象就当纯文本。这里不能直接 `as {...}`：`JSON.parse('"hi"')` 是
      // 合法 JSON、`JSON.parse('null')` 也是，后面按字段取只会拿到 undefined，
      // 拼出来的消息既没有 text（一直重试解密）又没有被丢掉。
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ...message, text: plain }
      }

      const body = parsed as { text?: unknown; imageUrl?: unknown; stickerKey?: unknown }

      // 图片地址只认本地的 data URL（见 `utils/safeImage.ts` 里的理由）。
      const imageUrl = body.imageUrl
      const safeImage = safeImageUrl(imageUrl)
      if (typeof imageUrl === 'string' && imageUrl && !safeImage) {
        console.warn(
          `[chat] 消息 ${message.id} 里带了一个不是 data URL 的图片地址，已丢弃：`,
          imageUrl.slice(0, 80),
        )
      }

      return {
        ...message,
        // 字段逐个验类型：`text` 拿到非字符串会让 `MessageRow` 的
        // `text.matchAll(...)` 直接 TypeError，把整列消息带崩。
        text: typeof body.text === 'string' ? body.text : undefined,
        imageUrl: safeImage,
        stickerKey: typeof body.stickerKey === 'string' ? body.stickerKey : undefined,
      }
    } catch {
      // 不是 JSON 就当成纯文本（早期版本、或者别人手工发的）
      return { ...message, text: plain }
    }
  }

  /** 会话里所有还解不开的消息重试一遍。拿到新钥匙之后调。 */
  private async rehydrate(sessionId: SessionId): Promise<void> {
    const list = this.state.messages[sessionId]
    if (!list?.some((m) => m.cipher && !m.text)) return

    // 只挑「还解不开」的去解，并**按 id 记下结果**，最后合并进当前列表。
    //
    // 不能像原来那样把 await 之前那份 list 解完整体写回去：await 期间新到的
    // 消息不在 list 里，写回去就等于把它删了。而 rehydrate 恰恰是进会话时
    // 在后台跑的，那正是消息最容易进来的时刻 —— 表现是新消息一闪就没。
    // `loadMore` 也是 await 后重读列表，同一个道理。
    const targets = list.filter((m) => m.cipher && !m.text)
    const decrypted = await Promise.all(targets.map((m) => this.decryptMessage(m)))
    const patch = new Map(decrypted.map((m) => [m.id, m]))

    const current = this.state.messages[sessionId] ?? []
    const merged = current.map((m) => patch.get(m.id) ?? m)
    this.set({ messages: { ...this.state.messages, [sessionId]: merged } })
  }

  /**
   * 进会话时把钥匙备好：有就确保能读，没有就按需建或等收。
   *
   * 不 await 到 `dispatch` 里 —— 建钥匙要跑一次 X25519 密钥协商和
   * 一次网络往返，挡在发消息前面会明显卡一下。发消息时没钥匙就
   * 明文发（并标出来），钥匙到了下一条就自动加密了。
   */
  private kickKeySetup(sessionId: SessionId): void {
    const manager = this.crypto
    if (!manager) return
    // 有钥匙就先把历史消息补解一遍。
    if (manager.hasKey(sessionId)) void this.rehydrate(sessionId)
    // 但**有钥匙不等于所有人都拿到了**：建群时如果有人还没登录过，
    // 他的名字当时不在名单里、根本没被包上，那个人永远读不到群消息。
    // 所以这里无条件走一遍 ensureSessionKey —— 它在「钥匙已有」时
    // 退化成「给还没份的成员补包」，没有可补的就立刻返回 true。
    // 早期版本这里直接 return，于是补包这条路根本不会被执行到。
    void this.ensureSessionKey(sessionId)
  }

  /** 一整批消息过一遍解密（拉历史时用）。 */
  private decryptAll(messages: Message[]): Promise<Message[]> {
    if (!this.crypto) return Promise.resolve(messages)
    return Promise.all(messages.map((m) => this.decryptMessage(m)))
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ChatState => this.state

  private set(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) listener()
  }

  // ---------------------------------------------------------------- 生命周期

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const generation = ++this.generation

    this.bindTransportEvents()

    // 传输层准备时身份出过问题就说出来。**必须说出来**：那条路不会报错，
    // 只是这次连接不带公钥 —— 名册里没有我的公钥，别人永远加密不到我，
    // 我自己也建不出会话钥匙。沉默的话用户只会觉得「消息发出去没人理」。
    const identityError = consumeIdentityError()
    if (identityError) this.set({ error: describeError(identityError) })

    // 本机身份 → 会话密钥管理器。拿不到就退化成明文（不假装加密了）。
    //
    // 第二个参数必须是**从密钥算出来的 id**，不是 `loadConfig().selfId` ——
    // 后者是服务器时代的遗留（那时 id 由服务器分配并记在配置里），P2P 下
    // 永远是空串。传空串不会报错，只会让 `createFor` 把「我自己」也当成一个
    // 收件人、把信封之外的每一个人都算错。
    try {
      const identity = await getDeviceIdentity()
      if (this.generation !== generation) return
      this.crypto = new CryptoSessionManager(identity, this.transport.self.id)
    } catch (error) {
      console.error('[crypto] 本机身份不可用，这次连接的消息不会被加密：', error)
      this.set({ error: describeError(error) })
    }

    try {
      await this.transport.connect()
      if (this.generation !== generation) return
      const sessions = await this.transport.listSessions()
      if (this.generation !== generation) return
      // 先立「我是谁」，再去拉会话。id 与短码都由密钥派生（见
      // `ChatTransport.self`），不查名册 —— 名册这时候多半还是空的，
      // 而查不到的后果是自己显示成「未知用户 / ????」，看起来像没加载完。
      this.setSessions(sessions)
      this.set({
        self: this.transport.self,
        hasMore: Object.fromEntries(sessions.map((s) => [s.id, true])),
      })
      if (sessions.length) await this.selectSession(sessions[0].id)
    } catch (error) {
      if (this.generation !== generation) return
      const message = describeError(error)
      this.connectFailureMessage = message
      this.set({ error: message })
    }

    if (this.generation !== generation) return
    // 每秒清一次过期的「正在输入」
    this.typingSweeper = window.setInterval(() => this.sweepTyping(), 1000)
  }

  async stop(): Promise<void> {
    this.generation += 1

    // `started` 必须**先**放下，不能等下面的 await。
    //
    // React 严格模式在开发时会把 effect 跑成「执行 → 清理 → 再执行」，
    // 而清理里的 `stop()` 是不 await 的。如果 `started = false` 留在
    // `await this.transport.disconnect()` 后面，第二次 `start()` 会在它之前
    // 跑到，看到 `started` 还是 true 就直接 return 了；紧接着 stop() 才把它
    // 置回 false —— 于是**这条链上再也没有人连着**，界面永远停在「未启动」。
    //
    // 生产构建不会双跑 effect，所以这个问题只在开发模式下出现。
    this.started = false

    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
    if (this.typingSweeper !== null) {
      window.clearInterval(this.typingSweeper)
      this.typingSweeper = null
    }
    await this.transport.disconnect()
  }

  private bindTransportEvents(): void {
    const t = this.transport

    this.unsubscribers.push(
      t.on('connection:state', ({ state, reason }) => {
        this.set({ connection: state, connectionReason: reason })
        if (state === 'connected') {
          // 初连失败留下的那条提示，到这一刻已经过期了 —— 连上就该收掉，
          // 否则它会一直挂着，看起来像「连不上」。（比对见字段注释。）
          if (this.connectFailureMessage !== null) {
            if (this.state.error === this.connectFailureMessage) this.set({ error: undefined })
            this.connectFailureMessage = null
          }
          void this.resync()
          void this.flushPendingFriend()
        }
      }),
    )

    this.unsubscribers.push(
      t.on('message:new', (message) => {
        void this.decryptMessage(message).then((plain) => {
          // ★ 重放检查只做在这一条路上（实时推送），不做到历史上 ——
          // 完整理由见 `store/cryptoSeq.ts` 顶部的注释。
          //
          // `decryptMessage` 打不开时**原样返回同一个对象**，打开了才返回新对象，
          // 所以 `plain !== message` 就是「这条到底解开没有」。必须解开过才算数：
          // 还没钥匙、解不开的消息如果也记进「见过」，等钥匙到了 rehydrate
          // 想把它补解出来时就会被当成重放丢掉。
          if (plain !== message && !noteSeen(plain.sessionId, plain.authorId, plain.cipherSeq ?? 0)) {
            console.warn(
              `[crypto] 丢掉一条重放的消息：${plain.sessionId} / ${plain.authorId} #${plain.cipherSeq}`,
            )
            return
          }
          this.insertMessage(plain)
          if (plain.authorId !== this.state.self.id && plain.sessionId !== this.state.activeSessionId) {
            this.bumpUnread(plain.sessionId)
          }
        })
      }),
    )

    this.unsubscribers.push(
      t.on('message:ack', ({ clientId, message }) => {
        void this.decryptMessage(message).then((plain) => this.reconcileOptimistic(clientId, plain))
      }),
    )

    this.unsubscribers.push(
      t.on('message:update', (message) => {
        this.replaceMessage(message)
      }),
    )

    this.unsubscribers.push(
      t.on('message:recall', ({ sessionId, messageId }) => {
        const list = this.state.messages[sessionId]
        const target = list?.find((m) => m.id === messageId)
        if (!target) return
        this.replaceMessage({
          ...target,
          kind: 'system',
          text: undefined,
          imageUrl: undefined,
          stickerKey: undefined,
          recalled: true,
          systemText: '消息已被撤回',
        })
      }),
    )

    this.unsubscribers.push(
      t.on('session:update', (session) => {
        // 未读数是按事件折出来的，折叠时并不知道你正开着哪个会话，
        // 所以当前打开的会话一律按已读处理，免得自己正在看的窗口挂上红点。
        this.upsertSession(
          session.id === this.state.activeSessionId ? { ...session, unread: 0 } : session,
        )
        // 钥匙要在**双方都不用先点开会话**的情况下就绪。
        //
        // 建钥人是「成员 id 最小」那一个（见 `ensureSessionKey`），而建钥
        // 本来只发生在「进会话」时（`kickKeySetup`）。于是建钥人只要没点开
        // 这个会话，钥匙就永远不存在 —— 另一方发出去的每条消息都会静默
        // 降级成明文，界面上还什么都看不出来。会话一到就踢一脚，建钥人
        // 不看也能把钥匙铺好；不是建钥人的人在这里会立刻返回 false。
        void this.ensureSessionKey(session.id)
      }),
    )

    this.unsubscribers.push(
      t.on('session:remove', (sessionId) => {
        this.set({ sessions: this.state.sessions.filter((s) => s.id !== sessionId) })
      }),
    )

    this.unsubscribers.push(
      t.on('typing', ({ sessionId, userId, until }) => {
        if (userId === this.state.self.id) return
        const current = this.state.typing[sessionId] ?? []
        const next = current.filter((entry) => entry.userId !== userId)
        next.push({ userId, until })
        this.set({ typing: { ...this.state.typing, [sessionId]: next } })
      }),
    )

    this.unsubscribers.push(
      t.on('presence:update', ({ userId, online }) => {
        this.set({ presence: { ...this.state.presence, [userId]: online } })
      }),
    )

    // 公告：折叠完之后整份推一次，之后有人发布/删除就增量推
    this.unsubscribers.push(
      t.on('announcements:update', (list) => {
        // 这是「连上时的那一份」，不算新，不点红点
        this.set({ announcements: [...list].sort((a, b) => b.at - a.at) })
      }),
    )

    this.unsubscribers.push(
      t.on('announcement', ({ action, announcement }) => {
        if (action === 'remove') {
          this.set({
            announcements: this.state.announcements.filter((a) => a.id !== announcement.id),
          })
          return
        }
        const full = announcement as Announcement
        if (!full?.at) return
        const known = this.state.announcements.some((a) => a.id === full.id)
        const without = this.state.announcements.filter((a) => a.id !== full.id)
        this.set({
          announcements: [full, ...without].sort((a, b) => b.at - a.at),
          // 只有**没见过的 id** 才点红点。
          //
          // 这条曾经是个坑：健康检测在等级升级（warn → bad）时会拿**同一个 id**
          // 重发一次公告（server/src/health.mjs:324-341），如果这里无脑置 true，
          // 用户就会看到「刚点开过、红点又回来了」，怎么点都消不掉。
          ...(known ? {} : { announcementUnread: true }),
        })
      }),
    )
    // 好友：连上时整份推一次，之后每次 pin / unpin 的应答或 friend 帧里也带一份
    this.unsubscribers.push(
      t.on('friends:update', (next) => {
        this.set({
          friends: {
            pins: [...next.pins],
            friends: [...next.friends],
            followers: [...(next.followers ?? [])],
          },
        })
      }),
    )

    // 名单（带公钥）：端到端加密找收件人用。连上时推一次，有人改了名字也会再推。
    this.unsubscribers.push(
      t.on('roster:update', (roster) => {
        this.set({ roster })
        // 名单到了才知道收件人的公钥 —— 这时候再去建之前建不了的钥匙
        for (const session of this.state.sessions) this.kickKeySetup(session.id)
      }),
    )

    // 有人发了新密钥包。帧里不含钥匙，要自己去取属于自己的那一份。
    this.unsubscribers.push(
      t.on('key:available', ({ sessionId }) => {
        void this.acceptKey(sessionId)
      }),
    )

    // 这里原本订阅的是 `server:identified`：刚连上的服务器自报身份，记下来
    // 并留意「同一个地址换了一台服务器」。P2P 版没有这个事件 —— 也没有
    // 那类风险。1.x 要管这件事，是因为一登录就把 serverId 绑进了签名材料
    // （`authMaterialV2`），「我签的那台机器换人了」必须让人知道。
    //
    // 现在**没有任何需要签给别人的中间人**：每条事件都是作者自己用 Ed25519
    // 签的，收的人拿作者的公钥验（见 `src/p2p/event.ts` 的 `verifyEvent`）。
    // 没有可换的机器，也就没有可换的身份。
  }

  /** 公告面板被打开时调；清掉「有新公告」的红点 */
  clearAnnouncementUnread(): void {
    if (this.state.announcementUnread) this.set({ announcementUnread: false })
  }

  /**
   * 发一条公告。
   *
   * 任何人都能发（理由见 `ChatTransport.announce` 的注释：P2P 里没有权威
   * 可以当门卫，所以改成「每条都署名」）。这里只做输入校验和错误包装 ——
   * 真正的广播交给传输层。
   *
   * 空标题和空正文都拒掉：一条没有内容的公告占的是所有人的屏幕，
   * 而它甚至无法被点开看详情。
   */
  async postAnnouncement(input: { title: string; body: string }): Promise<string> {
    const title = input.title.trim()
    const body = input.body.trim()
    if (!title) return '公告得有个标题。'
    if (!body) return '公告不能只有标题。'
    try {
      await this.transport.announce({ title, body })
      return '发出去了。'
    } catch (error) {
      return `没发出去：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 好友面板被打开时调；把当前这批「想加你的人」记为已看过，顶栏红点随之灭掉。
   *
   * 只记 id，不动名册里的 followers —— 红点表示「还没看过」，不表示「已处理」。
   */
  markFollowersSeen(): void {
    const next = [...this.state.friends.followers]
    const same =
      next.length === this.state.followersSeen.length &&
      next.every((id) => this.state.followersSeen.includes(id))
    if (!same) this.set({ followersSeen: next })
  }

  /** 顶栏好友红点该不该亮：有人 pin 了我，而我还没打开过面板看 */
  hasUnseenFollowers(): boolean {
    return this.state.friends.followers.some((id) => !this.state.followersSeen.includes(id))
  }

  // ---------------------------------------------------------------- 好友

  /**
   * 加好友 = pin 一个人。
   *
   * 没有「申请 → 等同意」，所以这里不存在「对方拒绝了」这种结果：
   * 调用总会成功，返回值里的 `mutual` 说明交集这一刻成没成立。
   * 没成立也不报错 —— 单向 pin 就是「关注」，等对方也 pin 回来即可。
   *
   * 结果文案交给调用方渲染（面板里有地方显示），store 不自己弹提示 ——
   * 这里没有 toast 这个字段，硬塞进 error 会把它染成红的。
   */
  async pin(userId: UserId): Promise<{ mutual: boolean; message: string }> {
    if (userId === this.state.self.id) return { mutual: false, message: '不能加自己' }
    const name = personOf(this.state.roster, userId).name
    try {
      const result = await this.transport.pin(userId)
      this.set({ pinnedAt: Date.now() })
      return {
        mutual: result.mutual,
        message: result.mutual
          ? `你和 ${name} 已经是好友了 —— 1:1 会话已经建好`
          : `已关注 ${name}。对方也加你时会自动成为好友`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.set({ error: message })
      return { mutual: false, message: `加好友失败：${message}` }
    }
  }

  async unpin(userId: UserId): Promise<string> {
    try {
      await this.transport.unpin(userId)
      return `已取消关注 ${personOf(this.state.roster, userId).name}`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.set({ error: message })
      return `取消失败：${message}`
    }
  }

  /** 我单方面 pin 过、对方还没 pin 回来的（「关注中」）。 */
  isPinned(userId: UserId): boolean {
    return this.state.friends.pins.includes(userId)
  }

  /** 双向成立的真好友。 */
  isFriend(userId: UserId): boolean {
    return this.state.friends.friends.includes(userId)
  }

  /**
   * 处理「粘贴配对码 → 重载 → 真正加好友」的第二半。
   *
   * 配对码里带的是**对方的**身份，粘贴时已经写进本机存储了；
   * 这里跑在重载之后的新连接上，只要把那个待处理的 id pin 掉就行。
   * 记号取出来即销毁，所以失败（比如对端一直没出现）
   * 也不会每次重连都重试一遍 —— 那会变成骚扰。
   */
  private async flushPendingFriend(): Promise<void> {
    const userId = takePendingFriend()
    if (!userId) return
    // 等 resync 把会话列表铺好，否则新建的 1:1 会话可能被随后的 setSessions 覆盖掉
    await new Promise((resolve) => setTimeout(resolve, 120))
    const result = await this.pin(userId)
    if (result.mutual) {
      const session = this.state.sessions.find(
        (s) => s.kind === 'direct' && s.memberIds.includes(userId),
      )
      if (session) await this.selectSession(session.id)
    }
  }

  isOnline(userId: UserId): boolean {
    return (
      this.state.presence[userId] ?? this.state.roster.find((op) => op.id === userId)?.online ?? false
    )
  }

  /** 重连之后重新对齐一次会话列表与当前会话历史。 */
  private async resync(): Promise<void> {
    try {
      const sessions = await this.transport.listSessions()
      this.setSessions(sessions)
      const active = this.state.activeSessionId
      if (active) {
        const messages = await this.decryptAll(await this.transport.history({ sessionId: active, limit: 60 }))
        // 拉回来的只有日志里已经认下的消息。本地还在飞的（pending）和发失败的
        // 并不在里面，整段覆盖会把它们抹掉 —— 刚发出去的消息会从屏幕上凭空消失。
        const optimistic = (this.state.messages[active] ?? []).filter((m) => m.pending || m.failed)
        const known = new Set(messages.map((m) => m.id))
        const merged = [...messages, ...optimistic.filter((m) => !known.has(m.id))]
        merged.sort(bySentAt)
        this.set({ messages: { ...this.state.messages, [active]: merged } })
      }
    } catch {
      // 重连后的拉取失败不打扰用户，下一次事件会再试
    }
  }

  // ---------------------------------------------------------------- 会话

  async selectSession(sessionId: SessionId): Promise<void> {
    this.set({ activeSessionId: sessionId })
    this.clearUnread(sessionId)
    // 标记已读失败不值得打扰用户：红点本地已经清了，下次进来还会再报一次。
    void this.transport.markRead(sessionId).catch(() => {})

    // 进会话就把钥匙备好。不 await —— 建钥匙要一次密钥协商加一次网络往返，
    // 挡在这里会让点开会话明显顿一下。历史先用可能解不开的原文渲染，
    // 钥匙到了 rehydrate() 会把它们补成明文。
    this.kickKeySetup(sessionId)

    if (this.state.messages[sessionId]?.length) return

    try {
      const messages = await this.decryptAll(await this.transport.history({ sessionId, limit: 40 }))
      this.set({
        messages: { ...this.state.messages, [sessionId]: messages },
        hasMore: { ...this.state.hasMore, [sessionId]: messages.length >= 40 },
      })
    } catch (error) {
      this.set({ error: describeError(error) })
    }
  }

  async loadMore(): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (!sessionId || this.state.loadingMore) return
    const anchor = (this.state.messages[sessionId] ?? [])[0]
    if (!anchor) return

    this.set({ loadingMore: true })
    try {
      const older = await this.decryptAll(await this.transport.history({ sessionId, before: anchor.id, limit: 40 }))
      // 关键是这里要重新取一次最新的列表：请求发出后可能又收到了新消息，
      // 如果拿 await 之前的快照拼，这段时间到达的消息会被直接抹掉。
      const current = this.state.messages[sessionId] ?? []
      const known = new Set(current.map((m) => m.id))
      const prepend = older.filter((m) => !known.has(m.id))
      this.set({
        messages: { ...this.state.messages, [sessionId]: [...prepend, ...current] },
        hasMore: { ...this.state.hasMore, [sessionId]: older.length >= 40 },
      })
    } catch (error) {
      this.set({ error: describeError(error) })
    } finally {
      this.set({ loadingMore: false })
    }
  }

  async createSession(input: {
    name: string
    kind: Session['kind']
    memberIds: UserId[]
  }): Promise<void> {
    try {
      const session = await this.transport.createSession(input)
      this.upsertSession(session)
      await this.selectSession(session.id)
    } catch (error) {
      this.set({ error: describeError(error) })
    }
  }

  // ---------------------------------------------------------------- 本地会话偏好

  private setPref(sessionId: SessionId, patch: { pinned?: boolean; muted?: boolean }): void {
    const current = this.prefs[sessionId] ?? {}
    const next: { pinned?: boolean; muted?: boolean } = { ...current, ...patch }
    // 两个都关掉就把这条记录删掉，别在 localStorage 里越攒越多空对象
    if (!next.pinned) delete next.pinned
    if (!next.muted) delete next.muted
    const prefs = { ...this.prefs }
    if (next.pinned || next.muted) prefs[sessionId] = next
    else delete prefs[sessionId]
    this.prefs = prefs
    savePrefs(prefs)
    this.setSessions(this.state.sessions)
  }

  pinSession(sessionId: SessionId, pinned: boolean): void {
    this.setPref(sessionId, { pinned })
  }

  muteSession(sessionId: SessionId, muted: boolean): void {
    this.setPref(sessionId, { muted })
  }

  /** 这个会话是不是免打扰。收消息时判断要不要提醒用得上。 */
  isMuted(sessionId: SessionId): boolean {
    return this.prefs[sessionId]?.muted === true
  }

  /** 只清掉本机的这份聊天记录。对端的那份不归这里管，也删不掉。 */
  clearHistory(sessionId: SessionId): void {
    const next = { ...this.state.messages }
    delete next[sessionId]
    this.set({ messages: next, hasMore: { ...this.state.hasMore, [sessionId]: false } })
  }

  /**
   * 把当前这条消息从本地列表里拿掉。
   * 只影响这台机器上的显示，不通知对端 —— 「引用/回应」都还在，
   * 下次重新拉历史它又会回来，符合「本地清理」的语义。
   */
  deleteMessage(message: Message): void {
    this.removeMessage(message.sessionId, message.id)
  }

  /** 退出会话：先把自己从成员里去掉，成功后再从本地列表里摘掉。 */
  async leaveSession(sessionId: SessionId): Promise<void> {
    try {
      await this.transport.removeSession(sessionId)
      // 会话没了，序号和「见过」那张表也跟着清掉，别在 localStorage 里越攒越多。
      forgetSeq(sessionId)
      const sessions = this.state.sessions.filter((s) => s.id !== sessionId)
      this.set({ sessions })
      if (this.state.activeSessionId === sessionId) {
        this.set({ activeSessionId: sessions[0]?.id ?? null })
        if (sessions[0]) await this.selectSession(sessions[0].id)
      }
    } catch (error) {
      this.set({ error: describeError(error) })
    }
  }

  // ---------------------------------------------------------------- 会话属性

  /** 一条消息在哪个会话里 —— 搜索结果要拿它来跳转。 */
  sessionOf(messageId: MessageId): SessionId | null {
    for (const [sessionId, list] of Object.entries(this.state.messages)) {
      if (list.some((m) => m.id === messageId)) return sessionId
    }
    return null
  }

  /** 请求界面滚到某条消息并高亮它。会顺带切到那个会话。 */
  async focusMessage(sessionId: SessionId, messageId: MessageId): Promise<void> {
    if (this.state.activeSessionId !== sessionId) await this.selectSession(sessionId)
    this.set({ focus: { sessionId, messageId, nonce: Date.now() } })
  }

  clearFocus(): void {
    if (this.state.focus) this.set({ focus: null })
  }

  // ---------------------------------------------------------------- 发消息

  async sendText(text: string, replyTo?: ReplyRef): Promise<void> {
    const body = text.trim()
    const sessionId = this.state.activeSessionId
    if (!body || !sessionId) return
    await this.dispatch({
      sessionId,
      kind: 'text',
      text: body,
      replyTo,
      mentions: extractMentions(body, this.state.roster),
      clientId: newClientId(),
    })
  }

  async sendSticker(stickerKey: string): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (!sessionId) return
    await this.dispatch({ sessionId, kind: 'sticker', stickerKey, clientId: newClientId() })
  }

  /**
   * 发图片。小图直接内联成 data URL；
   * 大图先落进本地文件仓库、按内容哈希发出去，收件人再向对端要（见 `src/p2p/node.ts`）。
   */
  async sendImage(file: File): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (!sessionId) return
    try {
      const dataUrl = await readAsDataUrl(file)
      await this.dispatch({ sessionId, kind: 'image', imageUrl: dataUrl, clientId: newClientId() })
    } catch (error) {
      this.set({ error: describeError(error) })
    }
  }

  /**
   * 发一个文件（图片以外的都走这里）。
   *
   * 和图片不同，**字节不进消息体**：几十兆的文件塞进日志，会让每条事件、
   * 每次同步都背上它，日志再也瘦不下来。这里走内容寻址那条路 ——
   * 字节只推给这个会话的成员，日志里只留一条带 `fileId` 的声明。
   *
   * 代价是收件人那边要「声明到了 → 按 id 去要字节」一个来回，所以
   * 界面上会先看到一条占位（文件名 + 大小），字节到齐后才变成可保存的。
   */
  async sendFile(file: File): Promise<void> {
    const sessionId = this.state.activeSessionId
    if (!sessionId) return
    const clientId = newClientId()

    // 乐观插入。`id` 必须等于 `clientId`：`message:ack` 就是按它配回来的。
    const optimistic: Message = {
      id: clientId,
      sessionId,
      authorId: this.state.self.id,
      kind: 'file',
      sentAt: Date.now(),
      pending: true,
      reactions: [],
      fileName: file.name,
      fileMime: file.type || mimeFromName(file.name),
      fileSize: file.size,
    }
    this.insertMessage(optimistic)

    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await this.transport.sendFile({
        sessionId,
        bytes: bytes as Bytes,
        name: file.name,
        mime: file.type || mimeFromName(file.name),
        clientId,
      })
    } catch (error) {
      this.replaceMessage({ ...optimistic, pending: false, failed: true })
      this.set({ error: describeError(error) })
    }
  }

  /**
   * 把一个收到的文件存到本地。
   *
   * 字节可能还没到（对端离线、或者正在传），这时 `fileUrl` 是空的 ——
   * 界面上那个按钮本来就不该是可点的，这里再挡一道。
   */
  saveFile(message: Message): void {
    if (!message.fileUrl) {
      this.set({ error: '这个文件还没传过来，等对端上线后再试' })
      return
    }
    const link = document.createElement('a')
    link.href = message.fileUrl
    link.download = message.fileName || '下载的文件'
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  /** 乐观插入 → 交给 transport → 失败就标红。 */
  private async dispatch(input: SendMessageInput): Promise<void> {
    const optimistic: Message = {
      id: input.clientId,
      sessionId: input.sessionId,
      authorId: this.state.self.id,
      kind: input.kind,
      text: input.text,
      imageUrl: input.imageUrl,
      stickerKey: input.stickerKey,
      sentAt: Date.now(),
      pending: true,
      replyTo: input.replyTo,
      mentions: input.mentions,
      reactions: [],
    }
    this.insertMessage(optimistic)

    // 端到端加密：有钥匙就封起来，正文不进消息体。
    //
    // 没有钥匙**不阻塞发送** —— 建钥匙要跑一次 X25519 密钥协商加一次
    // 网络往返，挡在发消息前面会明显卡一下。没钥匙就明文发，
    // 同时踢一脚建钥匙，下一条通常就自动加密了。
    let payload: SendMessageInput = input
    const manager = this.crypto

    // 加密和发送**整段**在同一个 try 里。
    //
    // 原来只有 `transport.send` 被包着，上面那一段（`nextSendSeq`、
    // `keyVersion`、`await manager.encrypt`、`serializeKeyEnvelope`）是裸奔的。
    // 那一段抛错时，乐观消息既不是 pending 也不是 failed —— 它停在
    // `pending: true`，界面上永远显示「发送中…」，而「重发」按钮只在
    // `failed` 时渲染（见 `MessageRow.tsx`）。于是用户既推不出去也删不掉，
    // 只能重开会话把它冲掉。
    //
    // 这条路不是假想的：`manager.encrypt` 会抛（WebCrypto 的 OperationError、
    // 被写坏的序号表、导入失败的钥匙），而调用方是 `void store.sendText(...)`，
    // 抛出去就是个没人接的 rejection，控制台里一行红字，界面上一点动静都没有。
    try {
      if (manager) {
        // ---------------------------------------------------------------
        // 序号和版本必须在 **await 之前** 就定下来，之后一律用这两个局部量。
        //
        // 原来这里是：`this.cryptoSeq += 1` → 拿 `this.cryptoSeq` 去封装 →
        // 等 await 回来之后再读一次 `this.cryptoSeq` 填进帧里。两次读的是
        // 同一个可变字段，中间隔着一次 await，而调用方是 `void sendText(...)`、
        // **不 await** 的（`InputArea.tsx` 就是这么调的）。于是连发两条时，
        // 先出发的那条 seal 还没回来，后一条已经把计数器加到 2 ——
        // 第一条就被盖上 `cipherSeq: 2`，可它是用序号 1 封的。
        //
        // 序号参与 AAD，对不上就是 GCM 校验失败，收件人那边 `decrypt` 返回
        // null，表现是一排永久空白的空气泡，而且**没有任何报错**。
        // 发图片时最容易撞上：4MB 的 data URL 要 seal 几毫秒，够发好几条文字。
        // 帧里的序号是唯一凭据，发出去就再也改不了，所以只能在这里定死。
        //
        // 计数器本身现在按会话持久化在 `store/cryptoSeq.ts`：内存里的一个大计数器
        // 刷新就归零，同一个会话里两条**不同**的消息会拿到同一个 seq，
        // 接收方就再也分不出「重放」和「新消息」了。
        // ---------------------------------------------------------------
        const seq = nextSendSeq(input.sessionId)
        const version = manager.keyVersion(input.sessionId)
        const envelope = await manager.encrypt(
          input.sessionId,
          this.state.self.id,
          seq,
          JSON.stringify({
            text: input.text,
            imageUrl: input.imageUrl,
            stickerKey: input.stickerKey,
          }),
        )
        if (envelope) {
          payload = {
            ...input,
            // 正文塞进密文里，外面这几个字段一律清空 ——
            // 留着等于明文照样发出去了，加密就成了摆设。
            text: undefined,
            imageUrl: undefined,
            stickerKey: undefined,
            cipher: serializeKeyEnvelope(envelope),
            cipherVersion: version,
            cipherSeq: seq,
          }
        } else {
          void this.ensureSessionKey(input.sessionId)
        }
      }

      await this.transport.send(payload)
    } catch (error) {
      this.replaceMessage({ ...optimistic, pending: false, failed: true })
      this.set({ error: describeError(error) })
    }
  }

  async retry(message: Message): Promise<void> {
    this.removeMessage(message.sessionId, message.id)
    await this.dispatch({
      sessionId: message.sessionId,
      kind: message.kind,
      text: message.text,
      imageUrl: message.imageUrl,
      stickerKey: message.stickerKey,
      replyTo: message.replyTo,
      mentions: message.mentions,
      clientId: newClientId(),
    })
  }

  async recall(message: Message): Promise<void> {
    try {
      await this.transport.recall(message.sessionId, message.id)
    } catch (error) {
      this.set({ error: describeError(error) })
    }
  }

  async toggleReaction(message: Message, emojiKey: string): Promise<void> {
    const selfId = this.state.self.id
    // 参数里的 `message` 是**渲染那一刻的快照**。连点两个表情时，第二次点
    // 用的还是第一个表情生效前的 `reactions`，于是第一次的反应会被整个抹掉
    // （失败回退时更糟：退回的是两份之前的旧值）。以 store 里的当前值为准。
    const current = this.state.messages[message.sessionId]?.find((m) => m.id === message.id) ?? message
    const before = current.reactions ?? []
    const mine = before.find((r) => r.emojiKey === emojiKey)?.userIds.includes(selfId) ?? false

    // 先本地翻转。点表情是很轻的互动，等一个网络往返才变色手感很差；
    // 折叠随后会推 message:update，那时再对齐成权威值。
    this.replaceMessage({
      ...current,
      reactions: mine
        ? before
            .map((r) =>
              r.emojiKey === emojiKey
                ? { ...r, userIds: r.userIds.filter((id) => id !== selfId) }
                : r,
            )
            .filter((r) => r.userIds.length > 0)
        : addReactionUser(before, emojiKey, selfId),
    })

    try {
      if (mine) await this.transport.removeReaction(message.sessionId, message.id, emojiKey)
      else await this.transport.addReaction(message.sessionId, message.id, emojiKey)
    } catch (error) {
      // 失败就退回原样，别让界面留下一个日志里并不存在的反应。
      // 注意回退要用**刚才那份** `before`：网络往返期间可能有别人的反应折叠进来。
      this.replaceMessage({ ...current, reactions: before })
      this.set({ error: describeError(error) })
    }
  }

  /** 用户在输入框里打字时调用，内部按 2 秒节流，避免刷爆对端。 */
  notifyTyping(): void {
    const sessionId = this.state.activeSessionId
    if (!sessionId) return
    const last = this.lastTypingSent.get(sessionId) ?? 0
    if (Date.now() - last < 2000) return
    this.lastTypingSent.set(sessionId, Date.now())
    this.transport.sendTyping(sessionId)
  }

  // ---------------------------------------------------------------- 内部

  private insertMessage(message: Message): void {
    const list = this.state.messages[message.sessionId] ?? []
    const existingIndex = list.findIndex((m) => m.id === message.id)
    let next: Message[]
    if (existingIndex >= 0) {
      next = [...list]
      next[existingIndex] = message
    } else {
      next = [...list, message]
    }
    next.sort(bySentAt)
    this.set({ messages: { ...this.state.messages, [message.sessionId]: next } })
    this.notePlaintext(message)
  }

  /**
   * 记下「这个会话里有消息是明文走的」。
   *
   * 判定规则在 `store/plaintext.ts`（`isPlaintextMessage`）—— 那边是可单测的，
   * 这里只负责往状态里记账。为什么要有这条记账、为什么原来那样是骗人，
   * 见 `PlaintextNotice` 和 `ChatState.unencrypted` 的注释。
   */
  private notePlaintext(message: Message): void {
    if (!isPlaintextMessage(message)) return
    if (this.state.unencrypted[message.sessionId]) return
    this.set({ unencrypted: { ...this.state.unencrypted, [message.sessionId]: true } })
  }

  private replaceMessage(message: Message): void {
    const list = this.state.messages[message.sessionId]
    if (!list) return
    const index = list.findIndex((m) => m.id === message.id)
    if (index === -1) {
      this.insertMessage(message)
      return
    }
    const next = [...list]
    next[index] = message
    this.set({ messages: { ...this.state.messages, [message.sessionId]: next } })
  }

  private removeMessage(sessionId: SessionId, messageId: MessageId): void {
    const list = this.state.messages[sessionId]
    if (!list) return
    this.set({
      messages: { ...this.state.messages, [sessionId]: list.filter((m) => m.id !== messageId) },
    })
  }

  /**
   * 日志确认了本地乐观消息：用正式消息替换掉临时消息，
   * 并保证同一个消息 id 在列表里只出现一次（ack 与广播谁先到都不重复）。
   */
  private reconcileOptimistic(clientId: string, message: Message): void {
    const list = this.state.messages[message.sessionId] ?? []
    const withoutOfficial = list.filter((m) => m.id !== message.id)
    const optimisticIndex = withoutOfficial.findIndex((m) => m.id === clientId)

    let next: Message[]
    if (optimisticIndex >= 0) {
      next = [...withoutOfficial]
      next[optimisticIndex] = message
    } else {
      next = [...withoutOfficial, message]
    }
    next.sort(bySentAt)
    this.set({ messages: { ...this.state.messages, [message.sessionId]: next } })
    this.bumpSessionActivity(message.sessionId, message.sentAt)
  }

  private upsertSession(session: Session): void {
    const existing = this.state.sessions.find((s) => s.id === session.id)
    let sessions: Session[]
    if (existing) {
      sessions = this.state.sessions.map((s) => (s.id === session.id ? { ...s, ...session } : s))
    } else {
      sessions = [...this.state.sessions, session]
    }
    sessions.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
    this.set({ sessions: applyPrefs(sessions, this.prefs) })
  }

  /** 会话列表整批换掉时（启动、重连、收到全量列表）也要过一遍本地偏好。 */
  private setSessions(sessions: Session[]): void {
    this.set({ sessions: applyPrefs(sessions, this.prefs) })
  }

  private bumpSessionActivity(sessionId: SessionId, at: number): void {
    const session = this.state.sessions.find((s) => s.id === sessionId)
    if (!session) return
    this.upsertSession({ ...session, lastActiveAt: at })
  }

  private bumpUnread(sessionId: SessionId): void {
    // 正在看的那个会话不该长红点 —— 消息就在眼前，用户已经读到了。
    if (sessionId === this.state.activeSessionId) return
    const session = this.state.sessions.find((s) => s.id === sessionId)
    if (!session) return
    this.upsertSession({ ...session, unread: (session.unread ?? 0) + 1 })
  }

  private clearUnread(sessionId: SessionId): void {
    const session = this.state.sessions.find((s) => s.id === sessionId)
    if (!session || !session.unread) return
    this.upsertSession({ ...session, unread: 0 })
  }

  private sweepTyping(): void {
    const now = Date.now()
    let changed = false
    const typing: typeof this.state.typing = {}
    for (const [sessionId, entries] of Object.entries(this.state.typing)) {
      const alive = entries.filter((e) => e.until > now)
      typing[sessionId] = alive
      if (alive.length !== entries.length) changed = true
    }
    if (changed) this.set({ typing })
  }

  dismissError(): void {
    this.set({ error: undefined })
  }

  /**
   * 用户确认了「这个会话有过明文消息」这条提示，把它收起来。
   *
   * 注意这**不会**让那些消息变成加密的，只是不再提示。真实的明文副本已经
   * 在局域网里传过了 —— 提示的作用是让人知道这件事发生过，不是把它撤销。
   */
  dismissPlaintextNotice(sessionId: SessionId): void {
    if (!this.state.unencrypted[sessionId]) return
    const next = { ...this.state.unencrypted }
    delete next[sessionId]
    this.set({ unencrypted: next })
  }
}

// ------------------------------------------------------------------ 工具

function newClientId(): string {
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 从正文里认出 @XXX，换成稳定的 userId。
 *
 * 名字表是**名册**（`state.roster`），不是一份写死的本地表 —— 2.0 之前这里查的是
 * 客户端自己那份干员表，结果两个没对上时 @ 会静默失效或认错人。
 * 名册里查不到就原样把 `@XXX` 交上去，别处可能知道某个本机没有的身份。
 *
 * 注意按名字匹配天然有歧义（两个人可以都叫「管理员」），所以命中多个时这里只取先到的
 * 那个；真要精确 @ 人，得 @ 编号。
 */
function extractMentions(text: string, roster: Operator[]): UserId[] | undefined {
  const matched = text.match(/@[\u4e00-\u9fa5A-Za-z0-9_]+/g)
  if (!matched?.length) return undefined
  const byName = new Map(roster.map((op) => [op.name, op.id]))
  return Array.from(
    new Set(
      matched.map((token) => {
        const name = token.slice(1)
        return byName.get(name) ?? token
      }),
    ),
  )
}

/** 所有会话加起来有多少条未读。任务栏 / 标题栏提示用。 */
export function totalUnread(sessions: Session[]): number {
  return sessions.reduce((sum, session) => sum + (session.unread ?? 0), 0)
}

/** 把某个用户加进某条表情反应；这条反应还不存在就新建一条。 */
function addReactionUser(reactions: Reaction[], emojiKey: string, userId: UserId): Reaction[] {
  const index = reactions.findIndex((r) => r.emojiKey === emojiKey)
  if (index === -1) return [...reactions, { emojiKey, userIds: [userId] }]
  const next = [...reactions]
  next[index] = { ...next[index], userIds: [...next[index].userIds, userId] }
  return next
}

/**
 * 排序：按 `(sentAt, id)` 升序 —— 和 `protocol/types.ts` 里对 `sentAt` 的
 * 契约、以及折叠层的 `insertMessageSorted` 完全一致。
 *
 * `sentAt` 保留了 HLC 的亚毫秒部分（见 `hlc.ts` 的 `tsToMillis`），所以正常
 * 情况下不会撞；这里的 id 兜底是为了「数据被写坏 / 两条消息真的同毫秒且
 * 小数部分相同」这种边界，保证排序是全序、两台机器算出来一样。
 */
function bySentAt(a: Message, b: Message): number {
  if (a.sentAt !== b.sentAt) return a.sentAt - b.sentAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

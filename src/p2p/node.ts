/**
 * 把「事件日志 / 时钟 / 同步协议」缝到 Rust 的传输层上。
 *
 * 这一层是唯一同时认识两边的东西：左边是 `log.ts` 的 CRDT，右边是
 * `net_*` 命令和 `baker://net` 事件流。它不碰界面，也不碰加密原语 ——
 * 那两件事分别归 `transport/local.ts` 和 `crypto/`。
 *
 * ## 离线消息为什么不需要队列
 *
 * 第一版的设计里有一个「发不出去就排队，等对方上线再补」的队列。写完之后
 * 发现它是多余的：同步本来就是**对 id 集合取差集**，对方重新连上时我们会
 * 把自己全部事件 id 报过去，他那边算出差集，没收到的那几条自然就包含在里面。
 *
 * 所以「离线消息」不是一个功能，是同步协议的一个性质。任何一条已经进了本地
 * 日志的事件，在被对端确认收到之前，都会在每一次重连时自动重发 —— 不需要
 * 记录「哪条没发出去」，也就不需要一个会写错的队列。
 *
 * 唯一需要额外处理的是一种窄情况：**链路还在，但这一帧没送出去**（对方进程
 * 崩了但 socket 还没关）。这时同步不会重来，所以要主动补一次。
 */

import { type IdentityKeys } from '../crypto/keys'
import { type BlobMeta, type BlobStore, blobIdOf, blobMatches, decodeBlob, encodeBlob } from './blob'
import type { Bytes } from '../crypto/core'
import { type P2pEvent, type UserId, signEvent } from './event'
import { fold, emptyState, type P2pState } from './fold'
import { HybridClock } from './hlc'
import { EventLog } from './log'
import { chunkEvents, decodeFrame, encodeFrame, eventsTheyLack } from './wire'

// ---------------------------------------------------------------- 传输桥

/** Rust 报上来的事件，与 `NodeEvent` 一一对应。 */
export type NetEvent =
  | { kind: 'discovered'; peer: { id: string; addr: string | null; info: unknown } }
  | { kind: 'lost'; id: string }
  | { kind: 'linked'; peer_id: string; addr: string; info: unknown }
  | { kind: 'unlinked'; peer_id: string; reason: string }
  | { kind: 'frame'; from: string; data: number[] | Uint8Array }

/**
 * 对 Rust 那一侧的抽象。
 *
 * 抽出来不是为了将来换实现，是为了**能测**：`tools/p2p-selftest.ts` 里
 * 用一个内存里的假桥就能把整个同步流程跑一遍，不需要起 Tauri，也不需要
 * 真的开两个端口。
 */
export interface NetBridge {
  start(opts: { selfId: string; info: unknown }): Promise<number>
  stop(): Promise<void>
  send(peerId: string, payload: Uint8Array): Promise<void>
  broadcast(payload: Uint8Array): Promise<number>
  setInfo(info: unknown): Promise<void>
  announce(): Promise<void>
  /** 订阅事件。返回退订函数。 */
  subscribe(handler: (event: NetEvent) => void): () => void
}

// ---------------------------------------------------------------- 对外形状

export interface PeerView {
  id: string
  /** 显示名。来自对方的自我介绍，可能还没有。 */
  name: string
  addr: string | null
  connected: boolean
  lastSeenAt: number
}

export interface NodeStatus {
  running: boolean
  tcpPort: number | null
  /** 连上的对端数 */
  linked: number
  /** 局域网上看见的总人数（含没连上的） */
  discovered: number
  /** 本地日志里的事件条数 */
  events: number
}

export interface P2pNodeOptions {
  keys: IdentityKeys
  selfId: UserId
  log: EventLog
  clock: HybridClock
  net: NetBridge
  /** 自我介绍，给发现信标用。 */
  info?: unknown
  /** 状态重算后回调。**不是**每来一条事件就调一次，见 `scheduleRefold`。 */
  onState?: (state: P2pState) => void
  onPeers?: (peers: PeerView[]) => void
  onStatus?: (status: NodeStatus) => void
  /** 出了一件值得让用户知道的事（同步失败之类）。不传就静默。 */
  onProblem?: (text: string) => void
  /**
   * 文件字节的落脚处。不传就**完全不碰文件** —— 收发声明的 `file` 事件照常
   * 走，但字节不发也不收。这样只聊文字的场景不需要为文件付任何代价。
   */
  blobs?: BlobStore
  /** 某个文件的字节到齐了（含自己发出去的）。界面据此把占位换成真图。 */
  onBlob?: (meta: BlobMeta) => void
  /**
   * `sync` 令牌桶的参数。
   *
   * 生产上用默认值。之所以连时钟都要能注入：不注入的话「额度会随时间回填」
   * 这条不变式只能靠真等 `SYNC_REFILL_MS` 来验，而默认值是 5 秒 ——
   * 没人会为了一个断言睡 5 秒，结果就是这条只能留在注释里。
   * （`log.ts` 的 `maxEvents` 可注入是同一个理由。）
   */
  syncRate?: { bucket?: number; refillMs?: number; now?: () => number }
}

// ---------------------------------------------------------------- 节点

/** 一个对端在本地这一侧的样子。 */
interface PeerRecord {
  id: string
  addr: string | null
  info: unknown
  connected: boolean
  lastSeenAt: number
}

/**
 * 一帧 `blob-want` 最多认多少个 id。
 *
 * 接收侧**必须**自己设这个上限：`wire.ts` 的 `asStringArray` 允许 6 万个 id，
 * 而我们是逐 id 回一整帧 `blob-data` —— 于是约 1 MB 的请求能换最多 6 万帧
 * 出去。发送侧那个「64 一批」的礼貌是给**自己**定的，不能替对方设防。
 */
const MAX_BLOB_WANT_IDS = 128

/**
 * 同一个文件块，同一轮补发请求最少隔多久。
 *
 * 每收到一帧 `events` 就会调一次 `requestMissingBlobs`，而它要的是
 * 「所有已知、但本地还没有的」—— 没有退避的话，会话里只要有人发一条
 * 指向永不共享字节的 `file` 声明，此后**任何**对端的每一帧 events
 * 都会让我们再发一轮 blobs-want，永远不停。
 */
const BLOB_ASK_COOLDOWN_MS = 30_000

/** `blobsWeAsked` 的条数上限。到了就丢最老的几条，它只是个节流表。 */
const MAX_BLOB_ASK_MEMORY = 4_096

/**
 * 同一个对端能「连补几次日志」的额度，以及回填速度。
 *
 * `case 'sync'` 会回 `eventsTheyLack(log.all(), frame.have)`，也就是**整个日志**，
 * 而 `{t:'sync',have:[]}` 合法且只有约 25 字节。没有节流的话，一个对端可以线速
 * 重复它：一次出 ~50,000 条事件 / ~2-3MB / ~98 帧，而所有帧处理走**同一条全局
 * 串行队列**，于是其他所有对端的帧都排不进来 —— 一条 25 字节的包就能让整台机器
 * 的同步停摆。
 *
 * 为什么是**令牌桶**而不是「两次之间至少隔 N 秒」：后者会把正常流程里的一次
 * 重试也挡掉。链路建好后每个方向只发一次 `sync`，但 `markDirty` 会在「链路还在、
 * 只是这一帧没送出去」时退后 1.5 秒再补一次（那时对端只知道它缺东西，
 * 只能靠再问一次来拿）—— 一口气收紧成「5 秒一次」会让这种恢复迟迟拿不到数据。
 *
 * 为什么**不**限制「一次最多回多少条」：`sync` 只在握手和 markDirty 时触发，
 * 被截断的部分再没有第二次机会补，新上线的设备会永远卡在前 N 条上。
 * 令牌桶完整保留「补一次全量」这个语义，只掐掉重复。
 *
 * 3 次 / 每 5 秒回填一次：正常链路一次都碰不到，洪泛则从「每 25 字节换 98 帧」
 * 降到「每 5 秒换 98 帧」。
 */
const SYNC_BUCKET_SIZE = 3
const SYNC_REFILL_MS = 5_000

/** `syncBudget` 的条数上限。断开时删，这里只是兜底。 */
const MAX_SYNC_RATE_MEMORY = 1_024

export class P2pNode {
  private readonly keys: IdentityKeys
  private readonly selfId: UserId
  private readonly log: EventLog
  private readonly clock: HybridClock
  private readonly net: NetBridge
  private readonly blobs: BlobStore | null
  private readonly opts: P2pNodeOptions

  private readonly peers = new Map<string, PeerRecord>()
  /**
   * 每个文件「允许推给谁 / 谁来要才给」。
   *
   * 没有这张表的话，`shareBlob` 会把字节推给**所有连上的人**——而局域网上
   * 「连上的人」是随便谁。于是你发给甲的合同，乙也会收到一份完整拷贝，
   * 哪怕乙跟这个会话一点关系都没有。内容寻址不解决这个问题：哈希保证的是
   * 「这坨字节没被改过」，不是「只有该看的人能看」。
   *
   * 所以发的时候就把这个会话的成员记下来，推和取都按它过滤。
   */
  private readonly blobAudience = new Map<string, Set<string>>()

  /**
   * 我们**主动要过**的文件块：id → 最近一次要的时间。
   *
   * 两个用途，其实是同一件事的两面：
   *
   * - **收**的一侧：只有「我们要过」或者「日志里确实有它的声明」的
   *   `blob-data` 才收。不设这道闸的话，任何连上来的设备都能主动推字节，
   *   把仓库的 256 MB 灌满、把真文件挤出去；而哈希校验只保证「内容没被
   *   改过」，保证不了「我本来想要它」。
   * - **发**的一侧：见 `BLOB_ASK_COOLDOWN_MS`。
   */
  private readonly blobsWeAsked = new Map<string, number>()
  /**
   * 每个对端还剩多少「要我补日志」的额度。
   *
   * 见 `SYNC_BUCKET_SIZE`：这道闸门挡的是**重复**，不是**全量**。
   * 断开时会删掉自己那一项，所以重连立刻满额度。
   */
  private readonly syncBudget = new Map<string, { tokens: number; at: number }>()
  private readonly syncBucketSize: number
  private readonly syncRefillMs: number
  private readonly syncNow: () => number
  private unsubscribe: (() => void) | null = null
  /** 传输层事件的串行队列。见 `enqueue`。 */
  private chain: Promise<void> = Promise.resolve()

  private running = false
  private tcpPort: number | null = null
  private state: P2pState
  /** 折叠排队：见 `scheduleRefold`。 */
  private refoldScheduled = false
  private disposed = false

  constructor(opts: P2pNodeOptions) {
    this.opts = opts
    this.keys = opts.keys
    this.selfId = opts.selfId
    this.log = opts.log
    this.clock = opts.clock
    this.net = opts.net
    this.blobs = opts.blobs ?? null
    this.syncBucketSize = opts.syncRate?.bucket ?? SYNC_BUCKET_SIZE
    this.syncRefillMs = opts.syncRate?.refillMs ?? SYNC_REFILL_MS
    this.syncNow = opts.syncRate?.now ?? Date.now
    this.state = emptyState(this.selfId)
  }

  // -------------------------------------------------------------- 生命周期

  async start(): Promise<number> {
    if (this.running) return this.tcpPort ?? 0
    await this.log.open()
    await this.log.flush()

    this.unsubscribe = this.net.subscribe((event) => {
      // 事件处理是异步的（要验签），但**必须排队**，见 `enqueue`。
      this.enqueue(() => this.handleNetEvent(event))
    })

    this.tcpPort = await this.net.start({
      selfId: this.selfId,
      info: this.broadcastInfo(),
    })
    this.running = true
    this.refold()
    this.emitStatus()
    return this.tcpPort
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.net.stop()
    await this.log.flush()
    this.emitStatus()
  }

  /** 进程退出前调一次：把攒着没落盘的事件写下去。 */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  // -------------------------------------------------------------- 读

  getState(): P2pState {
    return this.state
  }

  listPeers(): PeerView[] {
    return [...this.peers.values()]
      .map((p) => ({
        id: p.id,
        name: nameOf(p.info) ?? this.state.people.get(p.id)?.name ?? '',
        addr: p.addr,
        connected: p.connected,
        lastSeenAt: p.lastSeenAt,
      }))
      .sort((a, b) => {
        // 连上的排前面，其次按名字，最后按 id —— 顺序必须稳定，
        // 否则列表每来一个事件就重排一次，用户点不着。
        if (a.connected !== b.connected) return a.connected ? -1 : 1
        if (a.name !== b.name) return a.name < b.name ? -1 : 1
        return a.id < b.id ? -1 : 1
      })
  }

  status(): NodeStatus {
    return {
      running: this.running,
      tcpPort: this.tcpPort,
      linked: [...this.peers.values()].filter((p) => p.connected).length,
      discovered: this.peers.size,
      events: this.log.size(),
    }
  }

  // -------------------------------------------------------------- 写

  /**
   * 造一条事件：签名 → 进本地日志 → 发给所有连上的人。
   *
   * 事件**先**进本地日志再发。顺序反过来的话，发送时对方立刻回一条引用它
   * 的事件，我们的折叠会因为找不到它而把它放进 deferred，界面一闪一稳。
   */
  async publish(kind: string, body: unknown): Promise<P2pEvent> {
    const payload = {
      author: this.selfId,
      ts: this.clock.tick(),
      kind,
      body,
    }
    const event = await signEvent(this.keys, payload)
    const result = await this.log.ingest(event)
    if (result !== 'new' && result !== 'duplicate') {
      throw new Error(`自己造的事件进不了本地日志：${result}`)
    }
    this.refold()
    await this.fanout(event)
    return event
  }

  /** 把一条事件直接送进去（不经签名）。测试与导入用。 */
  async inject(event: P2pEvent): Promise<void> {
    await this.log.ingest(event)
    this.refold()
  }

  /** 对方不在线时不要抛错 —— 这条事件会在下次重连的同步里补上。 */
  private async fanout(event: P2pEvent): Promise<void> {
    const payload = encodeFrame({ t: 'events', events: [event] })
    for (const peer of [...this.peers.values()]) {
      if (!peer.connected) continue
      try {
        await this.net.send(peer.id, payload)
      } catch {
        // 链路看着还在，但这一帧没送出去。同步不会自己重来，所以主动补一次。
        this.markDirty(peer.id)
      }
    }
  }

  /**
   * 跟某个对端重跑一次同步。
   *
   * 这是「链路还在但丢了一帧」的补救手段：把我们的 id 集合再报一遍，
   * 他算出差集、把缺的发回来 —— 不，方向反了：这一轮是为了让**他**知道
   * 我们有哪些、我们缺哪些。真正的补发由他收到 sync 后的 `events` 帧完成。
   */
  private async resync(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer?.connected) return
    try {
      await this.net.send(peerId, encodeFrame({ t: 'sync', have: this.logIds() }))
    } catch (err) {
      this.problem(`和 ${peerId.slice(0, 8)} 重新同步失败：${describe(err)}`)
    }
  }

  /**
   * 从某个对端的桶里取一枚令牌。取不到就说明它在洪泛。
   *
   * 首次见到的对端拿满额度（`prev` 为空时直接给 `SYNC_BUCKET_SIZE`），
   * 所以「刚连上、双方各补一轮」这种正常流程一次都不会被挡。
   */
  private takeSyncToken(peerId: string, now: number): boolean {
    const prev = this.syncBudget.get(peerId)
    let tokens = this.syncBucketSize
    let at = now
    if (prev) {
      const gained = Math.floor((now - prev.at) / this.syncRefillMs)
      tokens = Math.min(this.syncBucketSize, prev.tokens + gained)
      // 没有回填就不动 `at`，否则每次请求都把窗口往后推，桶永远填不回来。
      at = gained > 0 ? now : prev.at
    }
    if (tokens < 1) {
      this.syncBudget.set(peerId, { tokens, at })
      return false
    }
    this.syncBudget.set(peerId, { tokens: tokens - 1, at })
    // 兜底：断开时会删，但「只连过、没正常断开」的对端会留下来。
    while (this.syncBudget.size > MAX_SYNC_RATE_MEMORY) {
      const oldest = this.syncBudget.keys().next()
      if (oldest.done) break
      this.syncBudget.delete(oldest.value)
    }
    return true
  }

  private markDirty(peerId: string): void {
    // 不立刻重试：一次发送失败往往紧接着会失败第二次（对面正在崩），
    // 退后一拍让链路状态先稳定下来。真正断了的话 `unlinked` 会到，
    // 那时记录被标成离线，重连走的是正常的 linked → sync 路径。
    setTimeout(() => {
      if (!this.disposed) void this.resync(peerId)
    }, 1500)
  }

  // -------------------------------------------------------------- 传输层事件

  /**
   * 把传输层事件排成一条队，一次只处理一个。
   *
   * 为什么必须排队：`handleNetEvent` 里全是 `await`（验签、写日志），
   * 而 Rust 侧是一帧接一帧推过来的、**不等上一帧处理完**。不排队的话
   * 两次 `ingestMany` 会交叠执行，而它们内部读-改-写同一批 Map ——
   * 结果是同步 1100 条只落下来个位数，而且不报任何错。
   *
   * 这个 bug 只在「一次同步好多帧」时才出现，两三条消息的时候完全正常，
   * 所以必须在有上千条事件的用例里才抓得到。
   *
   * `this.chain.catch` 吞掉上一个任务抛的错：一个任务失败不该让整条队
   * 永久卡死 —— 后面还有正常的帧要处理。
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }

  private async handleNetEvent(event: NetEvent): Promise<void> {
    try {
      await this.dispatch(event)
    } catch (err) {
      // 收敛在这里：传输层的回调没有人在等它的 promise，
      // 抛出去就变成 unhandled rejection，还看不到是哪一帧坏的。
      this.problem(`处理传输层事件时出错：${describe(err)}`)
    }
  }

  private async dispatch(event: NetEvent): Promise<void> {
    switch (event.kind) {
      case 'discovered': {
        const id = event.peer.id
        if (id === this.selfId) return // 自己的组播包会被自己收到
        const existing = this.peers.get(id)
        this.peers.set(id, {
          id,
          addr: event.peer.addr ?? existing?.addr ?? null,
          // 信标里的自我介绍是**旧**的：握手带来的更新。已经在的人不要覆盖。
          info: existing?.info ?? event.peer.info,
          connected: existing?.connected ?? false,
          lastSeenAt: Date.now(),
        })
        this.emitPeers()
        this.emitStatus()
        return
      }

      case 'lost': {
        const peer = this.peers.get(event.id)
        if (!peer || peer.connected) return // 连着的人不算走了，链路那侧会报
        this.peers.delete(event.id)
        this.emitPeers()
        this.emitStatus()
        return
      }

      case 'linked': {
        const id = event.peer_id
        // 自称是**我本人**的链路一律不认。
        //
        // 对端 id 是它自己在 TCP 握手时填的，Rust 侧只校验「非空、不超长」，
        // 没有任何东西把它和公钥绑起来。而下面 `maySeeBlob()` 有一条
        // `peerId === selfId → true` 的捷径（本机取自己的文件用），于是
        // 一条 hello 里填上我的 id 就能同时骗到两件事：进 `peers` 表、
        // 并且让**任何** blob 的名单检查都直接通过 —— 之后 `shareBlob` 的
        // 推送循环会把字节原样推给这条链路。
        //
        // 字节在线上只是 base64，不是密文，所以这是数据外泄而不是拒绝服务。
        // 自己的组播包走的是上面 `discovered` 分支，那里本来就有同样的守卫。
        if (id === this.selfId) return
        this.peers.set(id, {
          id,
          addr: event.addr ?? null,
          info: event.info,
          connected: true,
          lastSeenAt: Date.now(),
        })
        this.emitPeers()
        this.emitStatus()
        // 握手刚成：先把我们的 id 集合报过去，让他算差集。
        await this.resync(id)
        // 顺手把「我缺的文件」也要一遍 —— 可能是他不在时别人发的，
        // 也可能是我刚启动、字节还没落盘。
        await this.requestMissingBlobs(id)
        return
      }

      case 'unlinked': {
        const peer = this.peers.get(event.peer_id)
        if (peer) {
          peer.connected = false
          peer.lastSeenAt = Date.now()
        }
        // 额度跟着链路走：重连后立刻能补一轮全量，不用等桶回填。
        this.syncBudget.delete(event.peer_id)
        this.emitPeers()
        this.emitStatus()
        this.problem(`${event.peer_id.slice(0, 8)} 断开了：${event.reason}`)
        return
      }

      case 'frame': {
        // ★ 「谁发来的」不能听帧自己说。
        //
        // `event.from` 是 Rust 那层转上来的一个字符串，而 hello 里的 id
        // 只校验了「非空、不超长」——没有任何东西把它和公钥绑起来。上面
        // `linked` 那道 `id === selfId` 的守卫保护的是 **peers 注册表**，
        // 挡不住这条**帧通道**：帧可以自称来自任何一个 id，包括我本人，
        // 也包括一个我从没连过、`peers` 里根本不存在的 id。
        //
        // 不在这里校验的话，绕过的东西很具体：
        //   · `maySeeBlob(id, from)` 里那句 `from === selfId → true` —— 拿到任意 blob；
        //   · `case 'sync'` —— 拿到整个日志；
        //   · `case 'blob-want'` —— 让本机把文件字节发回给那条链路。
        // 所以这里只认「已经握手成功、而且就在 peers 表里」的对端。
        if (event.from === this.selfId) {
          this.problem('收到一条自称来自我本人的帧，已忽略')
          return
        }
        const sender = this.peers.get(event.from)
        if (!sender?.connected) {
          this.problem(`收到一条来自未知对端 ${event.from.slice(0, 8)} 的帧，已忽略`)
          return
        }
        await this.handleFrame(event.from, toBytes(event.data))
        return
      }
    }
  }

  private async handleFrame(from: string, bytes: Uint8Array): Promise<void> {
    const frame = decodeFrame(bytes)
    if (!frame) {
      // 坏帧就丢掉这一帧。**不**断开链路：一次解析失败不该让一个人下线，
      // 何况发坏帧的可能正是被攻击的那一方。
      this.problem(`收到一帧看不懂的数据（来自 ${from.slice(0, 8)}），已忽略`)
      return
    }

    switch (frame.t) {
      case 'sync': {
        // ★ 节流。`{t:'sync',have:[]}` 只有约 25 字节，回礼却是整个日志
        // （最多 ~50,000 条 / ~98 帧）—— 不节流的话一个对端就能线速重复它，
        // 把所有其他对端的帧挤出那条全局串行队列。见 `SYNC_BUCKET_SIZE`。
        if (!this.takeSyncToken(from, this.syncNow())) {
          this.problem(`${from.slice(0, 8)} 补日志补得太频繁，这一轮跳过`)
          return
        }

        const missing = eventsTheyLack(this.log.all(), frame.have)
        if (frame.truncated) {
          // 对方的 id 集合被截断了，他报的「我有」是不完整的 ——
          // 我们按他说没有的发，会重复发一些他其实有的（无害，他会去重），
          // 但绝**不能**反过来相信「他有的我都发过了」。这里我们只发差集，
          // 方向是安全的。
          this.problem(`对端 ${from.slice(0, 8)} 的事件太多，本轮同步是部分的`)
        }
        for (const chunk of chunkEvents(missing)) {
          try {
            await this.net.send(from, encodeFrame(chunk))
          } catch (err) {
            this.problem(`给 ${from.slice(0, 8)} 补发历史失败：${describe(err)}`)
            return
          }
        }
        return
      }

      case 'events': {
        const { counts } = await this.log.ingestMany(frame.events)
        // 「收下」= new + deferred。deferred 是**已经进日志**的（只是还不能
        // 验签，等作者的 profile 到了再说），所以它算收下、不算拒绝 ——
        // 把它算成拒绝会给用户报一堆假的「有人发坏数据」。
        const accepted = counts.new + counts.deferred
        const rejected = counts.malformed + counts['bad-id'] + counts['bad-sig']
        if (accepted > 0) {
          this.scheduleRefold()
          // 新事件里可能有「某个文件的声明」而本地没有那坨字节 —— 要一次。
          //
          // 这里必须先让出一次微任务：折叠是**排队**的（`scheduleRefold`），
          // 而 `requestMissingBlobs` 读的是折叠结果 `this.state`。不让出的话
          // 读到的是上一轮的旧状态，于是「刚收到的这条文件声明」压根看不见，
          // 字节永远不会被要 —— 表现是文件气泡一直转圈，而且不报错。
          await Promise.resolve()
          await this.requestMissingBlobs(from)
        }
        if (rejected > 0) {
          // 拒绝是信息安全信号，不是噪音：有人在发验不过签的东西。
          this.problem(`从 ${from.slice(0, 8)} 收到 ${rejected} 条验不过的事件，已拒绝`)
        }
        return
      }

      case 'ping': {
        try {
          await this.net.send(from, encodeFrame({ t: 'pong', ts: frame.ts }))
        } catch {
          // 回声发不出去说明链路已经不行了，下一拍 unlinked 会到。
        }
        return
      }

      case 'pong': {
        // 目前不用。留在这里是为了让 switch 穷尽 —— 漏掉一个分支时
        // TS 会在下面报错，而不是让我们悄悄忽略一种新帧。
        return
      }

      case 'blob-want': {
        if (!this.blobs) return
        // 上限在**我们**这一侧：对方可以往一帧里塞 6 万个 id，而我们是
        // 逐 id 回一整帧 `blob-data`。不封顶就等于给了对方一个放大器。
        const asked = frame.ids.slice(0, MAX_BLOB_WANT_IDS)
        if (frame.ids.length > MAX_BLOB_WANT_IDS) {
          this.problem(`${from.slice(0, 8)} 一次要了 ${frame.ids.length} 个文件，只处理前 ${MAX_BLOB_WANT_IDS} 个`)
        }
        for (const id of asked) {
          const bytes = this.blobs.get(id)
          if (!bytes) continue // 我也没有。**不转发**，也不回「没有」——
          // 「要不到」和「要到了」在发送方那边是同一件事：他会在下一个
          // 连上的人那里再要一次。专门回一个否定帧只会多一种要处理的帧。
          //
          // 但我**有**、他不是这个会话的人 —— 那就装作没有：既不转发
          // 也不报错。回一句「你不该要」等于告诉他这儿确实有这份东西。
          if (!this.maySeeBlob(id, from)) continue
          const meta = this.blobs.meta(id)
          try {
            await this.net.send(
              from,
              encodeFrame({
                t: 'blob-data',
                id,
                b64: encodeBlob(bytes),
                name: meta?.name || undefined,
                mime: meta?.mime || undefined,
              }),
            )
          } catch (err) {
            this.problem(`给 ${from.slice(0, 8)} 发文件失败：${describe(err)}`)
            return
          }
        }
        return
      }

      case 'blob-data': {
        if (!this.blobs) return
        await this.handleBlobData(from, frame.id, frame.b64, frame.name, frame.mime)
        return
      }
    }
  }

  /**
   * 收下一个文件块。
   *
   * **先验哈希再落库**：`id` 是对端写在帧里的，他可以写错，也可以故意把
   * 一张图说成另一张的 id —— 那样接收方就会用假内容盖掉已有的那一份。
   * 内容寻址的好处正是在这里兑现：校验不需要另立字段，重算一遍就行。
   */
  private async handleBlobData(
    from: string,
    id: string,
    b64: string,
    name?: string,
    mime?: string,
  ): Promise<void> {
    const store = this.blobs
    if (!store) return

    // ★ 只收**我们要过的**、或者**日志里确实有它声明**的那些。
    //
    // 不做这一步的话，任何连上来的设备都能主动推字节 —— 它能把 256 MB 的
    // 仓库灌满、把真文件挤出去，还能把自己的显示名/MIME 写进我们的仓库
    // 元信息。哈希校验挡不住这个：它保证的是「内容没被改过」，不是
    // 「我本来想要它」。（对比：出站那两条路径都老老实实过了名单。）
    if (!this.blobsWeAsked.has(id) && !this.isDeclaredBlob(id) && !this.blobAudience.has(id)) {
      this.problem(`${from.slice(0, 8)} 推来一份我们没要过的文件，已忽略`)
      return
    }

    const bytes = decodeBlob(b64)
    if (!bytes) {
      this.problem(`${from.slice(0, 8)} 发来的文件解不开，已丢弃`)
      return
    }
    if (!(await blobMatches(id, bytes))) {
      this.problem(`${from.slice(0, 8)} 发来的文件内容和它的 id 对不上，已丢弃`)
      return
    }
    if (!store.put(id, bytes)) {
      // 只有一种情况走到这里：超过了仓库的总量上限。
      this.problem('本地文件空间不够，有一个文件没能收下')
      return
    }
    // 名字/MIME 来自事件或发送方，**字节优先**：即使没有元信息，
    // 这坨内容也已经可用（比如是一张能被嗅探出类型的图）。
    store.describe(id, { name, mime, size: bytes.length })
    this.opts.onBlob?.(store.meta(id) ?? { id, size: bytes.length, name: name ?? '', mime: mime ?? '' })
  }

  /**
   * 把「事件里提到、但我手里没有」的文件块要一遍。
   *
   * 这就是**离线文件**的补发路径，而且它不需要任何队列：对方离线时发的文件，
   * 声明（`file` 事件）早就随同步过来了，字节在他上线后按需拉。
   * 换句话说，「离线收发文件」和「离线收发消息」走的是同一条思路 ——
   * 状态由集合差决定，不由「我记不记得发过」决定。
   */
  private async requestMissingBlobs(peerId: string): Promise<void> {
    const store = this.blobs
    if (!store) return
    const now = Date.now()
    const want: string[] = []
    for (const message of this.state.messages.values()) {
      if (!message.fileId || store.has(message.fileId)) continue
      const askedAt = this.blobsWeAsked.get(message.fileId)
      if (askedAt !== undefined && now - askedAt < BLOB_ASK_COOLDOWN_MS) continue
      want.push(message.fileId)
    }
    await this.wantBlobs(peerId, want)
  }

  /**
   * 向某个对端索取文件块。
   *
   * 特意做成公开的：索取这件事要**记账**（见 `blobsWeAsked`），而记账只能
   * 发生在真正把 `blob-want` 发出去的那个地方。绕过去自己手搓一帧的话，
   * 对方的回复到了会被当成「我们没要过的推送」拒掉 —— 记的是「要过」，
   * 不是「想要」。
   */
  async wantBlobs(peerId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    if (!this.peers.get(peerId)?.connected) return

    // 分批：一个 `blob-want` 列几千个 id 会把帧撑大，也没有意义 ——
    // 对端会按同一批回同样多的帧，他那边也没快多少。
    const now = Date.now()
    for (let i = 0; i < ids.length; i += 64) {
      const chunk = ids.slice(i, i + 64)
      try {
        await this.net.send(peerId, encodeFrame({ t: 'blob-want', ids: chunk }))
      } catch (err) {
        this.problem(`向 ${peerId.slice(0, 8)} 索取文件失败：${describe(err)}`)
        return
      }
      // 发出去才算「要过」：失败的话下一轮还要重试。
      for (const id of chunk) this.blobsWeAsked.set(id, now)
    }
    // 只是个节流表，长了就丢最老的几条（Map 保持插入顺序）。
    while (this.blobsWeAsked.size > MAX_BLOB_ASK_MEMORY) {
      const oldest = this.blobsWeAsked.keys().next().value
      if (oldest === undefined) break
      this.blobsWeAsked.delete(oldest)
    }
  }

  // -------------------------------------------------------------- 文件

  /**
   * 把一个文件交给节点：登记元信息、把字节发给**这个会话的成员**。
   *
   * 返回它的 id（= 内容哈希）。**调用方负责再发一条 `file` 事件** ——
   * 字节走链路（只给该看的人），声明走日志（会同步给所有人，
   * 包括此刻不在线的那位）。两件事分开之后，「发给一个不在线的人」
   * 不需要特殊处理：他上线时看到声明，然后按 id 来要字节。
   *
   * `audience` 是这个会话的成员 id。**必须传**：不传就等于推给所有连上的人，
   * 局域网上任何人都能拿到你发的每一份文件的完整字节。空数组是合法的 ——
   * 一个人都不推，等他们看到声明自己来要。
   */
  async shareBlob(
    bytes: Bytes,
    name: string,
    mime: string,
    audience: readonly string[] = [],
  ): Promise<string | undefined> {
    const store = this.blobs
    if (!store) return undefined

    const id = await blobIdOf(bytes)
    if (!store.put(id, bytes)) {
      this.problem('本地文件空间不够，这个文件没能共享出去')
      return undefined
    }
    store.describe(id, { name, mime, size: bytes.length })

    // 同一坨字节可以被只共享给甲、又被共享给乙（内容寻址下 id 相同）。
    // 直接 `set` 会把第一个人**踢出名单** —— 他明明该看到，却在下一轮
    // 推送和索取时被当成局外人。所以是并集，不是覆盖。
    const known = this.blobAudience.get(id)
    if (known) {
      for (const member of audience) known.add(member)
    } else {
      this.blobAudience.set(id, new Set(audience))
    }

    const frame = encodeFrame({ t: 'blob-data', id, b64: encodeBlob(bytes), name, mime })
    for (const peer of this.peers.values()) {
      if (!peer.connected) continue
      if (!this.maySeeBlob(id, peer.id)) continue
      try {
        await this.net.send(peer.id, frame)
      } catch (err) {
        // 发给一个人失败**不阻断**发给其他人：这正是「离线的人上线后会来要」
        // 的设计前提，少发一次只是让他多等一个来回。
        this.problem(`给 ${peer.id.slice(0, 8)} 发文件失败：${describe(err)}`)
      }
    }
    return id
  }

  /**
   * 这个对端能不能拿这个文件的字节。
   *
   * 一律**只认记录下来的那份名单**。名单里没有的 id —— 包括「这个文件不是
   * 我共享出去的」（表里查不到）—— 一律不放。
   *
   * 曾经这里有一条 `peerId === selfId → true` 的捷径（说是本机取自己的文件
   * 用），已经删掉：本机取文件走的是 `getBlob`，根本不经过这条判断，所以它
   * 从来不是给自用的 —— 它只是一条「谁自称是我，谁就通行」的fail-open。
   * 真正挡住自称本人的那道闸在 `case 'frame'` 和 `case 'linked'`，但不该
   * 让第二道防线赌第一道不出错。
   */
  private maySeeBlob(id: string, peerId: string): boolean {
    return this.blobAudience.get(id)?.has(peerId) ?? false
  }

  /** 日志里有没有一条 `file` 声明指向这个文件块。 */
  private isDeclaredBlob(id: string): boolean {
    for (const message of this.state.messages.values()) {
      if (message.fileId === id) return true
    }
    return false
  }

  /** 取一个文件块。界面要显示图片 / 保存文件时调。 */
  getBlob(id: string): Bytes | undefined {
    return this.blobs?.get(id)
  }

  // -------------------------------------------------------------- 折叠

  private logIds(): string[] {
    return this.log.all().map((e) => e.id)
  }

  /**
   * 排一次重算，而不是立刻算。
   *
   * 一次同步会连着来好几帧（512 条一帧），每帧都重算一遍整个状态是
   * O(帧数 × 事件总数)。排到微任务里合并成一次，代价降到 O(事件总数)。
   */
  private scheduleRefold(): void {
    if (this.refoldScheduled) return
    this.refoldScheduled = true
    void Promise.resolve().then(() => {
      this.refoldScheduled = false
      this.refold()
    })
  }

  private refold(): void {
    this.state = fold(this.log.all(), this.selfId)
    this.opts.onState?.(this.state)
    this.emitPeers()
  }

  /**
   * 等这里彻底闲下来：串行队列排空、折叠也追上了。
   *
   * 判断标准是**队列的引用没变**，而不是「队列跑完了」—— 队列最后一步
   * 的处理过程里可能又收到一帧、把 `this.chain` 换成一条新的，那种情况下
   * 只等旧的那条会提前返回。
   *
   * 生产代码不需要调它（界面是靠回调驱动的），测试需要。
   */
  async settled(): Promise<void> {
    for (let i = 0; i < 100_000; i++) {
      const chain = this.chain
      await chain
      if (this.chain === chain && !this.refoldScheduled) return
    }
  }

  // -------------------------------------------------------------- 播报

  private broadcastInfo(): unknown {
    const info = this.opts.info
    const base =
      info && typeof info === 'object' && !Array.isArray(info)
        ? { ...(info as Record<string, unknown>) }
        : {}
    return base
  }

  private emitPeers(): void {
    this.opts.onPeers?.(this.listPeers())
  }

  private emitStatus(): void {
    this.opts.onStatus?.(this.status())
  }

  private problem(text: string): void {
    this.opts.onProblem?.(text)
  }
}

// ---------------------------------------------------------------- 小工具

function toBytes(data: number[] | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : Uint8Array.from(data)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 从自我介绍里读名字。字段名宽容一点：这里不是安全边界。 */
function nameOf(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const record = info as Record<string, unknown>
  for (const key of ['name', 'nickname', 'displayName']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

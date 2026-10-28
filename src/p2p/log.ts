/**
 * 本地事件日志 —— 每个节点的「事实来源」。
 *
 * ## 它在整个系统里的位置
 *
 *     TCP 帧  →  log.ingest(事件)  →  fold(log.all())  →  React 状态
 *                      ↑
 *                 别的对端转发来的事件
 *
 * 没有服务器，所以没有人能「权威地」回答「这条消息存在吗」。
 * 替代方案是：**每个人自己存一份，互相补**。这个模块就是那个「自己存的」。
 *
 * ## 三件必须做对的事
 *
 * ### 1. 去重只靠 id
 *
 * 同一条事件会从多条路径到达（A 直接发给我、B 又转发给我）。判断
 * 「这条我有没有」的唯一依据是 `id` —— 它是内容哈希，同一份内容在哪里
 * 算出来都一样。于是既不需要问对端、也不需要「已读回执」这类协调。
 *
 * ### 2. 验签，而且允许**乱序到达**
 *
 * 这是最容易写错的地方。事件的签名要拿作者的公钥来验，而公钥藏在
 * 作者的 `profile` 事件里。网络里这两条事件的到达顺序**没有任何保证**：
 * 转发的路径不同、某条先被丢掉又重传，都会让「消息先到、profile 后到」。
 *
 * 如果消息到了但验不了就直接丢弃，那这条消息**永远不会再出现**
 * （对端以为你有了，因为它在同步时看到的是「我发过了」），
 * 症状就是「偶尔丢消息」—— 极难复现，也极难查。
 *
 * 所以这里把验不了的事件**先收进 `deferred`**，等作者的 profile 到了
 * 再回头验一遍。`profile` 本身是自证的（公钥就在事件体里，
 * 且 `author` 是这两个公钥的哈希），所以它能打破这个循环。
 *
 * ### 3. 对端不可信
 *
 * 事件从网络来，可能是坏的、过大的、恶意构造的。所以：
 *   - 每条都过 `isWellFormedEvent`（类型 + 长度上限）；
 *   - 验签失败的**不存储、不转发**；
 *   - 单作者积压有上限，防止「用一堆验不了的事件把我内存撑爆」；
 *   - 总量有上限，到顶后拒绝新事件并**如实报告**，而不是静默丢弃。
 */

import { fromB64 } from '../crypto/core'
import type { PublicIdentity } from '../crypto/keys'
import { importPublicEd } from '../crypto/keys'
import { canonicalBytes } from './canonical'
import {
  compareEvents,
  eventIdMatches,
  identityOf,
  isWellFormedEvent,
  payloadOf,
  stripExtraEventKeys,
  verifyEvent,
} from './event'
import { MAX_EVENT_BYTES, roughEventBytes } from './event'
import type { KeyLookup, P2pEvent, UserId } from './event'
import type { HybridClock } from './hlc'

// ---------------------------------------------------------------- 存储

/**
 * 日志的落盘接口。
 *
 * 只有三个动作，故意做得这么窄：**追加**是常态（一条新事件），
 * **读全量**只在启动时发生一次，**重写**只在压缩时发生（很少）。
 *
 * 为什么不是「随便一个 key-value」：因为事件日志是**追加**的，
 * 每次新事件都重写一遍整个文件是 O(n²) —— 两万条事件就是四亿次
 * 字符串拼接，够卡住主线程好几秒。追加接口让常见路径是 O(1)。
 */
export interface LogStore {
  read(): Promise<string[]>
  append(line: string): Promise<void>
  rewrite(lines: string[]): Promise<void>
}

/** 内存实现。自测用，也是「存储坏了」时的兜底。 */
export class MemoryStore implements LogStore {
  private lines: string[] = []

  async read(): Promise<string[]> {
    return [...this.lines]
  }
  async append(line: string): Promise<void> {
    this.lines.push(line)
  }
  async rewrite(lines: string[]): Promise<void> {
    this.lines = [...lines]
  }
}

// ---------------------------------------------------------------- 上限

/**
 * 单作者最多积压多少条**验不了**的事件。
 *
 * 256 是「正常情况下永远到不了」的量级：只有当一个人的 profile 和
 * 几百条消息一起涌来时才可能碰到。真到了说明要么对端行为异常，
 * 要么自己的同步逻辑有问题 —— 两种情况都不该继续无限吃内存。
 */
const MAX_DEFERRED_PER_AUTHOR = 256

/** 一共记着多少个「还没见过 profile」的作者。防的是伪造大量身份的洪水。 */
const MAX_DEFERRED_AUTHORS = 512

/**
 * 「验不了」的事件一共能占多少条 —— 和 `MAX_LOG_EVENTS` 分开算、按全局最旧淘汰。
 *
 * 分开的理由是威胁模型，不是内存：`deferred` 里装的全是**没有任何签名背书**
 * 的东西（作者未知就不验签，见 `ingest` 末尾），所以它的上限是整个日志里
 * 唯一一个「陌生人发一条就吃一口」的预算。两者合在一起时，局域网上随便
 * 一个连接只要冲 5 万条 author 随机的事件，就能把预算吃光 —— 此后**真实
 * 对端的事件一律 `'full'` 被拒**，同步永久失效，而那 5 万条还全是垃圾。
 *
 * 取 4000（日志的 8%）：正常情况下 `deferred` 只在「profile 和它自己的
 * 几百条消息一起涌来」时才有货，几百条就到顶了，4000 给足了余量。
 */
const MAX_DEFERRED_EVENTS = 4_000

/** 日志总量上限。到了就拒绝新事件并如实报告，不静默丢。 */
export const MAX_LOG_EVENTS = 50_000

// ---------------------------------------------------------------- 结果

/**
 * 一条事件处理完之后的状态。
 *
 * 分得这么细是为了**能报告给用户看**：同步时「收到 500 条、接受 12 条」
 * 和「收到 500 条、拒绝 488 条」是完全不同的两件事，前者正常，
 * 后者说明有人在发坏数据（或者自己解析错了）。合成一个布尔值就看不出来了。
 */
export type IngestResult =
  | 'new' // 收下了
  | 'deferred' // 收下了，但还验不了（作者的 profile 没到）
  | 'duplicate' // 已经有了
  | 'malformed' // 结构就不对
  | 'bad-id' // id 和内容对不上
  | 'bad-sig' // 签名不对
  | 'full' // 日志满了

// ---------------------------------------------------------------- 日志

export class EventLog {
  /** 验过签、可以放心使用的事件。id → 事件。 */
  private readonly verified = new Map<string, P2pEvent>()
  /** 已经收到、暂时验不了的事件。作者 → (id → 事件)。 */
  private readonly deferred = new Map<UserId, Map<string, P2pEvent>>()
  /**
   * `deferred` 里全部 id → 作者。
   *
   * 它存在的唯一理由是**成本**：`ingest` 每收一条都要问两次「这条是不是
   * 积压着」和「积压了多少」，照原来的写法这两问各自遍历所有作者桶 ——
   * 桶最坏 512 个、桶内最坏 256 条，于是一帧 5 万条事件就是几十亿次
   * `Map.has`，全在 `node.ts` 那条**串行队列**里、在主线程上。
   * 攻击者发一帧，你要算十亿次 —— 成本完全不对称。
   *
   * 这张表让两问都变成 O(1)。代价是它必须和 `deferred` 严格同步：
   * 桶淘汰、桶内淘汰、`flushDeferred` 三处都要跟着删。
   */
  private readonly deferredIds = new Map<string, UserId>()
  /** 作者 → Ed25519 公钥（base64）。来源只有一条：验过的 profile 事件。 */
  private readonly keys = new Map<UserId, string>()
  /** 按 `compareEvents` 排好的 id 列表。`verified` 的键序就是它。 */
  private order: string[] = []

  private readonly store: LogStore
  /**
   * 已验证集合的上限。默认 `MAX_LOG_EVENTS`。
   *
   * 之所以是个可传的参数：`open()` 在日志满时的行为（丢老的还是丢新的）
   * 是本次审查里修掉的一个真丢数据的 bug，而验证它需要「文件比上限长」。
   * 上限写死 5 万时，这条测试要造 5 万条真签名事件 —— 跑不起，于是那个
   * bug 一直没人测。测试里传个 10 就能把同一段逻辑走一遍。
   */
  private readonly maxEvents: number
  /**
   * 本节点的混合逻辑时钟。收下每一条**验过签**的事件时都要 `observe` 一下。
   *
   * `hlc.ts` 的文档承诺「收到别人的时间戳就追上去、两台机器会收敛到一起」，
   * 而这句话在本次审查里是**假的** —— 全仓 `.observe(` / `.restore(` 零调用点，
   * 于是每个节点的 ts 实际就是「自己的墙上时钟 × 1000 + 本地序号」：
   * 表快的机器**永久**赢下每一次冲突，没有任何纠正机制。
   *
   * 放在 `accept` 而不是 `ingest` 上，是因为只有验过签的 `ts` 才值得相信：
   * 在 `ingest` 上做，任何陌生人都能靠伪造事件把我的时钟往前推。
   *
   * 这样也叫「重启后从事件日志里把时钟补回来」成立 —— `open()` 逐条 `ingest`
   * 历史上所有事件，`observe` 是取最大值的，所以读完日志时钟至少推到了
   * 日志里的最大 `ts`，不会再出现「重启后自己新发的消息插到自己旧消息前面」。
   * 因此**不需要**额外持久化时钟：`peek()` 至今没有调用方，日志本身就够了。
   */
  private readonly clock: HybridClock | undefined
  /** 攒着还没落盘的行。小批量合并，避免每条事件都碰一次磁盘。 */
  private pendingWrites: string[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(
    store: LogStore = new MemoryStore(),
    options: { maxEvents?: number; clock?: HybridClock } = {},
  ) {
    this.store = store
    this.maxEvents = options.maxEvents ?? MAX_LOG_EVENTS
    this.clock = options.clock
  }

  /** 从存储恢复。必须在 `ingest` 之前调用一次。重复调用是安全的。 */
  async open(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let lines: string[] = []
    try {
      lines = await this.store.read()
    } catch {
      // 读不出来（文件被删、权限坏了）就当空日志开始。
      // 不抛错：此时抛错会让整个应用起不来，而「从空开始」至少能用 ——
      // 同步会从对端把历史拉回来。
      return
    }
    // 顺序要紧：profile 可能排在消息后面。先全量 ingest 一遍，
    // `deferred` 机制会把顺序问题消化掉。
    //
    // **倒着来**：`ingest` 在日志满时如实返回 `'full'` 并丢掉那条事件，
    // 而正着 ingest 时活下来的恰好是文件里最靠前的 5 万条 —— `compact()`
    // 之后文件正是 `(ts, id)` 升序，也就是说被丢掉的**永远是最新的**，
    // 重启一次就丢一次最近的聊天记录。倒着 ingest，进来先占座的是最新的，
    // 被挤掉的换成了最老的（那些通常已经没什么用，而且更容易从对端再拉回来）。
    // 顺序本身不影响正确性：`accept` 走 `insertSorted`，而 profile 与消息
    // 的先后由 `deferred` 负责，与 ingest 次序无关。
    for (const line of [...lines].reverse()) {
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        continue // 半行 / 坏行：跳过，不让它拖垮整个启动
      }
      await this.ingest(raw)
    }
  }

  /** 给 `verifyEvent` 用的公钥查询。 */
  lookup: KeyLookup = (author) => this.keys.get(author)

  /**
   * 收一条事件。
   *
   * 这是整个模块的门 —— 所有外部数据都从这里进来，所以所有校验也都在这里。
   */
  async ingest(raw: unknown): Promise<IngestResult> {
    if (!isWellFormedEvent(raw)) return 'malformed'

    // 体积关。放在验签和入库**之前** —— 这两步都要为整条事件再分配一次
    // （`canonicalBytes` 走一遍、日志里留一份），而一条超限的事件无论真假
    // 都只是浪费。发送侧 `signEvent` 里有一道 128 KB 的，但那只管我们自己
    // 造的事件；这一道管别人送来的。
    if (roughEventBytes(raw) > MAX_EVENT_BYTES) return 'malformed'

    // 剥掉签名覆盖不到的顶层字段（见 `stripExtraEventKeys`）。
    //
    // 放在体积关**之后**：要量的是对端真实发来的那一份。先剥再量的话，
    // 一堆垃圾字段就等于白送 —— 它撑大了帧，却不算进这条事件的账。
    //
    // 换一个 `const` 而不是回写 `raw`：类型守卫的收窄不会穿过赋值，
    // 回写之后 `raw` 又变回 `unknown`，后面每一处都得再断言一次。
    const event = stripExtraEventKeys(raw)

    if (this.verified.has(event.id) || this.deferredIds.has(event.id)) return 'duplicate'
    if (this.verified.size >= this.maxEvents) return 'full'

    // —— profile 是自证的，可以独立于 `keys` 表验证。
    if (event.kind === 'profile') {
      const ok = await this.verifyProfile(event)
      if (ok === 'ok') {
        this.accept(event)
        // **等**积压的事件放完再返回。
        //
        // 这里早期版本写的是 `void this.flushDeferred(...)`（不等待），
        // 结果是 `await ingest(profile)` 返回时消息还没被放出来 ——
        // 调用方看到的是「收下了 profile，但之前的消息不见了」，
        // 而它们其实在下一个微任务里才出现。同步推进到「这一批事件
        // 全都处理完」才符合调用方的直觉，也才让自测能断言这件事。
        await this.flushDeferred(event.author)
        return 'new'
      }
      return ok
    }

    // —— 其余事件需要作者的公钥。
    if (this.keys.has(event.author)) {
      // 先分「内容被改过」和「签名不对」——前者是传输/存储坏了，后者是
      // 有人在冒充。两者都丢，但报给用户的话完全不同。
      if (!(await eventIdMatches(event))) return 'bad-id'
      const ok = await verifyEvent(event, this.lookup)
      if (!ok) return 'bad-sig'
      this.accept(event)
      return 'new'
    }

    // 作者是谁还不知道 —— 存起来，等 profile 到了再验。
    //
    // 注意这里**没有验签**，所以它进的是 deferred 而不是 verified：
    // 它现在还不能被信任，也就不能拿去喂 fold。
    this.defer(event)
    return 'deferred'
  }

  /** 批量收。返回值里的 `counts` 适合直接拿去做「同步完成」的提示。 */
  async ingestMany(raws: readonly unknown[]): Promise<{
    results: IngestResult[]
    counts: Record<IngestResult, number>
  }> {
    const results: IngestResult[] = []
    const counts = {
      new: 0,
      deferred: 0,
      duplicate: 0,
      malformed: 0,
      'bad-id': 0,
      'bad-sig': 0,
      full: 0,
    } satisfies Record<IngestResult, number>
    for (const raw of raws) {
      const result = await this.ingest(raw)
      results.push(result)
      counts[result] += 1
    }
    return { results, counts }
  }

  /**
   * 验一条 profile 事件。
   *
   * profile 之所以能自证：它的 `author` 就是 `{ed, x}` 两个公钥的哈希，
   * 而公钥本身在 `body` 里。于是任何人都能自己算一遍：
   *
   *   1. `author === numberOf({ed, x})` —— 名字确实是这两把钥匙的名字；
   *   2. 签名能用 `ed` 验过 —— 持有私钥的人确实是这条的作者。
   *
   * 两条都过，就证明了「发这条事件的人，就是它自称的那个人」，
   * 不需要任何第三方背书。这也是为什么不需要名册服务器。
   */
  private async verifyProfile(event: P2pEvent): Promise<'ok' | 'bad-id' | 'bad-sig'> {
    const body = event.body as Partial<PublicIdentity> | null
    if (!body || typeof body.ed !== 'string' || typeof body.x !== 'string') return 'bad-id'
    if (!body.ed || !body.x) return 'bad-id'

    let derived: string
    try {
      derived = await identityOf({ ed: body.ed, x: body.x })
    } catch {
      return 'bad-id' // 公钥不是合法 base64
    }
    if (derived !== event.author) return 'bad-id'

    try {
      const key = await importPublicEd(body.ed)
      const bytes = canonicalBytes(payloadOf(event))
      const ok = await crypto.subtle.verify('Ed25519', key, fromB64(event.sig), bytes)
      if (!ok) return 'bad-sig'
    } catch {
      return 'bad-sig'
    }

    // 到这里这条 profile 是真的。记下公钥，并把这位作者积压的事件放出来。
    const previous = this.keys.get(event.author)
    if (previous && previous !== body.ed) {
      // 同一个 author 出现两把不同的 ed 公钥 —— 只有哈希碰撞才可能，
      // 而撞了就意味着这个身份被两个人同时主张。此时**不能**悄悄换掉
      // 已经信任的钥匙（那等于让攻击者劫持一个已有身份），
      // 只能拒收。正常使用中永远不会发生。
      return 'bad-id'
    }
    this.keys.set(event.author, body.ed)
    return 'ok'
  }

  /** 把 `deferred` 里属于这个作者的事件放出来重验。 */
  private async flushDeferred(author: UserId): Promise<void> {
    const bucket = this.deferred.get(author)
    if (!bucket) return
    this.deferred.delete(author)
    // **按时间倒序**，而且这里也必须自己看一眼上限。
    //
    // `accept` 是不查上限的（上限原本只在 `ingest` 那个入口上），所以
    // 积压放出来的这条路可以整个绕过它 —— 灌满 deferred 再发一条 profile，
    // 就能把 5 万条一次性塞进已验证集合。而 `open()` 正好走的也是这条路。
    //
    // 倒序是为了和 `open()` 的方向一致：满了就留下来最新的那批。
    const events = [...bucket.values()].sort((a, b) => compareEvents(b, a))
    for (const event of events) {
      this.deferredIds.delete(event.id)
      if (this.verified.has(event.id)) continue
      if (this.verified.size >= this.maxEvents) continue // 满了：剩下的丢掉
      // 到了这一步公钥一定在 `keys` 里（调用点刚写进去）。
      if (await verifyEvent(event, this.lookup)) this.accept(event)
      // 验不过的直接丢 —— 这时已经有公钥了，验不过是确定的，
      // 留着只会白占内存。
    }
  }

  private defer(event: P2pEvent): void {
    let bucket = this.deferred.get(event.author)
    if (!bucket) {
      if (this.deferred.size >= MAX_DEFERRED_AUTHORS) {
        // 作者太多。丢掉最老的一个桶 —— 反正它的 profile 迟早会再来，
        // 那时这条路径会重新走一遍。
        const oldest = this.deferred.keys().next().value
        if (oldest !== undefined) {
          for (const gone of this.deferred.get(oldest)?.keys() ?? []) this.deferredIds.delete(gone)
          this.deferred.delete(oldest)
        }
      }
      bucket = new Map()
      this.deferred.set(event.author, bucket)
    }
    bucket.set(event.id, event)
    this.deferredIds.set(event.id, event.author)

    // 先放进来，**再**淘汰 —— 两道上限都是这个次序。
    //
    // 次序不是风格问题：先淘汰再插入时，插进来的那条永远不会被它自己
    // 触发的那次淘汰赶走，于是「倒着读文件」会把刚读进来的最新一条留下、
    // 却把该留的次新一条挤掉（`open()` 是倒着读的，见那里的注释）。
    // 先插入再淘汰，被丢的永远是**当前最小**的那条，方向就无关了。

    if (bucket.size > MAX_DEFERRED_PER_AUTHOR) {
      // 丢**时间上最老**的那条。
      //
      // 按 `compareEvents` 找，不是按插入顺序拿下标 0：插入顺序只在
      // 「按到达顺序灌进来」时才等于时间顺序，而 `open()` 恰恰是倒着
      // 读文件的。
      let oldestId: string | undefined
      let oldestEvent: P2pEvent | undefined
      for (const [id, candidate] of bucket) {
        if (!oldestEvent || compareEvents(candidate, oldestEvent) < 0) {
          oldestEvent = candidate
          oldestId = id
        }
      }
      if (oldestId !== undefined) {
        bucket.delete(oldestId)
        this.deferredIds.delete(oldestId)
      }
    }

    // ★ 全局硬上限，必须**独立于**上面那道按作者的淘汰。
    //
    // 「作者少、每人很多条」的洪水下，按作者淘汰每次只放走一条；而
    // 「作者多、每人一条」的洪水下，它一次放走整整一桶、一进一出，
    // `deferredIds.size` 永远卡在 `MAX_DEFERRED_AUTHORS`（512）上看着
    // 很乖，总量却可以长到 512 × 256 = 13 万条 —— 比整个日志的 5 万还多。
    // 所以这里按**全局最旧**再钉一道，把总量钉死在 `MAX_DEFERRED_EVENTS`。
    //
    // 淘汰而不是拒收（不返回 `'full'`）：这些都是没验过签的东西，丢哪条
    // 都不丢信息 —— 真要的话对端会再发一遍。拒收反而让陌生人能靠洪水
    // 把**真人**挡在门外。
    while (this.deferredIds.size > MAX_DEFERRED_EVENTS) {
      const oldestId = this.deferredIds.keys().next().value
      if (oldestId === undefined) break
      const owner = this.deferredIds.get(oldestId)
      this.deferredIds.delete(oldestId)
      if (owner === undefined) continue
      const ownerBucket = this.deferred.get(owner)
      ownerBucket?.delete(oldestId)
      if (ownerBucket && ownerBucket.size === 0) this.deferred.delete(owner)
    }
  }

  /**
   * 积压了多少条 —— O(1)，走 `deferredIds`。
   *
   * `hasDeferred` 已经被删掉了：它的唯一调用点是上面那个去重判断，
   * 而那里现在直接问 `deferredIds`。留着它只会是一个 O(512×256) 的坑。
   */
  private deferredCount(): number {
    return this.deferredIds.size
  }

  /** 收进已验证集合：排序插入 + 落盘。 */
  private accept(event: P2pEvent): void {
    // 到了这一步这条事件一定验过签，所以它的 `ts` 值得相信 —— 把本地时钟
    // 至少抬到同一位置，之后自己发的事件才排在它后面。放在这里而不是
    // `ingest` 上，是因为 `deferred` 里那些**还没验签**的事件也走 `ingest`，
    // 让陌生人的伪造时间戳推动我们的时钟就本末倒置了；它们在 `flushDeferred`
    // 验过之后同样会走到这一行。
    this.clock?.observe(event.ts)
    this.verified.set(event.id, event)
    insertSorted(this.order, event.id, (a, b) => compareEvents(this.verified.get(a)!, this.verified.get(b)!))
    this.pendingWrites.push(JSON.stringify(event))
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.pendingWrites.length === 0) return
    const batch = this.pendingWrites
    this.pendingWrites = []
    this.writeChain = this.writeChain
      .then(() => Promise.all(batch.map((line) => this.store.append(line))))
      .then(() => undefined)
      .catch(() => undefined) // 落盘失败不阻塞：内存里还在，界面照常用
  }

  /** 等所有攒着的写入落盘。退出前 / 自测里用。 */
  async flush(): Promise<void> {
    await this.writeChain
  }

  // ------------------------------------------------------------ 读

  /** 全部已验事件，按 `compareEvents` 升序。 */
  all(): P2pEvent[] {
    return this.order.map((id) => this.verified.get(id)!)
  }

  /** `ts > since` 的事件 —— 增量同步的「我缺什么」。 */
  since(since: number, limit = 500): P2pEvent[] {
    const out: P2pEvent[] = []
    // `order` 按 ts 升序，所以可以顺序扫到第一个超过游标的就停 ——
    // 不必遍历全量。这是同步最热的路径，值得二分。
    for (let i = lowerBound(this.order, since, (id) => this.verified.get(id)!.ts); i < this.order.length; i++) {
      if (out.length >= limit) break
      out.push(this.verified.get(this.order[i])!)
    }
    return out
  }

  get(id: string): P2pEvent | undefined {
    return this.verified.get(id)
  }

  size(): number {
    return this.verified.size
  }

  /** 某个作者的公钥，给 UI 显示指纹用。 */
  publicKeyOf(author: UserId): string | undefined {
    return this.keys.get(author)
  }

  /** 诊断用：日志里都有哪些人、各自多少条。 */
  stats(): { total: number; deferred: number; authors: number } {
    return { total: this.verified.size, deferred: this.deferredCount(), authors: this.keys.size }
  }

  /**
   * 压缩存储：把内存里的全量重写一遍，丢掉坏行和被丢弃的 deferred。
   *
   * 平时不需要调 —— 只有日志明显大于内存里的量（坏行攒多了）时才有意义。
   */
  async compact(): Promise<void> {
    // 没 `open()` 过就压缩会把日志**整个清空**：`all()` 基于 `this.verified`，
    // 在开过之前它是空的，于是这次 `rewrite` 往磁盘写回 0 行。
    // `open()` 一直有 `this.loaded` 这道守卫，这里先前没有 —— 差一个调用点
    // 就会真的发生，而且是「重启后聊天记录全没了」这种级别的后果。
    //
    // 直接抛错而不是顺手 `open()`：调用方要的是「把磁盘重写一遍」，而它连
    // 日志里有什么都不知道；静默 `open()` 会把「忘了 open」这个 bug 掩盖成
    // 一次几百毫秒的读盘，下次还是没人知道。
    if (!this.loaded) throw new Error('compact() 之前必须先 open()')
    const lines = this.all().map((e) => JSON.stringify(e))
    await this.store.rewrite(lines)
  }
}

// ---------------------------------------------------------------- 小工具

/** 在有序数组里找 `key` 该插的位置（稳定：相同 key 插在后面，保持先进先出）。 */function insertSorted(
  ids: string[],
  id: string,
  compare: (a: string, b: string) => number,
): void {
  let lo = 0
  let hi = ids.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compare(ids[mid], id) <= 0) lo = mid + 1
    else hi = mid
  }
  ids.splice(lo, 0, id)
}

/** 第一个 `key(id) > threshold` 的下标。 */
function lowerBound(ids: string[], threshold: number, key: (id: string) => number): number {
  let lo = 0
  let hi = ids.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (key(ids[mid]) <= threshold) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 发送序号 + 「已经见过的消息」—— 端到端加密里唯一需要落盘的一小块状态。
 *
 * ## 发送序号为什么必须持久、而且必须按会话分
 *
 * 每条消息的 `seq` 会进 AAD（见 `crypto/session.ts` 的 `messageAad`），接收方
 * 用 `(authorId, seq)` 判断「这一条我是不是已经收过了」。有两件事会毁掉这个能力：
 *
 *   1. **刷新页面就归零。** 原来它是一个内存里的大计数器（`chatStore.cryptoSeq`），
 *      刷新之后从 0 重新开始 —— 同一个会话里两条**不同**的消息又都拿到 `seq: 1`，
 *      于是 `(authorId, seq)` 不再是「哪一条消息」的身份，重放也就无从分辨。
 *   2. **所有会话共用一个大计数器。** 看着没问题，但只要刷新一次，不同会话
 *      又会撞在同一批号上，问题一模一样。
 *
 * 所以这里按会话分桶，并且落到 localStorage。
 *
 * ## 「见过」这张表为什么只用在**实时推送**上，不用于历史
 *
 * 拉历史（`history`）本身就是在重放已经发过的密文 —— 而那正是刷新之后唯一的
 * 恢复途径。把它也去重，等于每次刷新都把自己的聊天记录清空一次。
 * 何况历史本来就是从日志里重放出来的密文，来源本来就不止一处。
 * 这张表真正能挡住的是**别人塞一份抓来的旧帧冒充新消息**，
 * 那是实时推送那条路，所以只在 `message:new` 上查。
 * 这是有意的取舍，不是漏了。
 */

/** 一个会话最多记多少条「见过」。超了丢最旧的 —— 序号本来也只用来挡近期的重放。 */
const SEEN_PER_SESSION = 2000

const STORAGE_KEY = 'baker.crypto-replay.v1'

interface Persisted {
  /** sessionId → 我发出去的最后一个序号 */
  seq: Record<string, number>
  /**
   * sessionId → 已经用出去过的最高序号，会话被清掉之后留在原地当墓碑。
   *
   * 没有它就会出事：`forgetSeq` 把 `seq` 删掉，下一次发送从 1 重新开始，
   * 而对端的 `seen` 表里还老老实实记着 `(我, 1..N)` —— 于是以后我发的每一条
   * 都被它当成重放**静默丢掉**。退出会话曾经真的会走到这条路。
   */
  retired: Record<string, number>
  /** sessionId → ["authorId:seq", …] */
  seen: Record<string, string[]>
}

let cache: Persisted | null = null

/**
 * `sessionId` → 已见过的 key 的集合。
 *
 * 这只是 `seen[sessionId]` 那份数组的**内存索引**，落盘格式没变（还是数组，
 * 因为 Set 不能直接 JSON 化）。没有它，每收一条实时消息都要在一个最长
 * 2000 条的数组上 `includes` 一次 —— 会话一多，收消息就成了 O(条目数) 的扫描。
 *
 * 索引和数组必须**一起**增删：只往数组里 splice 而不删索引，会让已经丢掉的
 * key 留在集合里，于是那条重放再也认不出来 —— 索引非但没帮上忙，还把
 * 长度上限变成了一个错误的记忆。
 */
const seenIndex = new Map<string, Set<string>>()

function indexOf(data: Persisted, sessionId: string): Set<string> {
  const existing = seenIndex.get(sessionId)
  if (existing) return existing
  const built = new Set(data.seen[sessionId] ?? [])
  seenIndex.set(sessionId, built)
  return built
}

function load(): Persisted {
  if (cache) return cache
  cache = { seq: {}, retired: {}, seen: {} }
  if (typeof localStorage === 'undefined') return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return cache
    const parsed = JSON.parse(raw) as Partial<Persisted> | null
    if (parsed && typeof parsed === 'object') {
      if (parsed.seq && typeof parsed.seq === 'object') cache.seq = parsed.seq
      if (parsed.retired && typeof parsed.retired === 'object') cache.retired = parsed.retired
      if (parsed.seen && typeof parsed.seen === 'object') cache.seen = parsed.seen
    }
  } catch {
    // 读不到、或者被写坏了。当成空的 —— 最坏的后果是序号重新从头开始，
    // 那也比让界面直接起不来好。
  }
  return cache
}

function persist(): void {
  if (!cache || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // 存不下（隐私模式、配额满）。内存里那份继续用 —— 这次会话内仍然是单调的，
    // 只是刷新之后会从头来。
  }
}

/**
 * 关于「每次收消息都把整份结构序列化一遍」这件事，**故意不改**。
 *
 * 它确实贵：会话一多，`JSON.stringify` 就是几十万个字符。但把落盘合并成
 * 「过一会儿再写」会毁掉这个模块存在的理由 —— `seen` 表必须能扛住刷新
 * （见文件头的第 19-24 行：拉历史会重放密文，所以这张表是刷新后唯一能挡住
 * 「别人塞一份旧帧冒充新消息」的东西）。合并写就意味着「刷新正好落在窗口里，
 * 那些已经见过的号就全忘了」，重放又认得出来了。
 *
 * 真要优化就得换布局：按会话拆成多个 storage key
 * （`baker.crypto-replay.v1.seen.<sessionId>`），让每次写只碰一个会话的数组，
 * 那要带迁移。为一个纯性能问题去削弱一条安全不变式，不划算。
 */

/**
 * 要一个**新的**发送序号：每会话独立、只增不减、跨刷新连续。
 *
 * 调用方必须在 `await` 之前拿好它并一路用下去 —— 中间隔着 await 再去读
 * 「当前序号」会让序号错位，AAD 就对不上，那条消息谁都解不开。
 */
export function nextSendSeq(sessionId: string): number {
  const data = load()
  const next = Math.max(data.seq[sessionId] ?? 0, data.retired[sessionId] ?? 0) + 1
  data.seq[sessionId] = next
  persist()
  return next
}

/** 只读当前序号（不变）。给测试与调试用。 */
export function peekSendSeq(sessionId: string): number {
  return load().seq[sessionId] ?? 0
}

/**
 * 记下「这一条我见过了」。
 *
 * @returns `true` = 第一次见，可以正常收下；`false` = **之前已经见过**，
 *   调用方应该把这一条丢掉（它是一次重放）。
 */
export function noteSeen(sessionId: string, authorId: string, seq: number): boolean {
  const data = load()
  const list = data.seen[sessionId] ?? (data.seen[sessionId] = [])
  const index = indexOf(data, sessionId)
  const key = `${authorId}:${seq}`
  if (index.has(key)) return false
  index.add(key)
  list.push(key)
  if (list.length > SEEN_PER_SESSION) {
    // 丢最旧的，并且**连同索引一起丢** —— 见 `seenIndex` 的注释。
    for (const dropped of list.splice(0, list.length - SEEN_PER_SESSION)) index.delete(dropped)
  }
  persist()
  return true
}

/**
 * 会话清掉时把内存收一收 —— 但**序号只许往上立碑，绝不许倒回去**。
 *
 * `seq` 可以删（下次发继续从墓碑往上走），`seen` 也留着：会话在对端那边
 * 可能还在，抓来的旧帧仍然会被推过来，这张表是本地唯一能挡它的东西。
 */
export function forgetSeq(sessionId: string): void {
  const data = load()
  const last = data.seq[sessionId]
  if (typeof last === 'number' && Number.isFinite(last)) {
    data.retired[sessionId] = Math.max(data.retired[sessionId] ?? 0, last)
  }
  delete data.seq[sessionId]
  persist()
}

/**
 * 丢掉内存缓存，下次读从 localStorage 重新来。
 *
 * 只给测试用：它就是「刷新页面」在数据层面发生的事（内存没了，storage 还在）。
 * 运行时不要调 —— 正常路径下内存缓存和 storage 是同步的。
 */
export function __dropCacheForTests(): void {
  cache = null
  seenIndex.clear()
}

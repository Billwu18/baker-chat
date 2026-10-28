/**
 * 事件 —— 局域网里流动的**唯一**一种东西。
 *
 * ## 为什么是「事件日志」而不是「消息 + 同步接口」
 *
 * v1 的服务器是唯一的事实来源：它存会话、存消息、存好友 pin、存密钥包，
 * 客户端连上去问它要。P2P 之后没有这台服务器了 —— 那么「事实」放在哪？
 *
 * 最省事也最不容易错的答案是：**放在每个人的本地日志里，日志之间互相补**。
 * 每个节点把自己产生的动作（发消息、建群、加好友、改公告）写成一条事件，
 * 签上名，广播出去；收到别人的事件就存进自己的日志、再转给其他对端。
 *
 * 于是每个节点的状态 = `fold(所有见过的事件)`。消息永远不「丢」，只可能
 * 「还没传到我这儿」；也没有「谁说了算」的问题 —— 每条事件都是它作者
 * 一个人的意志，谁也无法替别人写一条。
 *
 * 这换来了三个很值钱的性质：
 *   - **不需要共识算法**：没有需要全体同意的状态；
 *   - **离线可写**：断网时照样记日志，连上以后补传；
 *   - **幂等**：同一条事件收到几次都只有一个效果（id 去重）。
 *
 * ## 事件长什么样
 *
 *     { id, author, ts, kind, body, sig }
 *
 * - `id` 是**内容哈希**：同一份内容在哪台机器上算出来都是同一个 id，
 *   所以去重、引用、「我有没有这条」全都只靠 id，不需要问任何人。
 * - `author` 是**公钥指纹**，不是昵称。昵称谁都能改、谁都能重名，
 *   指纹是 32 字节哈希，冒充不了 —— 见下面 `identityOf`。
 * - `ts` 是混合逻辑时钟（见 `hlc.ts`），不是 `Date.now()`。
 * - `sig` 覆盖 `{author, ts, kind, body}` 的确定性序列化。
 *
 * `id` 和 `sig` 都**不在签名范围内**（id 是内容算出来的，sig 是对内容的签名），
 * 否则就成了自己签自己。
 */

import { fromB64, toB64, toB64Url } from '../crypto/core'
import { importPublicEd } from '../crypto/keys'
import type { IdentityKeys, PublicIdentity } from '../crypto/keys'
import { canonicalBytes, canonicalJson } from './canonical'
import { physicalMs } from './hlc'

export type UserId = string

/**
 * 已知的事件种类。
 *
 * 类型上是个开放联合：收到不认识 `kind` 的事件**照收照转**，只是自己的
 * fold 不认它。这是刻意的 —— 局域网里各人装的版本不可能永远一致，
 * 「不认识就丢掉」会让人在旧版本上永远看不到新版本发的消息，
 * 而且他自己毫无察觉。
 */
export type EventKind =
  | 'profile' // 自我介绍：昵称、头像、两个公钥
  | 'session' // 建群（一对一会话是 pin 的结果，不单独发事件）
  | 'pin' // 加好友（单向集合语义，见 v1 的 friends）
  | 'msg' // 一条消息（正文在 cipher 里，见 crypto/session.ts）
  | 'recall' // 撤回
  | 'react' // 表情回应
  | 'key' // 会话密钥包
  | 'announce' // 公告
  | 'file' // 文件元数据（内容按需拉，见后续）
  | (string & {})

/** 一条事件。字段顺序在这里没有意义 —— 签名走 `canonicalJson`，键会排序。 */
export interface P2pEvent {
  id: string
  author: UserId
  ts: number
  kind: EventKind
  body: unknown
  sig: string
}

/** 被签名（也是被哈希）的那部分。 */
export type EventPayload = Pick<P2pEvent, 'author' | 'ts' | 'kind' | 'body'>

/**
 * 单条事件的字节上限。
 *
 * 对端是**不受信任**的：一个坏掉的（或恶意的）实现可以声称发一条 4GB 的
 * 事件，我们一 `JSON.parse` 就没了。Rust 那层已经挡住了帧大小，
 * 这里再挡一次，因为事件是可以被**再次转发**的 —— 一条从 A 转发来的
 * 巨型事件在 B 这里是合法的帧，但它进了日志就会一直占着内存和磁盘。
 */
export const MAX_EVENT_BYTES = 128 * 1024

/**
 * 一条事件的字节数估算 —— 给**接收侧**用的粗筛。
 *
 * `signEvent` 里那道 `MAX_EVENT_BYTES` 是发送侧的：它拦的是我们自己造的事件。
 * 收到的这条是别人造好的，JS 对象早就存在了，必须在**验签和入库之前**挡住它，
 * 否则一条 48 MB 的事件（帧上限）会一直占着我的内存和日志。
 *
 * 用 `JSON.stringify` 而不是 `canonicalBytes`：这一步要的是「便宜地量个大概」，
 * 不是精确复现签名时那串字节。`canonicalBytes` 要按规则排序、逐字符处理转义，
 * 而那正是我们不想在超限输入上先付一遍的代价。判宽一点没关系 —— 真到边界上
 * 还有 `signEvent` / `computeEventId` 那条精确路径兜着。
 */
export function roughEventBytes(raw: P2pEvent): number {
  try {
    return JSON.stringify(raw).length
  } catch {
    // 循环引用之类。结构检查已经放过它了，这里只能当成「量不出来 → 拒」。
    return Number.POSITIVE_INFINITY
  }
}

// ---------------------------------------------------------------- 身份

/**
 * 「这两个公钥属于谁」 —— 两个公钥一起哈希。
 *
 * **这是整个 P2P 的信任锚**，所以值得说清楚它为什么成立：
 * 事件里的 `author` 不是对端自己报的名字，而是**由它的公钥算出来的**。
 * 想冒充别人，就得先造出哈希相同的一对公钥 —— 也就是 SHA-256 的碰撞。
 *
 * 于是「这个人是谁」不需要任何人担保、不需要名册、不需要服务器，
 * 收到公钥就能自己算一遍。这也顺手解决了 v1 里那个隐患：
 * 服务器名册里的 id 和公钥万一不一致，客户端是看不出来的；这里没有
 * 「存下来的 id」，只有「算出来的 id」，对不上就是对不上。
 *
 * ## 为什么不用 `crypto/keys.ts` 的 `numberOf`
 *
 * 那个函数返回的是**给眼睛看的 8 位短码**（40 位），它的用途是当面核对、
 * 念出来、在界面上并排显示 —— 不是当标识符。
 *
 * 拿它当 `author` 会有一个很实在的漏洞：40 位意味着只要生成约 2^20 对密钥
 * 就能撞出**同一个人**，而且碰撞是攻击者自己造的、他持有私钥，
 * 于是他能替那个人签事件。256 位把这个成本抬到不可能。
 *
 * 短码仍然有用，但它必须是**从 `author` 派生出来的显示值**
 * （见 `fold.ts` 的 `shortId`），而不是一个能被冒充的标识。
 */
export async function identityOf(pub: PublicIdentity): Promise<UserId> {
  const bytes = canonicalBytes({ ed: pub.ed, x: pub.x })
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toB64Url(new Uint8Array(digest))
}

// ---------------------------------------------------------------- 造事件

/** 把一条事件拆回「被签的那部分」。 */
export function payloadOf(event: P2pEvent): EventPayload {
  return { author: event.author, ts: event.ts, kind: event.kind, body: event.body }
}

/** 内容寻址的 id。同样的内容永远得到同样的 id。 */
export async function computeEventId(payload: EventPayload): Promise<string> {
  const bytes = canonicalBytes(payload)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toB64Url(new Uint8Array(digest))
}

/**
 * 用本机私钥造一条事件。
 *
 * 调用方负责给 `ts`（应该来自 `HybridClock.tick()`）—— 这里不碰时钟，
 * 是为了让签名这件事保持**纯粹**：给定同样的输入，输出永远一样。
 * 混进 `Date.now()` 之后，这个函数就没法在自测里对着固定向量验了。
 */
export async function signEvent(
  keys: IdentityKeys,
  payload: EventPayload,
): Promise<P2pEvent> {
  const bytes = canonicalBytes(payload)
  if (bytes.length > MAX_EVENT_BYTES) {
    throw new Error(`事件 ${bytes.length} 字节，超过上限 ${MAX_EVENT_BYTES}`)
  }
  const signature = await crypto.subtle.sign('Ed25519', keys.edPrivate, bytes)
  return {
    ...payload,
    id: await computeEventId(payload),
    sig: toB64(signature),
  }
}

// ---------------------------------------------------------------- 验事件

/**
 * 时间戳最多能比本机时钟超前多少（毫秒）。
 *
 * `ts` 是 HLC：`物理毫秒 * 1000 + 序号`（见 `hlc.ts`），排序用的是
 * `(ts, id)` 比大小（见 `fold.ts` 的 `winsOver`）。如果 `ts` 没有上界，
 * 一条 `ts: 9e15` 的 `session` 事件就会**永久**压住之后所有人的同一条会话
 * —— 改成员、改名字、退出会话全都再也生效不了，而且没人能翻盘，因为谁的
 * 数字都比它小。`Number.MAX_SAFE_INTEGER` 就是那个天花板。
 *
 * 一年是很宽的量：正常的时钟漂移是秒级，跨时区、休眠唤醒也到不了这个数。
 */
const MAX_CLOCK_SKEW_MS = 365 * 24 * 60 * 60 * 1000

/** 结构上是不是一条事件。用于 `JSON.parse` 之后的第一道关。 */
export function isWellFormedEvent(raw: unknown): raw is P2pEvent {
  if (!raw || typeof raw !== 'object') return false
  const e = raw as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length <= 64 &&
    typeof e.author === 'string' &&
    e.author.length > 0 &&
    e.author.length <= 64 &&
    typeof e.ts === 'number' &&
    Number.isFinite(e.ts) &&
    e.ts > 0 &&
    // `e.ts` 是 HLC（毫秒 × 1000 + 序号），所以要缩到毫秒再比。
    physicalMs(e.ts) <= Date.now() + MAX_CLOCK_SKEW_MS &&
    typeof e.kind === 'string' &&
    e.kind.length > 0 &&
    e.kind.length <= 64 &&
    typeof e.sig === 'string' &&
    e.sig.length > 0 &&
    e.sig.length <= 256 &&
    'body' in e
  )
}

/**
 * 一条合法事件的顶层字段数：`id` / `author` / `ts` / `kind` / `body` / `sig`。
 *
 * 只用来做快路径判断，真正的剥离见 `stripExtraEventKeys`。
 */
const EVENT_KEY_COUNT = 6

/**
 * 剥掉签名覆盖不到的顶层字段。
 *
 * 签名只覆盖 `payloadOf` 取的那四个（`author`/`ts`/`kind`/`body`），`id` 是
 * 收件人重算核对的、`sig` 是签名本身。于是**其它任何顶层字段既没被签名，
 * 也没被拒绝**，而 `log.accept` 存的是整个对象、`fanout` 与 `sync` 又原样
 * 转发出去 —— 一条攻击者可控、且没有任何签名保证的数据就这样进了别人的日志。
 *
 * 今天没有消费者读它，所以这是潜伏问题；处理方式是**剥掉**而不是拒收：
 * 拒收会让「以后给事件加一个字段」变成不兼容变更，而剥掉的效果一样
 * （脏字段既进不了日志，也传不出去），却不会因为一条多余字段丢掉整条消息。
 */
export function stripExtraEventKeys(event: P2pEvent): P2pEvent {
  // `isWellFormedEvent` 已经要求六个必需字段都在，所以键数相等就意味着
  // 一个不多一个不少。
  if (Object.keys(event).length === EVENT_KEY_COUNT) return event
  return {
    id: event.id,
    author: event.author,
    ts: event.ts,
    kind: event.kind,
    body: event.body,
    sig: event.sig,
  }
}

/**
 * 找一个人签名用的公钥。
 *
 * 返回 `undefined` 表示**还没见过这个人**（他的 profile 事件还没到我这儿）。
 * 那时事件不能被验签，也不能被相信 —— 但**可以先进日志**：等 profile 到了
 * 再回头验。这一点很重要，否则「profile 和消息同时到达、顺序反了」
 * 会让消息在重传之前一直验不过。
 */
export type KeyLookup = (author: UserId) => string | undefined

/**
 * 只重算 id，不验签。
 *
 * 单独拿出来是因为**「内容被改过」和「签名不对」是两件事**，报给用户的
 * 含义完全不同：前者是传输/存储坏了，后者是有人在冒充别人。
 * `verifyEvent` 把两者都收敛成 `false`（对「要不要丢掉」这个判断是对的，
 * 但用来解释原因就不够了），所以日志层在验签之前先单独问一次这个。
 */
export async function eventIdMatches(event: P2pEvent): Promise<boolean> {
  return (await computeEventId(payloadOf(event))) === event.id
}

/**
 * 验一条事件的签名。
 *
 * 只回答「这条事件确实是 `author` 这个公钥的主人写的」，**不回答**
 * 「内容是不是合理」—— 那是各 `kind` 自己的事（比如 `msg` 的作者是不是
 * 会话成员）。把这两件事分开，是为了让日志层不需要认识任何业务概念。
 *
 * 返回 `false` 一律按「这条事件作废」处理（丢弃，不转发）。验签失败的
 * 东西转发出去只会让坏数据传得更广。
 */
export async function verifyEvent(event: P2pEvent, lookup: KeyLookup): Promise<boolean> {
  // 先重算 id。id 和内容对不上说明有人改了内容却没改 id，
  // 或者两条不同内容撞了 id —— 两种都必须丢。
  if (!(await eventIdMatches(event))) return false

  const ed = lookup(event.author)
  if (!ed) return false

  try {
    const key = await importPublicEd(ed)
    const bytes = canonicalBytes(payloadOf(event))
    return await crypto.subtle.verify('Ed25519', key, fromB64(event.sig), bytes)
  } catch {
    // 公钥不是合法 base64、签名不是合法 base64、算法不支持 —— 都是「验不过」
    return false
  }
}

// ---------------------------------------------------------------- 排序

/**
 * 全局一致的排序：先比 HLC，再比内容 id。
 *
 * 任何两个不同的节点对**同一对事件**算出来的顺序都一样（`ts` 是事件自带的，
 * `id` 是内容哈希），所以每个人最终看到的列表逐条相同 —— 不需要任何人
 * 来裁定顺序，也不会出现「我这儿这条在上面、他那儿在下面」。
 */
export function compareEvents(a: P2pEvent, b: P2pEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 一批事件里最大的 HLC —— 增量同步的游标。 */
export function maxTs(events: readonly P2pEvent[]): number {
  let max = 0
  for (const e of events) if (e.ts > max) max = e.ts
  return max
}

/** 把一条事件序列化成一帧（对端要的就是这个）。 */
export function encodeEvent(event: P2pEvent): Uint8Array {
  return new TextEncoder().encode(canonicalJson(event))
}

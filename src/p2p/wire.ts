/**
 * 对等节点之间的同步协议 —— 跑在 Rust 那层 TCP 帧里的 JSON。
 *
 *     TCP 帧（Rust 负责，长度前缀）
 *       └─ JSON：{t:'sync'|'events'|'ping'|'pong', ...}
 *
 * ## 为什么用 JSON 而不是二进制
 *
 * 这是**内网、已验签**的数据：每条事件的签名在这一层之前就已经验过了
 * （`log.ingest`），所以这里不存在「伪造的字段」，只存在「格式不对的字段」。
 * 既然如此，可读性就是净收益 —— 出问题时 `tcpdump` 一眼能看出「sync 发了
 * 但对面没回 events」，而在一个二进制格式里那要写个解码器才能判断。
 *
 * 代价是体积（事件里的 base64 签名、JSON 转义）。局域网带宽下这不是瓶颈：
 * 一条消息几百字节，一次全量同步几兆。
 *
 * ## 同步怎么保证不丢
 *
 * 这是这一层唯一真正困难的地方，值得写清楚。
 *
 * ### 先用错了的做法：一个标量游标
 *
 * 最自然的想法是「我最大的 ts 是 X，给我 ts > X 的」。**它会丢消息**，
 * 而且丢得很安静：
 *
 *     A 和 B 是邻居，A 和 C 也是邻居，B 和 C 没连上。
 *     A 断开（它自己最后一条事件 ts=99）。
 *     B 发了 ts=100..110，C 也发了 ts=100..110。
 *     A 回来，先连上 B → 收到 B 的 100..110，A 的最大 ts 变成 110。
 *     A 再连上 C → 说「我要 ts > 110 的」→ C 什么都不发。
 *           ↑ C 那 11 条 A 一条都没有，但 A 永远拿不到了。
 *
 * 而且此时两边都「成功同步了」，没有任何错误。
 *
 * ### 现在的做法：直接对 id 集合
 *
 * 连上之后双方各发一条 `sync`，内容是**自己全部事件的 id**。收到的人算
 * 差集，把自己有、对方没有的发过去。于是「缺哪些」由集合决定，和游标、
 * 和拓扑、和谁先连谁都没关系 —— 上面那个场景里 A 连 C 时会发现自己缺
 * c1..c10，因为 C 的 id 不在 A 的集合里。
 *
 * 代价：每次建立连接要传一遍 id 列表。50 个字符 × N 条事件，
 * 一万条就是 500KB —— 在千兆局域网上是几毫秒，而且是**每条连接一次**。
 * 这个交换换掉的是「偶尔丢几条消息且查不出来」，非常划算。
 *
 * 到了「几十万条事件」的量级，正确的升级是给有序 id 列表做 Merkle 树，
 * 而不是退回标量游标 —— 退回去等于把上面那个 bug 重新请回来。
 */

import type { P2pEvent } from './event'
import { isWellFormedEvent } from './event'

/**
 * 单个帧里最多塞多少条事件。
 *
 * 一次全量同步可能要送几千条，全塞一帧会：
 *   - 在 Rust 那层申请一大块内存再一次性写出去（对端要等整块到齐）；
 *   - 某一帧失败时整批重来。
 *
 * 512 条大约几百 KB，既不会把内存顶起来，也不至于让帧数多到
 * 每条都要一次系统调用。分帧在这里是**平凡安全**的：`events` 帧
 * 之间没有顺序要求，收下多少算多少。
 */
export const EVENTS_PER_FRAME = 512

/** 一帧里 `have` 最多列多少个 id。见下面的 `truncated`。 */
export const MAX_HAVE_IDS = 60_000

export type WireFrame =
  | {
      /** 「这些是我有的事件 id」。连上后双方各发一条。 */
      t: 'sync'
      have: string[]
      /**
       * `have` 被截断过（我这儿的日志超过上限了）。
       *
       * 对端的处理：**照常算差集**，但要意识到可能漏。这个字段存在的意义
       * 是「不许假装同步干净了」—— 真到了这个量级，界面会提示用户，
       * 而不是让他以为历史完整。
       */
      truncated?: true
    }
  | {
      /** 「这些事件给你」。是 `sync` 的回应，也是新消息的推送。 */
      t: 'events'
      events: P2pEvent[]
      /** 后面还有，别以为这一帧就是全部。 */
      more?: true
    }
  | { t: 'ping'; ts: number }
  | { t: 'pong'; ts: number }
  | {
      /**
       * 「这几个文件块我要」。
       *
       * 触发点是收到 `file` 事件但本地没有那坨字节 —— 包括**别人离线时发的**：
       * 他重新上线后我们看到事件，于是要一次，这正是「离线消息自动补发」
       * 在文件上的形态（事件本身早就同步过来了，字节按需拉）。
       */
      t: 'blob-want'
      ids: string[]
    }
  | {
      /** 「这个文件块给你」。一帧一个 —— 大文件拆帧会让接收方没法逐步落盘。 */
      t: 'blob-data'
      id: string
      /** 显示名，只在第一次给的时候带。 */
      name?: string
      mime?: string
      /** 内容，base64。 */
      b64: string
    }

// ---------------------------------------------------------------- 编解码

/**
 * 编码成一帧。
 *
 * 抛错的唯一情况是「内容大到 Rust 那层会拒收」—— 那时候在 TS 侧抛
 * 比让 Rust 返回一个错误要好定位，因为调用栈里能看到是哪一批事件。
 */
export function encodeFrame(frame: WireFrame): Uint8Array {
  const text = JSON.stringify(frame)
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MAX_WIRE_BYTES) {
    throw new Error(`这一帧 ${bytes.length} 字节，超过上限 ${MAX_WIRE_BYTES}`)
  }
  return bytes
}

/**
 * 解码。
 *
 * **返回 `undefined` 而不是抛错**：坏帧在局域网里是正常的（版本不同的
 * 两个客户端、或者别人往这个端口发了个别的东西）。抛错会让接收循环
 * 中断，而接收循环一断，后面所有**好**的帧也一起没了 —— 一条坏帧
 * 不该有这个后果。
 *
 * 所以调用方看到 `undefined` 时该做的是「记一笔、丢掉、继续」。
 */
export function decodeFrame(bytes: Uint8Array): WireFrame | undefined {
  // 先按字节数拒，再解析。
  //
  // 顺序很重要：`JSON.parse` 要为整帧分配一次，48 MB 的输入光解析就是几百
  // 毫秒的**主线程**占用，而这一切发生在任何校验之前。Rust 那层已经有一道
  // 64 MB 的硬墙，这里是第二道 —— 也是唯一能在不先付解析代价的前提下挡住
  // 它的地方。
  if (bytes.length > MAX_WIRE_BYTES) return undefined

  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
  return normalizeFrame(raw)
}

/**
 * 把任意 JSON 收敛成一个可信的 `WireFrame`，或者 `undefined`。
 *
 * 分这么细是因为「大」和「小」在这里不是风格问题：
 *   - 逐字段检查类型，不做 `as` 断言 —— 局域网上任何一台机器都能往
 *     这个端口发东西，断言等于把后续代码暴露给它的输入；
 *   - 事件列表**逐条**校验，但**不验签**（验签在 `log.ingest` 里，
 *     那里才有公钥表）。这里挡的是结构，不是真伪。
 */
export function normalizeFrame(raw: unknown): WireFrame | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>

  switch (record.t) {
    case 'sync': {
      const have = asStringArray(record.have)
      if (!have) return undefined
      const frame: WireFrame = { t: 'sync', have }
      if (record.truncated === true) frame.truncated = true
      return frame
    }

    case 'events': {
      if (!Array.isArray(record.events)) return undefined
      // 条数也必须有上限。
      //
      // 帧的**字节**上限挡不住「很多条很小的事件」：一条 `recall` 只有一百
      // 多字节，48 MB 的帧能装下三十万条，而 `ingestMany` 是逐条 `await` 的
      // （每条跑一次 Ed25519 验签）。我们自己的发送侧按 `EVENTS_PER_FRAME`
      // 分块，所以比它更大的帧一定不是我们的客户端发的。
      if (record.events.length > EVENTS_PER_FRAME) return undefined
      // 逐条过结构检查，坏的直接剔掉而不是整帧丢弃：
      // 一帧里混进一条坏事件时，丢掉另外 511 条好的是很糟的取舍。
      const events = record.events.filter(isWellFormedEvent)
      if (events.length === 0) return undefined
      const frame: WireFrame = { t: 'events', events }
      if (record.more === true) frame.more = true
      return frame
    }

    case 'ping':
    case 'pong': {
      const ts = typeof record.ts === 'number' && Number.isFinite(record.ts) ? record.ts : 0
      return { t: record.t, ts }
    }

    case 'blob-want': {
      const ids = asStringArray(record.ids)
      if (!ids || ids.length === 0) return undefined
      return { t: 'blob-want', ids }
    }

    case 'blob-data': {
      const id = asString(record.id)
      const b64 = asString(record.b64)
      if (!id || !b64) return undefined
      // 这里**只挡大小**，不验哈希 —— 验哈希要 await，而 `normalizeFrame`
      // 是同步的。哈希校验在真正收下之前做（见 `P2pNode.handleBlob`），
      // 那时候才有机会把「内容对不上」这件事报出去。
      if (b64.length > MAX_BLOB_B64_CHARS) return undefined
      const frame: WireFrame = { t: 'blob-data', id, b64 }
      const name = asString(record.name)
      const mime = asString(record.mime)
      if (name) frame.name = name
      if (mime) frame.mime = mime
      return frame
    }

    default:
      return undefined
  }
}

// ---------------------------------------------------------------- 差集

/**
 * 算「我有、对方没有」。
 *
 * 纯函数，所以「上面那个 A/B/C 场景」能直接写成自测（见
 * `tools/p2p-selftest.ts` 的同步一节）—— 不必真的起三个进程去复现。
 *
 * `have` 参数是**对方报过来的**，所以不能信它是「全都在」。用 Set 而不是
 * 线性查找：一万条事件的差集是 O(n) 和 O(n²) 的区别。
 */
export function eventsTheyLack(mine: readonly P2pEvent[], theirHave: readonly string[]): P2pEvent[] {
  const known = new Set(theirHave)
  return mine.filter((event) => !known.has(event.id))
}

/**
 * 把要发的 event 切成若干 `events` 帧。
 *
 * `more` 标在除最后一帧之外的每一帧上。它**不是**流控信号（我们不等待
 * 确认），只是让接收端在日志里能看到「后面还有」，排查时少一次困惑。
 */
export function chunkEvents(events: readonly P2pEvent[]): WireFrame[] {
  if (events.length === 0) return []
  const frames: WireFrame[] = []
  for (let i = 0; i < events.length; i += EVENTS_PER_FRAME) {
    const slice = events.slice(i, i + EVENTS_PER_FRAME)
    const last = i + EVENTS_PER_FRAME >= events.length
    frames.push(last ? { t: 'events', events: slice } : { t: 'events', events: slice, more: true })
  }
  return frames
}

// ---------------------------------------------------------------- 内部

/**
 * 一帧的字节上限。
 *
 * 它不是贴着 Rust 那边 64MB 的硬墙定的，而是留出「我们这边算错」和
 * 「有人在攻击」之间的区分度：正常同步不该超过几 MB，而带文件的一帧
 * 撑到 40MB 上下是设计内的（32MB 的块 + base64 膨胀 + JSON 转义）。
 * 所以上限取 48MB —— 超过它说明分帧漏了或者对端在灌数据。
 */
export const MAX_WIRE_BYTES = 48 * 1024 * 1024

/**
 * `blob-data` 帧解码**之前**的长度闸门。
 *
 * base64 是 4/3 膨胀，所以 32MB 的文件编出来约 43MB 字符。这里取比
 * `MAX_BLOB_BYTES` 换算值略大的一个数：闸门的作用是「在 `JSON.parse`
 * 之前就把明显不可能的东西挡掉」，而不是精确执法 —— 精确的那个判断
 * 在解出字节、算完哈希之后。
 */
const MAX_BLOB_B64_CHARS = 48 * 1024 * 1024

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  // 元素个数的上限也在这里挡：一个声称有十亿个 id 的 `sync` 帧
  // 光是解析就会把内存吃干。
  if (value.length > MAX_HAVE_IDS) return undefined
  if (!value.every((v) => typeof v === 'string')) return undefined
  return value as string[]
}

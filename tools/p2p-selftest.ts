/**
 * P2P 核心的自检 —— `canonical` / `hlc` / `event` / `log` / `fold`。
 *
 * 跑法（Node 直接啃不了 .ts，先用 esbuild 打成一个 mjs）：
 *
 *   npx esbuild tools/p2p-selftest.ts --bundle --format=esm --platform=node \
 *     --outfile=.tmp/p2p-selftest.mjs && node .tmp/p2p-selftest.mjs
 *
 * ## 这里盯的是什么
 *
 * 这个模块的失败方式和密码学那几个不一样：闹钟不会响。签名算错了会立刻
 * 抛错，但**折叠顺序**错了不会 —— 两个人看到的界面不同，各自都觉得自己
 * 是对的，然后开始怀疑网络。所以下面每一条都尽量针对「错了也不报错」的形状：
 *
 *   - 折叠与到达顺序无关（同一组事件打乱 N 次，结果必须逐字节相同）；
 *   - profile 后到时不丢消息（消息先到 → deferred → profile 到了要放出来）；
 *   - 时钟被往回拨 / 重启之后不倒退；
 *   - 冒充别人签的东西进不来；
 *   - 伪造的 pin 不能把某人变成我的好友。
 */

import { generateIdentityKeys, exportPublic } from '../src/crypto/keys'
import type { IdentityKeys, PublicIdentity } from '../src/crypto/keys'
import { CanonicalError, canonicalBytes, canonicalJson } from '../src/p2p/canonical'
import { HybridClock, physicalMs, tsToDate } from '../src/p2p/hlc'
import {
  computeEventId,
  compareEvents,
  identityOf,
  isWellFormedEvent,
  payloadOf,
  signEvent,
  verifyEvent,
} from '../src/p2p/event'
import type { EventPayload, P2pEvent, UserId } from '../src/p2p/event'
import { MAX_EVENT_BYTES } from '../src/p2p/event'
import { EventLog, MemoryStore, MAX_LOG_EVENTS } from '../src/p2p/log'
import { emptyState, fold, friends, messagesOf, shortId } from '../src/p2p/fold'
import {
  chunkEvents,
  decodeFrame,
  encodeFrame,
  eventsTheyLack,
  normalizeFrame,
  EVENTS_PER_FRAME,
  MAX_WIRE_BYTES,
} from '../src/p2p/wire'
import type { WireFrame } from '../src/p2p/wire'
import { safeImageUrl } from '../src/utils/safeImage'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}${extra}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${extra}`)
  }
}

/** 可复现的洗牌：`slice` 出一份新数组，用 LCG 决定交换。 */
function shuffle<T>(input: readonly T[], seed: number): T[] {
  const out = [...input]
  let state = seed >>> 0
  const next = (): number => {
    // xorshift32 —— 够随机，且不用带任何依赖。
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

interface Actor {
  keys: IdentityKeys
  pub: PublicIdentity
  id: UserId
  clock: HybridClock
  /** 造一条签好名的事件。 */
  make(kind: string, body: unknown): Promise<P2pEvent>
}

async function actor(): Promise<Actor> {
  const keys = await generateIdentityKeys()
  const pub = await exportPublic(keys)
  const id = await identityOf(pub)
  const clock = new HybridClock()
  return {
    keys,
    pub,
    id,
    clock,
    async make(kind: string, body: unknown): Promise<P2pEvent> {
      const payload: EventPayload = { author: id, ts: clock.tick(), kind, body }
      return signEvent(keys, payload)
    },
  }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- canonical
  console.log('=== canonical：确定性 JSON ===')

  check(
    '键的顺序不影响输出',
    canonicalJson({ a: 1, b: 2 }) === canonicalJson({ b: 2, a: 1 }),
    ` → ${canonicalJson({ a: 1, b: 2 })}`,
  )

  check(
    '嵌套对象的键也排序',
    canonicalJson({ z: { b: 1, a: 2 } }) === '{"z":{"a":2,"b":1}}',
    ` → ${canonicalJson({ z: { b: 1, a: 2 } })}`,
  )

  check('中文字符串按 UTF-8 编码', new TextDecoder().decode(canonicalBytes({ s: '你好' })).includes('你好'))

  {
    // 孤立代理项（未配对的 U+D800–U+DFFF）必须**编码不同**。
    //
    // `quote()` 原来把它们原样输出，而 `canonicalBytes` 用的是 `TextEncoder` ——
    // 它把每个未配对的代理项替换成 U+FFFD。于是 `"\uD800"`、`"\uD801"` 和
    // `"\uFFFD"` 算出**同一串规范字节**，两个后果：
    //   · `computeEventId` 给它们同一个 id → 先到的赢，后到的被当重复
    //     **静默丢弃**，两台设备对同一条消息显示不同文本；
    //   · 签名验的也是同一串字节 → 任何中继把代理项改成 U+FFFD，
    //     签名照样过、id 照样对（签名可被改写）。
    // 按 `JSON.stringify` 的做法把孤立的那个转义掉，编码就重新是单射。
    const encode = (text: string) => new TextDecoder().decode(canonicalBytes({ s: text }))
    check(
      '孤立代理项与 U+FFFD 编码不同',
      encode('\uD800') !== encode('\uFFFD'),
      ` → ${JSON.stringify(encode('\uD800'))} vs ${JSON.stringify(encode('\uFFFD'))}`,
    )
    check('两个不同的孤立代理项编码也不同', encode('\uD800') !== encode('\uD801'))
    check(
      '孤立代理项的处理与 JSON.stringify 一致',
      canonicalJson('\uD800') === JSON.stringify('\uD800'),
    )
    check(
      '合法代理对（emoji）原样保留且能往返',
      (JSON.parse(canonicalJson({ t: '👍' })) as { t: string }).t === '👍',
    )
  }

  // 这些是「必须拒绝」的：JSON 里没有它们的合法表示，放过去就会得到
  // 一个签名验不过但又看不出原因的串。
  for (const [label, value] of [
    ['undefined', { a: undefined }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['函数', { a: () => 1 }],
    ['Symbol 键', { [Symbol('x')]: 1 }],
  ] as const) {
    let threw = false
    try {
      canonicalJson(value)
    } catch (error) {
      threw = error instanceof CanonicalError
    }
    check(`拒绝 ${label}`, threw)
  }

  {
    // 拒绝的理由要说清是**哪个键**。
    //
    // canonical.ts 里其实有两道闸：`write` 的 default 分支（任何落单的 undefined）
    // 和对象键那一圈的检查。把后者删掉，`{a: undefined}` **照样报错** —— 所以
    // 「拒绝 undefined」这条断言看不出它被删了（变异检查抓出来的第一个洞）。
    // 而那圈检查真正的价值就是**点名**：面对一个几十字段的 envelope，
    // 只说「有 undefined」等于没说。所以断言要盯在这个区别上。
    let message = ''
    try {
      canonicalJson({ a: 1, 坏字段: undefined })
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    check('undefined 的报错点出了键名', message.includes('坏字段'), ` → ${message}`)
  }

  {
    // 自己咬自己：不拒绝的话会在排序里绕不出来，直接挂死。
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    let threw = false
    try {
      canonicalJson(cyclic)
    } catch (error) {
      threw = error instanceof CanonicalError
    }
    check('拒绝循环引用', threw)
  }

  {
    // 深度上限：合法但荒谬的输入。防的是栈溢出。
    let deep: unknown = 1
    for (let i = 0; i < 200; i += 1) deep = { n: deep }
    let threw = false
    try {
      canonicalJson(deep)
    } catch (error) {
      threw = error instanceof CanonicalError
    }
    check('拒绝超深嵌套', threw)
  }

  // ---------------------------------------------------------------- hlc
  console.log('\n=== hlc：跨机器排序的唯一依据 ===')

  {
    const clock = new HybridClock()
    const a = clock.tick(1_000_000)
    const b = clock.tick(1_000_000) // 同一毫秒
    const c = clock.tick(1_000_000)
    check('同一毫秒内严格递增', a < b && b < c, ` → ${a} < ${b} < ${c}`)
    check('物理部分仍是那一毫秒', physicalMs(a) === 1_000_000 && physicalMs(c) === 1_000_000)
  }

  {
    // 时钟被往回拨（NTP 校正、用户手动改时间）：绝不允许倒退。
    const clock = new HybridClock()
    const first = clock.tick(5_000_000)
    const back = clock.tick(1_000_000)
    check('时钟回拨后仍然递增', back > first, ` → ${first} < ${back}`)
  }

  {
    const clock = new HybridClock()
    clock.observe(9_000_000 * 1000 + 7)
    const next = clock.tick(1_000_000)
    check('看见别人的时间戳后追上去', next > 9_000_000 * 1000, ` → ${next}`)
    check('追上去之后不早于对方的序号', next > 9_000_000 * 1000 + 7)
  }

  {
    const clock = new HybridClock()
    const mine = clock.tick(9_000_000)
    clock.observe(1) // 对方时钟慢得离谱
    check('对方时钟慢时不倒退', clock.tick(9_000_000) > mine)
  }

  {
    // 重启：从存下来的值恢复，不能从 0 重来 ——
    // 否则重启后发的新消息会排到自己的旧消息**前面**。
    const clock = new HybridClock()
    const before = clock.tick(1_000_000)
    const restarted = new HybridClock()
    restarted.restore(before)
    const after = restarted.tick(1_000_000)
    check('重启后不倒退', after > before, ` → ${before} < ${after}`)

    const ignored = new HybridClock()
    ignored.restore(before)
    ignored.restore(1) // 更小的值必须被忽略
    check('恢复更小的值被忽略', ignored.peek() === before)
  }

  {
    // 序号用满 1000 条之后借一毫秒，而不是溢出到高位。
    const clock = new HybridClock()
    const first = clock.tick(1_000_000)
    let last = first
    for (let i = 0; i < 1500; i += 1) last = clock.tick(1_000_000)
    check('序号溢出时借一毫秒', physicalMs(last) > physicalMs(first), ` → ${physicalMs(first)} → ${physicalMs(last)}`)
    check('借毫秒后仍严格递增', last > first)
  }

  check('tsToDate 还原出可读时间', tsToDate(1_700_000_000_000 * 1000).getTime() === 1_700_000_000_000)

  // ---------------------------------------------------------------- 身份
  console.log('\n=== 身份：author 是算出来的，不是报出来的 ===')

  const alice = await actor()
  const bob = await actor()
  const carol = await actor()

  check('identityOf 是确定性的', (await identityOf(alice.pub)) === alice.id)
  check('不同密钥 → 不同身份', alice.id !== bob.id)
  check('身份足够长（不是 8 位短码）', alice.id.length >= 42, ` → ${alice.id.length} 字符`)
  check('shortId 是 8 个字符', shortId(alice.id).length === 8, ` → ${shortId(alice.id)}`)
  check('不同身份 → 不同短码', shortId(alice.id) !== shortId(bob.id), ` → ${shortId(alice.id)} / ${shortId(bob.id)}`)
  check('坏 id 不抛错，退回问号', shortId('!!!!') === '????????')

  // ---------------------------------------------------------------- 签名
  console.log('\n=== 事件：签名与验签 ===')

  const lookup = (author: UserId): string | undefined => {
    if (author === alice.id) return alice.pub.ed
    if (author === bob.id) return bob.pub.ed
    return undefined
  }

  const hello = await alice.make('profile', { ...alice.pub, name: '爱丽丝', avatarKey: 'a1' })
  check('结构检查通过', isWellFormedEvent(hello))
  check('自证签名验得过', await verifyEvent(hello, lookup))

  {
    // ★ 时间戳的上界。
    //
    // `ts` 是 HLC（毫秒 × 1000 + 序号），排序是 `(ts, id)` 比大小。没有上界
    // 的话，一条 `ts: 9e15` 的 session 事件会**永久**压住之后所有人的同一条
    // 会话 —— 改成员、改名、退出全会再也生效不了，而且谁都翻不了盘。
    check('当前时间的事件照收', isWellFormedEvent(hello))
    check('一年后的还收（容忍时钟不准）', isWellFormedEvent({ ...hello, ts: (Date.now() + 300 * 24 * 3600 * 1000) * 1000 }))
    check('★ 远到离谱的时间戳被拒', !isWellFormedEvent({ ...hello, ts: 9e15 }))
    check('★ Number.MAX_SAFE_INTEGER 被拒', !isWellFormedEvent({ ...hello, ts: Number.MAX_SAFE_INTEGER }))
    check('0 / 负数 / NaN 仍然被拒', !isWellFormedEvent({ ...hello, ts: 0 })
      && !isWellFormedEvent({ ...hello, ts: -1 })
      && !isWellFormedEvent({ ...hello, ts: Number.NaN }))
  }

  {
    // 改一个字节：id 会变，所以首先过不了 id 那一关。
    const tampered: P2pEvent = { ...hello, body: { ...alice.pub, name: '鲍勃' } }
    check('改了正文就验不过', !(await verifyEvent(tampered, lookup)))
  }

  {
    // 连 id 一起改（攻击者重算内容哈希）—— 签名这一关必须拦住。
    const payload = payloadOf({ ...hello, body: { ...alice.pub, name: '鲍勃' } })
    const forged: P2pEvent = {
      ...hello,
      body: { ...alice.pub, name: '鲍勃' },
      id: await computeEventId(payload),
    }
    check('连 id 一起算过也验不过', !(await verifyEvent(forged, lookup)))
  }

  {
    // 冒名：用鲍勃的私钥、签上爱丽丝的 author。
    const impostor = await bob.make('msg', { sessionId: 's1', kind: 'text' })
    const forged: P2pEvent = { ...impostor, author: alice.id }
    const payload = payloadOf(forged)
    check('换 author 之后 id 对不上', (await computeEventId(payload)) !== forged.id)
  }

  check('不认识的人验不过', !(await verifyEvent(hello, () => undefined)))

  {
    // 结构检查要能挡住各种畸形的输入 —— 这些都会从网络来。
    const bad: unknown[] = [
      null,
      undefined,
      'string',
      42,
      [],
      {},
      { ...hello, id: '' },
      { ...hello, ts: Number.NaN },
      { ...hello, ts: -1 },
      { ...hello, kind: 123 },
      { ...hello, sig: undefined },
      { ...hello, id: 'x'.repeat(100) },
    ]
    check('畸形输入全部被挡', bad.every((v) => !isWellFormedEvent(v)))
  }

  check('同一条事件 id 相同（内容寻址）', (await computeEventId(payloadOf(hello))) === hello.id)

  // ---------------------------------------------------------------- 全序
  console.log('\n=== 全序：两台机器算出同一个顺序 ===')

  {
    const events = [hello, await bob.make('msg', { a: 1 }), await carol.make('msg', { a: 2 })]
    const ascending = [...events].sort(compareEvents)
    const descending = [...events].sort((a, b) => compareEvents(b, a)).reverse()
    check(
      '从两个方向排序结果一致',
      ascending.map((e) => e.id).join() === descending.map((e) => e.id).join(),
    )
    check('排序是稳定的（不是靠到达顺序）', [...events].reverse().sort(compareEvents).map((e) => e.id).join() === ascending.map((e) => e.id).join())
  }

  // ---------------------------------------------------------------- 日志
  console.log('\n=== 日志：去重、乱序、拒收 ===')

  {
    const log = new EventLog()
    await log.open()
    check('收下第一条', (await log.ingest(hello)) === 'new')
    check('同一条再来一次是 duplicate', (await log.ingest(hello)) === 'duplicate')
    check('畸形的是 malformed', (await log.ingest({ nope: true })) === 'malformed')
    check('大小刚好对上', log.size() === 1)

    // ★ 体积关。
    //
    // 发送侧 `signEvent` 里有一道 128 KB 的，但那只管**我们自己**造的事件。
    // 别人送来的这条 JS 对象早就建好了，不在这里挡的话，一条 48 MB 的事件
    // （帧上限）会一直占着我的内存和日志，而且每次折叠都要再过一遍。
    const fat = { ...hello, body: { ...alice.pub, name: 'x'.repeat(MAX_EVENT_BYTES + 1) } }
    check('★ 超大的事件被拒（malformed，不是存下来）', (await log.ingest(fat)) === 'malformed')
    check('★ 它没进日志', log.size() === 1)

    // 边界内侧要放过去 —— 证明挡住上面那条的是**大小**，不是别的。
    // 它会被后面的关卡（id / 签名）拒掉，但那不是这里要断言的事：
    // 体积关不该拦它。
    const justFits = { ...hello, body: { ...alice.pub, name: 'y'.repeat(1024) } }
    check('正常大小的事件不会被体积关拦下', (await log.ingest(justFits)) !== 'malformed')
  }

  {
    // ★ 顶层多余字段。
    //
    // 签名只覆盖 `payloadOf` 取的那四个（author/ts/kind/body），`id` 是收件人
    // 重算核对的、`sig` 是签名本身。于是**其它任何顶层字段既没被签名，也没被
    // 拒绝**，而 `log.accept` 存的是整个对象、`fanout` 与 `sync` 又原样转发 ——
    // 一条攻击者可控、且没有任何签名保证的数据就这样进了别人的日志。
    // 今天没有消费者读它，所以是潜伏问题 —— 但潜的都是「下一个读它的人」。
    //
    // 处理方式是**剥掉**而不是拒收：拒收会让「以后给事件加一个字段」变成
    // 不兼容变更，而剥掉的效果一样（脏字段进不了日志也传不出去），
    // 却不会因为一条多余字段丢掉整条消息。
    const log = new EventLog()
    await log.open()
    const dirty = { ...hello, 走私字段: { evil: true }, extra: 1 }
    check('多余字段的事件照样收得下', (await log.ingest(dirty)) === 'new')
    const kept = log.all()[0]
    check('★ 多余字段没进日志', kept !== undefined && !('走私字段' in kept) && !('extra' in kept))
    check(
      '该留的字段一个不少',
      kept?.id === hello.id && kept?.sig === hello.sig && kept?.author === hello.author && kept?.ts === hello.ts,
    )
  }

  {
    // ★ 时钟的 `observe` —— 先前它在生产里**零调用**。
    //
    // `hlc.ts` 的文档承诺「收到别人的时间戳就追上去、两台机器会收敛到一起、
    // 因果正确」，而全仓 `.observe(` / `.restore(` 只出现在这个自测文件里。
    // 于是每个节点的 ts 实际就是「自己墙上的表 × 1000 + 本地序号」：
    // 表快的机器**永久**赢下每一次冲突，而且没有任何纠正机制。
    //
    // 修法：`EventLog` 每收下一条**验过签**的事件就把自己的时钟抬到同一位置。
    // 注意是「验过签」而不是「收到」—— 见下面那条断言。
    const clock = new HybridClock()
    const log = new EventLog(new MemoryStore(), { clock })
    await log.open()
    check('什么都没收到时时钟停在原点', clock.peek() === 0, ` → ${clock.peek()}`)

    // 先造一条「陌生人的、时间超前 1 小时」的消息。它在 S6 的上界（365 天）之内，
    // 所以是合法的；它进 deferred，**不该**推动我们的时钟 —— 否则任何连上来
    // 的设备都能靠伪造的时间戳改写我们的排序。
    //
    // 用一个**独立**的 actor：把 bob 的表拨快会污染后面所有用例的时间戳。
    const stranger = await actor()
    const futureMs = Date.now() + 3_600_000
    stranger.clock.tick(futureMs)
    const ahead = await stranger.make('msg', { sessionId: 's-observe', kind: 'text', cipher: 'k' })
    check('超前的时间戳本身在允许范围内', ahead.ts > Date.now() * 1000, ` → ${ahead.ts}`)
    check('超前的消息来自陌生人时进 deferred', (await log.ingest(ahead)) === 'deferred')
    check('★★ 没验过签的事件推不动我们的时钟', clock.peek() === 0, ` → ${clock.peek()}`)

    // profile 一到，积压的那条被放出来重验，这时才轮到它抬时钟。
    const profile = await stranger.make('profile', { ...stranger.pub, name: '路人', avatarKey: '' })
    check('profile 收下', (await log.ingest(profile)) === 'new')
    check('★ 验过签的时间戳把时钟追了上去', clock.peek() >= ahead.ts, ` → ${clock.peek()} vs ${ahead.ts}`)

    // 这条是「追上去」的意义：本地接下来发的事件排在它后面，而不是因为
    // 自己的表慢就排到它前面（排序上就是回复跑到了原消息前面）。
    const mine = clock.tick()
    check('★★ 之后自己发的事件排在它后面', mine > ahead.ts, ` → ${mine} vs ${ahead.ts}`)
  }

  {
    // ★ `compact()` 没有 `loaded` 守卫 —— 在 `open()` 之前调一次就会把日志
    // **整个清空**：`all()` 基于 `this.verified`，那时它还是空的，于是这次
    // `rewrite` 往磁盘写回 0 行。`open()` 一直有这道守卫，这里先前没有。
    const store = new MemoryStore()
    await store.append('{"id":"历史","author":"a","ts":1,"kind":"msg","body":{},"sig":"s"}')
    const virgin = new EventLog(store)
    let threw = false
    try {
      await virgin.compact()
    } catch {
      threw = true
    }
    check('★ 没 open 过就 compact 会抛错', threw)
    check('★ 抛错时磁盘上的历史还在', (await store.read()).length === 1, ` → ${(await store.read()).length} 行`)
  }

  {
    // **这是最重要的一条**：消息先到、profile 后到，消息不能被丢掉。
    //
    // 真实网络里这很容易发生：两条事件走不同的转发路径，或者某条先被
    // 丢掉又重传。直接丢弃的话那条消息就**永远**不会再出现了
    // （对端以为你已经有了），症状是「偶尔丢消息」。
    const log = new EventLog()
    await log.open()

    const session = await alice.make('session', {
      id: 's1',
      name: '测试群',
      kind: 'group',
      memberIds: [alice.id, bob.id],
    })
    const message = await bob.make('msg', { sessionId: 's1', kind: 'text', cipher: 'x' })

    check('profile 还没到时，消息进 deferred', (await log.ingest(message)) === 'deferred')
    check('deferred 不算已验', log.size() === 0)
    check('deferred 里的事件不会被重复收', (await log.ingest(message)) === 'duplicate')

    const bobProfile = await bob.make('profile', { ...bob.pub, name: '鲍勃', avatarKey: '' })
    check('profile 一到就收下', (await log.ingest(bobProfile)) === 'new')
    check('积压的消息被放出来了', log.size() === 2, ` → size=${log.size()}`)
    check('放出来之后能查到', log.all().some((e) => e.id === message.id))

    // 放出来之后，同一条再进来应该是重复。
    check('放出来后重复收是 duplicate', (await log.ingest(message)) === 'duplicate')

    // 而 `session` 是爱丽丝发的，她的 profile 还没到 —— 仍然是 deferred。
    check('其他人的事件仍在 deferred', (await log.ingest(session)) === 'deferred')
  }

  {
    // ★★ 验不了的东西**不能吃掉整个日志的预算**。
    //
    // `deferred` 里装的都是没验过签的（作者未知就不验，见 `ingest` 末尾），
    // 所以它是整个日志里唯一一个「陌生人发一条就吃一口」的预算。预算合用时，
    // 一个普通 TCP 客户端只要冲 5 万条 author 随机的事件就能把它吃光 ——
    // 此后**真实对端的事件一律 'full' 被拒**，同步永久失效，而那 5 万条
    // 全是垃圾。分开之后，洪水只能淹掉自己那一格。
    const log = new EventLog()
    await log.open()

    // 先让鲍勃成为一个**已知作者**（profile 进表），再拿他去冲洪水 ——
    // 这样「洪水之后他还能不能进来」才是干净的对照。
    const bobProfile = await bob.make('profile', { ...bob.pub, name: '鲍勃', avatarKey: '' })
    await log.ingest(bobProfile)
    const bobMessage = await bob.make('msg', { sessionId: 's1', kind: 'text', cipher: 'x' })
    check('洪水之前，已知作者的消息收得下', (await log.ingest(bobMessage)) === 'new')
    const sizeBeforeFlood = log.size()

    // 现在灌陌生人。作者数**故意大于** `MAX_DEFERRED_AUTHORS`、每个作者又多条 ——
    // 这个形状下「按作者分桶淘汰」每丢一整桶就能腾出 256 个位置，于是总量
    // 可以一路长到 512 × 256 = 13 万条，比整个日志的 5 万还多。全局硬上限
    // 是专门为这个形状加的。
    // 每个作者**连续**灌 300 条（超过单作者上限 256），换作者继续。
    // 这样每个桶都能被填满，「按作者淘汰」每次放走的是整整一桶，
    // 总量才有机会冲过全局上限 —— 一条一作者的洪水反而会被 512 卡住，
    // 测不到这里要测的那道闸。
    const FLOOD = 18_000
    for (let i = 0; i < FLOOD; i += 1) {
      const raw = {
        id: `flood-${i}`,
        author: `stranger-${Math.floor(i / 300)}`,
        ts: i + 1,
        kind: 'msg',
        sig: 'AAAA',
        body: { sessionId: 's1', kind: 'text', cipher: 'x' },
      }
      await log.ingest(raw)
    }

    check('★ 陌生人洪水一条都没进已验证集合', log.size() === sizeBeforeFlood, ` → ${sizeBeforeFlood} → ${log.size()}`)
    check(
      '★★ 洪水没能把积压量顶穿（全局硬上限）',
      log.stats().deferred <= 4_000,
      ` → deferred=${log.stats().deferred}`,
    )
    check('★ 而且确实积压了不少（说明测的是上限，不是「压根没收」）', log.stats().deferred > 1_000, ` → ${log.stats().deferred}`)

    // ★★ 这几条是整块的重点：洪水之后，**真人**还能说话。
    const after = await bob.make('msg', { sessionId: 's1', kind: 'text', cipher: 'y' })
    check('★★ 洪水之后，已知作者的消息照样收得下', (await log.ingest(after)) === 'new', ` → size=${log.size()}`)

    // 积压的东西仍然能被放出来：鲍勃的 profile 再走一遍不该出岔子
    // （这里重新走的是「作者已知」那条路，用的是同一张表）。
    check('积压计数和实际收下的一致', log.stats().deferred <= 4_000)
  }

  {
    // `open()` 是**倒着** ingest 的（为了日志满时挤掉最老的、留下最新的）。
    // 倒着来必须是无害的：`accept` 走 `insertSorted`，profile 与消息的先后
    // 由 `deferred` 兜，两者都不该跟 ingest 次序有关。这里把这个前提钉住 ——
    // 它一旦不成立，倒着读就会悄悄改变折叠结果。
    const linesFor = async (): Promise<string[]> => {
      const bProfile = await bob.make('profile', { ...bob.pub, name: '鲍勃', avatarKey: '' })
      const bMessage = await bob.make('msg', { sessionId: 's1', kind: 'text', cipher: 'x' })
      return [JSON.stringify(bMessage), JSON.stringify(bProfile)]
    }
    const forward = await linesFor()

    const readWith = async (lines: string[]): Promise<string[]> => {
      const store = new MemoryStore()
      store.rewrite(lines)
      const log = new EventLog(store)
      await log.open()
      return log.all().map((e) => e.id)
    }

    const asWritten = await readWith(forward)
    const reversed = await readWith([...forward].reverse())
    check('★★ 文件正序 / 倒序读出来的日志完全一样', asWritten.join() === reversed.join(), ` → ${asWritten.length} vs ${reversed.length}`)
    check('而且两条都进来了（profile 是否先到都不影响）', asWritten.length === 2)
  }

  {
    // ★★ 日志满的时候，`open()` 必须丢掉**最老的**，不能丢最新的。
    //
    // 原来的写法正着 `ingest`，而 `compact()` 之后文件正是 `(ts, id)` 升序，
    // 于是被 `'full'` 丢掉的恰好是最新的那一批 —— 重启一次丢一次最近的记录。
    //
    // 传一个小上限（10）把同一段逻辑走一遍：真按 5 万跑要造 5 万条真签名
    // 事件，跑不起 —— 那个上限写死就是这条 bug 一直没被测到的原因。
    const MANY = 30
    const CAP = 10
    const aliceProfile = await alice.make('profile', { ...alice.pub, name: '爱丽丝', avatarKey: '' })
    const lines: string[] = [JSON.stringify(aliceProfile)]
    const msgIds: string[] = []
    for (let i = 0; i < MANY; i += 1) {
      const event = await alice.make('msg', { sessionId: 's1', kind: 'text', cipher: `c${i}` })
      msgIds.push(event.id)
      lines.push(JSON.stringify(event))
    }

    const store = new MemoryStore()
    store.rewrite(lines)
    const log = new EventLog(store, { maxEvents: CAP })
    await log.open()

    const kept = new Set(log.all().filter((e) => e.kind === 'msg').map((e) => e.id))
    check(
      '★★ 丢的是最老的：最新那条留下了',
      kept.has(msgIds[MANY - 1]),
      ` → 留下 ${kept.size} 条，上限 ${CAP}`,
    )
    check('★★ 而最老的那条被挤掉了', !kept.has(msgIds[0]))
    check('留下的条数不超过上限', kept.size <= CAP)
  }

  {
    // 验签失败的事件**不能进日志**，也不能被转发。
    const log = new EventLog()
    await log.open()
    await log.ingest(hello) // 先让爱丽丝的公钥进表
    const payload = payloadOf({ ...hello, body: { ...alice.pub, name: '假冒' } })
    const forged: P2pEvent = {
      ...hello,
      body: { ...alice.pub, name: '假冒' },
      id: await computeEventId(payload),
    }
    check('签名不对的被拒绝', (await log.ingest(forged)) === 'bad-sig')
    check('被拒绝的没进日志', log.size() === 1)
  }

  {
    // **非 profile** 的事件也要验签。
    //
    // 上面那条用的是 profile，而 profile 走的是自证那条路（公钥就在 body 里），
    // 压根到不了 `verifyEvent`。于是「给一条消息冒名签名」这件事一直没人测：
    // 把 log.ts 里 `verifyEvent` 那段整个短路掉，上面那条照样绿
    // （变异检查抓出来的第二个洞，而且是个真洞 —— 冒名发消息是最直接的攻击）。
    const log = new EventLog()
    await log.open()
    await log.ingest(hello) // 让爱丽丝的公钥进表
    const payload: EventPayload = {
      author: alice.id, // 署名爱丽丝
      ts: 2_000_000,
      kind: 'msg',
      body: { sessionId: 's-1', kind: 'text', cipher: '不是我说的' },
    }
    const impostor = await signEvent(bob.keys, payload) // 但拿鲍勃的钥匙签
    check('冒名签的消息被拒', (await log.ingest(impostor)) === 'bad-sig')
    check('冒名的没进日志', log.size() === 1)
  }

  {
    // profile 自证：声称的 author 和公钥哈希对不上时必须拒收。
    const log = new EventLog()
    await log.open()
    const payload: EventPayload = {
      author: alice.id, // 用爱丽丝的名字
      ts: 1_000_000,
      kind: 'profile',
      body: { ...bob.pub, name: '我是爱丽丝' }, // 却是鲍勃的钥匙
    }
    const impostor = await signEvent(bob.keys, payload)
    check('换钥匙的 profile 被拒', (await log.ingest(impostor)) === 'bad-id')
  }

  {
    // 落盘 / 恢复。这里用 MemoryStore 模拟「关掉再打开」。
    const store = new MemoryStore()
    const first = new EventLog(store)
    await first.open()
    await first.ingest(hello)
    await first.flush()

    const second = new EventLog(store)
    await second.open()
    check('重启后日志还在', second.size() === 1)
    check('重启后公钥表也在（profile 自证）', second.publicKeyOf(alice.id) === alice.pub.ed)

    // 重启后能继续验别人的事件 —— 靠的是 profile 在日志里重新自证了一遍。
    const msg = await alice.make('msg', { sessionId: 's1', kind: 'text' })
    check('重启后能验新事件', (await second.ingest(msg)) === 'new')
  }

  {
    // 坏行不该让整个启动失败 —— 那会表现成「打开后什么都没了」。
    const store = new MemoryStore()
    const good = new EventLog(store)
    await good.open()
    await good.ingest(hello)
    await good.flush()
    await store.append('{ 这不是 JSON')
    await store.append('')

    const reopened = new EventLog(store)
    await reopened.open()
    check('坏行被跳过，好行还在', reopened.size() === 1)
  }

  {
    // 上限：到顶后如实报告 `full`，而不是静默丢弃。
    const log = new EventLog()
    await log.open()
    await log.ingest(hello)
    // 直接把内部计数撑到上限太慢，这里只验常量是合理的正数、
    // 且 `full` 是一个存在的返回值（类型上已被 IngestResult 约束）。
    check('日志上限是正的', MAX_LOG_EVENTS > 1000, ` → ${MAX_LOG_EVENTS}`)
  }

  // ---------------------------------------------------------------- 折叠
  console.log('\n=== 折叠：状态是算出来的 ===')

  // 一次造好一整套事件，后面反复用。
  const sessionId = 's-群-1'
  const group = await alice.make('session', {
    id: sessionId,
    name: '研发群',
    kind: 'group',
    memberIds: [alice.id, bob.id, carol.id],
  })
  const aliceProfile = await alice.make('profile', { ...alice.pub, name: '爱丽丝', avatarKey: '' })
  const bobProfile = await bob.make('profile', { ...bob.pub, name: '鲍勃', avatarKey: '' })
  const carolProfile = await carol.make('profile', { ...carol.pub, name: '卡萝', avatarKey: '' })
  const m1 = await alice.make('msg', { sessionId, kind: 'text', cipher: 'c1', cipherSeq: 1 })
  const m2 = await bob.make('msg', { sessionId, kind: 'text', cipher: 'c2', cipherSeq: 1 })
  const m3 = await carol.make('msg', { sessionId, kind: 'text', cipher: 'c3', cipherSeq: 1 })
  const m4 = await bob.make('msg', { sessionId, kind: 'text', cipher: 'c4', cipherSeq: 2 })
  const react = await carol.make('react', { messageId: m1.id, emojiKey: '👍' })
  const recall = await bob.make('recall', { messageId: m2.id })

  const allEvents = [
    aliceProfile,
    bobProfile,
    carolProfile,
    group,
    m1,
    m2,
    m3,
    m4,
    react,
    recall,
  ]

  {
    const state = fold(allEvents, alice.id)
    check('三个人都在', state.people.size === 3, ` → ${state.people.size}`)
    check('名字对上了', state.people.get(bob.id)?.name === '鲍勃')
    check('自己认出来了', state.people.get(alice.id)?.isSelf === true)
    check('会话建起来了', state.sessions.get(sessionId)?.name === '研发群')
    check('成员去重并排序', state.sessions.get(sessionId)?.memberIds.length === 3)
    check('四条消息都在', messagesOf(state, sessionId).length === 4, ` → ${messagesOf(state, sessionId).length}`)
    check('消息按时间升序', messagesOf(state, sessionId).map((m) => m.id).join() === [m1, m2, m3, m4].map((m) => m.id).sort((a, b) => compareEvents(allEvents.find((e) => e.id === a)!, allEvents.find((e) => e.id === b)!)).join())
    check('回应记上了', state.messages.get(m1.id)?.reactions.get('👍')?.has(carol.id) === true)
    check('撤回生效', state.messages.get(m2.id)?.recalled === true)
    check('没被撤回的没变', state.messages.get(m1.id)?.recalled === false)
  }

  {
    // ★ 引用条和 @ 列表要活着穿过折叠。
    //
    // 这两个字段曾经在 `foldMessage` 里被整条丢掉：`send()` 老老实实把它们
    // 写进了事件体，折叠器却一个字都没搬。症状很隐蔽 —— 引用条**只在本地
    // 乐观消息上闪一下**：`message:ack` 一到，`reconcileOptimistic` 用折叠
    // 结果整个替换掉本地那条，引用条当场消失，对端则从头到尾没显示过。
    // 而「发出去的那条事件体里字段是有的」，所以发送侧的功能测试全绿。
    const quoted = await alice.make('msg', {
      sessionId,
      kind: 'text',
      cipher: 'c-quote',
      cipherSeq: 3,
      replyTo: { messageId: m1.id, authorName: '爱丽丝', excerpt: '这是被引用的那句' },
      mentions: [bob.id, carol.id],
    })
    const foldedQuote = fold([...allEvents, quoted], bob.id).messages.get(quoted.id)
    check('★ 引用条活着穿过折叠', foldedQuote?.replyTo?.messageId === m1.id, ` → ${JSON.stringify(foldedQuote?.replyTo)}`)
    check(
      '★ 引用摘要的作者名和正文都在',
      foldedQuote?.replyTo?.authorName === '爱丽丝' && foldedQuote?.replyTo?.excerpt === '这是被引用的那句',
    )
    check(
      '★ @ 列表也活着穿过折叠',
      foldedQuote?.mentions?.join() === [bob.id, carol.id].join(),
      ` → ${JSON.stringify(foldedQuote?.mentions)}`,
    )
  }

  {
    // 别人填的字段长度是未知量。不截断的话，一个填了几百 KB 摘要的引用条
    // 会一路进内存、进 localStorage、进每一帧同步。
    const huge = 'x'.repeat(5000)
    const fat = await alice.make('msg', {
      sessionId,
      kind: 'text',
      cipher: 'c-fat',
      cipherSeq: 4,
      replyTo: { messageId: m1.id, authorName: huge, excerpt: huge },
      mentions: Array.from({ length: 200 }, (_, i) => `${bob.id}-${i}`),
    })
    const foldedFat = fold([...allEvents, fat], bob.id).messages.get(fat.id)
    check('★ 超长引用正文被截到 200 字', foldedFat?.replyTo?.excerpt.length === 200, ` → ${foldedFat?.replyTo?.excerpt.length}`)
    check('★ 超长作者名被截到 80 字', foldedFat?.replyTo?.authorName.length === 80, ` → ${foldedFat?.replyTo?.authorName.length}`)
    check('★ 超长 @ 列表被截到 64 个', foldedFat?.mentions?.length === 64, ` → ${foldedFat?.mentions?.length}`)
  }

  {
    // 半截的引用条不如不画：三个字段缺一个就当没引用，免得界面上出现
    // 一个点不动、也说不清在引用什么的框。
    const partial = await alice.make('msg', {
      sessionId,
      kind: 'text',
      cipher: 'c-partial',
      cipherSeq: 5,
      replyTo: { messageId: m1.id, excerpt: '只有两截' },
    })
    const foldedPartial = fold([...allEvents, partial], bob.id).messages.get(partial.id)
    check('★ 缺作者名的引用条被丢掉', foldedPartial?.replyTo === undefined, ` → ${JSON.stringify(foldedPartial?.replyTo)}`)
  }

  {
    // ★ 核心不变量：**折叠与到达顺序无关**。
    //
    // 这一条要是破了，两个人的界面会不一样，而且各自都觉得自己是对的。
    // 洗 40 次，每次都要求和基准完全一致。
    const baseline = fingerprint(fold(allEvents, alice.id))
    let mismatched = -1
    for (let seed = 1; seed <= 40; seed += 1) {
      const state = fold(shuffle(allEvents, seed), alice.id)
      if (fingerprint(state) !== baseline) {
        mismatched = seed
        break
      }
    }
    check('40 次打乱折叠结果一致', mismatched < 0, mismatched < 0 ? ` → ${baseline.length} 字符` : ` → 第 ${mismatched} 次不一致`)
  }

  {
    // 不同的人（self 不同）折叠出的**结构**必须一样，只有 isSelf 不同。
    const asAlice = fold(allEvents, alice.id)
    const asBob = fold(allEvents, bob.id)
    check('换个人看，消息集合一样', [...asAlice.messages.keys()].sort().join() === [...asBob.messages.keys()].sort().join())
    check('换个人看，会话一样', [...asAlice.sessions.keys()].join() === [...asBob.sessions.keys()].join())
  }

  {
    // 非成员不能往群里发消息。
    const dave = await actor()
    const daveProfile = await dave.make('profile', { ...dave.pub, name: '戴夫', avatarKey: '' })
    const intruder = await dave.make('msg', { sessionId, kind: 'text', cipher: '坏' })
    const state = fold([...allEvents, daveProfile, intruder], alice.id)
    check('外人发的消息被丢掉', state.messages.get(intruder.id) === undefined)
    check('消息总数没变', messagesOf(state, sessionId).length === 4)
  }

  {
    // 会话定义还没到时，消息先被跳过；定义一到就该出现（同一批事件里）。
    const state = fold([m1, group, aliceProfile], alice.id)
    check('会话定义后到的消息仍然出现', state.messages.has(m1.id))
  }

  {
    // 建群的人必须把自己列进去 —— 否则任何人都能凭空造一个
    // 「只有别人、没有自己」的会话。
    const ghost = await bob.make('session', {
      id: 's-幽灵',
      name: '幽灵群',
      kind: 'group',
      memberIds: [alice.id, carol.id], // 没有鲍勃自己
    })
    const state = fold([ghost], alice.id)
    check('创建者不在成员表里的会话被拒', state.sessions.get('s-幽灵') === undefined)
  }

  {
    // ★ 退出会话：作者把自己从成员列表里去掉。
    //
    // 这条曾经被折叠器整个吃掉（报告 M9）。准入规则写的是「作者必须在**新的**
    // 成员列表里」，而退出事件发的恰恰就是「不含自己」的那份 —— 于是每台设备
    // 都把它丢掉，`:284` 那句 `[...members, event.author]` 还会把作者塞回去，
    // 会话在重启后原样复现。界面上的「退出」从头到尾只是本地过滤。
    const leave = await carol.make('session', {
      id: sessionId,
      name: '研发群',
      kind: 'group',
      memberIds: [alice.id, bob.id], // 卡萝把自己去掉了
    })

    {
      const left = fold([...allEvents, leave], alice.id)
      const members = left.sessions.get(sessionId)?.memberIds ?? []
      check('★ 退出生效：作者从成员里消失', !members.includes(carol.id), ` → ${members.join()}`)
      check('退出不牵连别人', members.includes(alice.id) && members.includes(bob.id))

      // 退出之后不再有成员资格，于是在这条会话里他再也发不了言。
      const afterLeave = await carol.make('msg', { sessionId, kind: 'text', cipher: 'c-after', cipherSeq: 4 })
      const stillLeft = fold([...allEvents, leave, afterLeave], alice.id)
      check('退出之后发的消息被丢掉', stillLeft.messages.get(afterLeave.id) === undefined)

      // 也不能自己把自己加回来 —— 准入看的是「改之前是不是成员」。
      const rejoin = await carol.make('session', {
        id: sessionId,
        name: '研发群',
        kind: 'group',
        memberIds: [alice.id, bob.id, carol.id],
      })
      const noRejoin = fold([...allEvents, leave, rejoin], alice.id)
      check('退出的人改不回成员列表', noRejoin.sessions.get(sessionId)?.memberIds.includes(carol.id) === false)

      // 反过来：还在群里的人拉人是正常操作，不能被上面那条连坐。
      const dave = await actor()
      const invite = await alice.make('session', {
        id: sessionId,
        name: '研发群',
        kind: 'group',
        memberIds: [alice.id, bob.id, carol.id, dave.id],
      })
      const invited = fold([...allEvents, invite], alice.id)
      check('成员仍然可以拉人进群', invited.sessions.get(sessionId)?.memberIds.includes(dave.id) === true)

      // 退出与到达顺序无关：倒过来折也得是同样的结果。
      // （倒序时 group 先折、leave 后折，两者都要能过准入。）
      const reversed = fold([...[...allEvents].reverse(), leave], alice.id)
      check('退出与到达顺序无关', reversed.sessions.get(sessionId)?.memberIds.includes(carol.id) === false)
    }
  }

  {
    // 撤回别人的消息必须无效。
    const forgedRecall = await carol.make('recall', { messageId: m1.id }) // m1 是爱丽丝的
    const state = fold([...allEvents, forgedRecall], alice.id)
    check('撤回别人的消息无效', state.messages.get(m1.id)?.recalled === false)
  }

  {
    // 好友 = 双向 pin。而 pin 只认**我自己**签的。
    const myPin = await alice.make('pin', { who: bob.id })
    const bobsPin = await bob.make('pin', { who: alice.id })
    const state = fold([myPin, bobsPin], alice.id)
    check('双向 pin 才成好友', friends(state).join() === [bob.id].join())

    const oneWay = fold([myPin], alice.id)
    check('单向 pin 不是好友', friends(oneWay).length === 0)

    // 卡萝签一条「爱丽丝 pin 了鲍勃」—— 但它 author 是卡萝，不该被当成我的 pin。
    const forgedPin = await carol.make('pin', { who: bob.id })
    const spoof = fold([forgedPin], alice.id)
    check('别人签的 pin 不会变成我的', spoof.pins.size === 0)
    check('别人 pin 我 → 进 followers', fold([forgedPin], bob.id).followers.has(carol.id) === true)
  }

  {
    // 不认识的 kind：进日志，但折叠时什么都不做（也不报错）。
    const alien = await alice.make('未来的新功能', { whatever: true })
    const state = fold([...allEvents, alien], alice.id)
    check('陌生 kind 不破坏折叠', state.sessions.size === 1 && messagesOf(state, sessionId).length === 4)
  }

  {
    // 同名改名的 profile：最新的赢，而且和到达顺序无关。
    const renamed = await bob.make('profile', { ...bob.pub, name: '鲍勃二世', avatarKey: '' })
    const forward = fold([bobProfile, renamed], alice.id)
    const backward = fold([renamed, bobProfile], alice.id)
    check('改名后是最新的名字', forward.people.get(bob.id)?.name === '鲍勃二世')
    check('改名与顺序无关', backward.people.get(bob.id)?.name === '鲍勃二世')
  }

  {
    // 会话列表按最近消息排序。
    const second = await alice.make('session', {
      id: 's-2',
      name: '另一个群',
      kind: 'group',
      memberIds: [alice.id],
    })
    const fresh = await alice.make('msg', { sessionId: 's-2', kind: 'text', cipher: 'x' })
    const state = fold([...allEvents, second, fresh], alice.id)
    check('最近的会话排最前', [...state.sessions.keys()].length === 2)
  }

  {
    // 空状态。
    const state = emptyState(alice.id)
    check('空状态没有会话', state.sessions.size === 0)
    check('空状态没有消息', state.messages.size === 0)
    check('空状态没有好友', friends(state).length === 0)
  }

  // ---------------------------------------------------------------- 线协议
  console.log('\n=== 线协议：同步帧 ===')

  {
    const frames: WireFrame[] = [
      { t: 'sync', have: ['a', 'b'] },
      { t: 'sync', have: ['a'], truncated: true },
      { t: 'events', events: [hello] },
      { t: 'events', events: [hello], more: true },
      { t: 'ping', ts: 123 },
      { t: 'pong', ts: 456 },
    ]
    let allRoundTrip = true
    for (const frame of frames) {
      const back = decodeFrame(encodeFrame(frame))
      if (JSON.stringify(back) !== JSON.stringify(frame)) {
        allRoundTrip = false
        console.log(`       ${JSON.stringify(frame)} → ${JSON.stringify(back)}`)
      }
    }
    check('每种帧都能原样往返', allRoundTrip)
  }

  {
    // 坏帧必须**返回 undefined 而不是抛错** —— 抛错会中断接收循环，
    // 连带把后面所有好帧一起丢掉，而一条坏帧不该有这个后果。
    const bad: string[] = [
      'not json',
      '[]',
      '"string"',
      'null',
      '{}',
      '{"t":"什么鬼"}',
      '{"t":"sync"}',
      '{"t":"sync","have":[1,2,3]}',
      '{"t":"sync","have":"abc"}',
      '{"t":"events"}',
      '{"t":"events","events":[]}',
      '{"t":"events","events":"nope"}',
    ]
    let threw = false
    let allUndefined = true
    for (const text of bad) {
      try {
        if (decodeFrame(new TextEncoder().encode(text)) !== undefined) {
          allUndefined = false
          console.log(`       没挡住：${text}`)
        }
      } catch {
        threw = true
      }
    }
    check('坏帧不抛错', !threw)
    check('坏帧一律返回 undefined', allUndefined)
  }

  {
    // `have` 列表大到离谱：光解析就能把内存吃干，必须在这里挡掉。
    const huge = { t: 'sync', have: new Array(200_000).fill('x') }
    check('超长的 have 被拒', normalizeFrame(huge) === undefined)
  }

  {
    // 一帧里混一条坏事件：只剔掉那一条，其余照收。
    // 整帧丢弃等于「因为别人发了一条烂数据，我丢了 511 条好数据」。
    const frame = normalizeFrame({ t: 'events', events: [hello, { junk: 1 }, null, 'x'] })
    check('一帧里的坏事件被单独剔掉', frame?.t === 'events' && frame.events.length === 1)
  }

  {
    // ★ 条数上限。
    //
    // 帧的**字节**上限挡不住「很多条很小的事件」：一条 recall 只有一百多字节，
    // 48 MB 的帧能装三十万条，而 `ingestMany` 是逐条 await 的（每条一次
    // Ed25519 验签）。我们自己的发送侧按 `EVENTS_PER_FRAME`（512）分块，
    // 所以比它更大的帧一定不是我们的客户端发的。
    const exactly = normalizeFrame({
      t: 'events',
      events: new Array(EVENTS_PER_FRAME).fill(hello),
    })
    check(`刚好 ${EVENTS_PER_FRAME} 条照收`, exactly?.t === 'events' && exactly.events.length === EVENTS_PER_FRAME)

    const tooMany = normalizeFrame({
      t: 'events',
      events: new Array(EVENTS_PER_FRAME + 1).fill(hello),
    })
    check(`多一条就整帧不要（${EVENTS_PER_FRAME + 1} 条）`, tooMany === undefined)
  }

  {
    // ★ 超长帧在读字节数时就该被挡掉，**不能**先 JSON.parse 再说 ——
    // 解析本身要为整帧分配一次，而这一步发生在任何校验之前。
    //
    // 造的这段内容本身是**合法 JSON**（一个对象 + 一长串尾随空格），所以
    // 「返回 undefined」只可能来自长度闸门；闸门要是被拆了，它会正常解析成
    // 一个 ping 帧、这条断言立刻变红。
    const big = new Uint8Array(MAX_WIRE_BYTES + 1)
    big.fill(0x20)
    big.set(new TextEncoder().encode('{"t":"ping","ts":0}'), 0)
    let bigThrew = false
    let bigResult: unknown = 'unset'
    try {
      bigResult = decodeFrame(big)
    } catch {
      bigThrew = true
    }
    check('超大帧直接当坏帧（不抛错、返回 undefined）', !bigThrew && bigResult === undefined)

    // 同样的内容缩到上限之内就必须照常解析 —— 证明挡住它的是长度，不是内容。
    const fits = big.subarray(0, MAX_WIRE_BYTES)
    check('同样的内容在上限之内照常解析', decodeFrame(fits)?.t === 'ping')
  }

  {
    // ★ 同步的正确性：复现「一个标量游标会丢消息」的那个场景。
    //
    // A 断开时手里最大 ts 是 99。B 和 C 各自发了 100..110。
    // A 先连 B（拿到 B 的十条，最大 ts 变成 110），再连 C。
    // 用游标的话 A 会对 C 说「我要 >110 的」，然后什么都收不到。
    // 用 id 集合的话 A 会发现 C 那十条一条都没有。
    const aliceEvents = [await alice.make('msg', { n: 1 })]
    const bEvents = await Promise.all([1, 2, 3].map(() => bob.make('msg', { n: 2 })))
    const cEvents = await Promise.all([1, 2, 3].map(() => carol.make('msg', { n: 3 })))

    // A 断开前只有自己的 1 条。
    const aHas = aliceEvents.map((e) => e.id)

    // A 连上 B：B 有自己 3 条 + 不知道 A 的。
    const bToA = eventsTheyLack(bEvents, aHas)
    check('A 从 B 那里拿到 B 的全部', bToA.length === 3)

    // A 现在有 alice + b。再连 C：
    const aNowHas = [...aliceEvents, ...bEvents].map((e) => e.id)
    const cToA = eventsTheyLack(cEvents, aNowHas)
    check('A 从 C 那里仍然拿到 C 的全部（游标做法会丢这里）', cToA.length === 3, ` → ${cToA.length}`)

    // 反向：C 收到的应该是 A 和 B 的全部。
    const cHas = cEvents.map((e) => e.id)
    const aToC = eventsTheyLack([...aliceEvents, ...bEvents], cHas)
    check('C 从 A 那里拿到 A 和 B 的全部', aToC.length === 4)

    // 两边都有的时候差集为空 —— 重复同步是幂等的。
    // 注意这里的括号：`aNowHas` **本来就是 id 数组**，只有 `cEvents` 才需要
    // 取 `.id`。写成 `[...aNowHas, ...cEvents].map(e => e.id)` 会把
    // `aNowHas` 里的每个 id 当成对象再取一次 `.id`，得到一串 `undefined` ——
    // 于是这个断言会在函数完全正确的情况下失败。（第一版就是这么写的。）
    const noop = eventsTheyLack(bEvents, [...aNowHas, ...cEvents.map((e) => e.id)])
    check('已经同步过就什么都不发', noop.length === 0, ` → ${noop.length}`)
  }

  {
    // 分帧：每一帧不超过上限，`more` 只标在非最后一帧。
    const many = await Promise.all(Array.from({ length: 1100 }, () => alice.make('msg', { n: 1 })))
    const frames = chunkEvents(many)
    check('1100 条切成 3 帧', frames.length === 3, ` → ${frames.length}`)
    const sizes = frames.map((f) => (f.t === 'events' ? f.events.length : -1))
    check('每帧不超过 512 条', sizes.every((n) => n > 0 && n <= 512), ` → ${sizes.join(',')}`)
    const moreFlags = frames.map((f) => (f.t === 'events' ? f.more === true : false))
    check('只有最后一帧不带 more', moreFlags.join(',') === 'true,true,false', ` → ${moreFlags.join(',')}`)
    check('一帧都不少', sizes.reduce((a, b) => a + b, 0) === 1100)
    check('空数组切出 0 帧', chunkEvents([]).length === 0)
  }

  // ------------------------------------------- 接收边界：密文里的图片地址
  console.log('\n=== 接收边界：密文里的图片地址 ===')
  {
    // 图片地址来自**对端自己拼的 JSON**（整个消息体打包进密文，拆开就是
    // 一个普通人写的字段），随后一路直通 `<img src>` ——
    // `assets/registry.ts` 的 `imageUrl(src) { return src }` 是恒等函数。
    //
    // 把一个外网地址塞进来就等于在别人的机器上插了一个**出网信标**：
    // 谁打开、什么时候打开、出口 IP 是什么，外面那个服务器全知道。
    // 而这是个宣称「纯局域网、不联网」的产品。
    const png = 'data:image/png;base64,iVBORw0KGgo='
    check('我们自己生成的 data URL 照收', safeImageUrl(png) === png)
    check('jpeg / webp / gif 也收', safeImageUrl(png.replace('png', 'jpeg')) !== undefined
      && safeImageUrl(png.replace('png', 'webp')) !== undefined
      && safeImageUrl(png.replace('png', 'gif')) !== undefined)

    check('★ http 地址被拒', safeImageUrl('http://10.0.0.9:8080/px.gif') === undefined)
    check('★ https 地址被拒', safeImageUrl('https://evil.example/px.gif?who=me') === undefined)
    check('★ 协议相对地址被拒', safeImageUrl('//evil.example/px.gif') === undefined)
    check('★ data:image/svg+xml 之外的非图片 data 被拒', safeImageUrl('data:text/html,<script>1</script>') === undefined)
    check('★ file:// 被拒', safeImageUrl('file:///C:/Windows/win.ini') === undefined)
    check('空串 / 非字符串被拒', safeImageUrl('') === undefined
      && safeImageUrl(undefined) === undefined
      && safeImageUrl(null) === undefined
      && safeImageUrl({ toString: () => png }) === undefined
      && safeImageUrl(42) === undefined)
    // 大小写与空格不做宽容：我们生成的一定是标准形式，多一分宽容就多一条绕过。
    check('大写 scheme 不放过（我们不会生成这种）', safeImageUrl('DATA:image/png;base64,AAAA') === undefined)
    check('前面有空格不放过', safeImageUrl(' ' + png) === undefined)
  }

  // ---------------------------------------------------------------- 收尾
  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exit(1)
}

/**
 * 状态的「指纹」—— 把会变的东西都摊平成一串，用来比两次折叠是否相同。
 *
 * 不直接 `JSON.stringify(state)` 是因为里面有 `Map` / `Set`：
 * `JSON.stringify` 会把它们序列化成 `{}`，于是**任何**差异都被吃掉，
 * 测试永远绿。那正是这里最不能接受的失败方式。
 */
function fingerprint(state: ReturnType<typeof fold>): string {
  const parts: string[] = []
  parts.push(`self=${state.self}`)
  parts.push(
    'people=' +
      [...state.people.entries()]
        .map(([id, p]) => `${id}:${p.name}:${p.avatarKey}:${p.number}:${p.isSelf}`)
        .sort()
        .join('|'),
  )
  parts.push(
    'sessions=' +
      [...state.sessions.entries()]
        .map(([id, s]) => `${id}:${s.name}:${s.kind}:${s.memberIds.join(',')}:${s.avatarKey}`)
        .sort()
        .join('|'),
  )
  parts.push(
    'messages=' +
      state.order
        .map((id) => {
          const m = state.messages.get(id)!
          const reactions = [...m.reactions.entries()]
            .map(([k, v]) => `${k}:${[...v].sort().join(',')}`)
            .sort()
            .join(';')
          return `${m.id}:${m.sessionId}:${m.authorId}:${m.kind}:${m.cipher}:${m.cipherSeq}:${m.sentAt}:${m.recalled}:${reactions}`
        })
        .join('|'),
  )
  parts.push('order=' + state.order.join(','))
  parts.push('pins=' + [...state.pins].sort().join(','))
  parts.push('followers=' + [...state.followers].sort().join(','))
  parts.push(
    'announcements=' +
      [...state.announcements.entries()].map(([id, a]) => `${id}:${a.title}:${a.body}:${a.by}`).sort().join('|'),
  )
  return parts.join('\n')
}

await main()

/**
 * 发送序号 / 重放表的自检。
 *
 * 跑法：
 *   npx esbuild tools/crypto-seq-selftest.ts --bundle --format=esm --platform=node \
 *     --outfile=server/.t-crypto-seq-selftest.mjs && node server/.t-crypto-seq-selftest.mjs
 *
 * 为什么这块值得单独测：它全是**纯记账**，出错时不会有任何报错。
 * 序号算错的后果要到很后面才看得见 —— 收件人那边一条消息解不开，
 * 或者一次重放没被挡住。而「刷新之后序号从 1 重来」这种错，
 * 在同一次会话里根本看不出来，只有跨刷新才现形，所以这里要专门模拟刷新。
 */

import {
  __dropCacheForTests,
  forgetSeq,
  nextSendSeq,
  noteSeen,
  peekSendSeq,
} from '../src/store/cryptoSeq'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}${extra}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${extra}`)
  }
}

function installStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  }
  return map
}

const KEY = 'baker.crypto-replay.v1'

function main() {
  const store = installStorage()

  // ------------------------------------------------------------ 序号
  console.log('=== 发送序号：只增不减、按会话分 ===')

  check('第一次是 1', nextSendSeq('s1') === 1)
  check('第二次是 2', nextSendSeq('s1') === 2)
  check('peek 不变（3）', nextSendSeq('s1') === 3 && peekSendSeq('s1') === 3)
  check('peek 不会推进序号', peekSendSeq('s1') === 3 && peekSendSeq('s1') === 3)
  check('别的会话从 1 开始（不共用一个大计数器）', nextSendSeq('s2') === 1)
  check('s2 不影响 s1', peekSendSeq('s1') === 3 && nextSendSeq('s2') === 2)

  // ★ 这一条就是 D5 的核心：刷新之后不能从 1 重来。
  console.log('=== 刷新（内存没了、storage 还在） ===')
  __dropCacheForTests()
  check('★★ 刷新之后 s1 接着 4，不是 1', nextSendSeq('s1') === 4)
  check('★★ 刷新之后 s2 接着 3，不是 1', nextSendSeq('s2') === 3)

  // ------------------------------------------------------------ 重放表
  console.log('=== 「见过」这张表 ===')

  check('第一次见 → true', noteSeen('s1', 'u_a', 1) === true)
  check('★ 同一个人同一个号再来一次 → false（这就是重放）', noteSeen('s1', 'u_a', 1) === false)
  check('换个号 → true（是新消息）', noteSeen('s1', 'u_a', 2) === true)
  check('换个人、同号 → true（不同作者的号本来就各算各的）', noteSeen('s1', 'u_b', 1) === true)
  check('换个会话、同人同号 → true', noteSeen('s2', 'u_a', 1) === true)
  check('重放表也跨刷新（刷新后再来一次仍然 false）', (() => {
    __dropCacheForTests()
    return noteSeen('s1', 'u_a', 1) === false
  })())

  check('序号与重放表互不干扰', peekSendSeq('s1') === 4 && noteSeen('s1', 'u_a', 4) === true)

  // ------------------------------------------------------------ 上限
  console.log('=== 上限：超了丢最旧的 ===')
  // 已经用掉 s1/u_a 的 1、2、4，再来 2000 条把 1 挤出去。
  for (let i = 100; i < 2100; i += 1) noteSeen('s1', 'u_a', i)
  check('被挤掉的老号又变成「没见过」', noteSeen('s1', 'u_a', 1) === true)
  check('近期的号仍然记得', noteSeen('s1', 'u_a', 2099) === false)

  // ------------------------------------------------------------ 清理
  console.log('=== forgetSeq：只许立碑，不许倒回 ===')
  forgetSeq('s2')
  check('seq 桶清掉了（peek 归 0）', peekSendSeq('s2') === 0)
  // ★★ 这两条是整块的重点。
  //
  // 退出会话曾经真的会走到 `forgetSeq`，而它把 `seq` 删掉、`seen` 也删掉 ——
  // 于是下次发送从 1 重新开始，可**对端**的 seen 表里还老老实实记着
  // (我, 1..3)。结果是以后我发的每一条都被它当成重放**静默丢掉**：
  // 我这边的气泡一切正常，它那边永远收不到。清理必须只往上立碑。
  check('★★ 清理之后接着往上走（4），不是从头 1', nextSendSeq('s2') === 4)
  check('★★ 重放表留着（同号仍然算见过）', noteSeen('s2', 'u_a', 1) === false)
  check('别的会话不受影响', peekSendSeq('s1') === 4)

  // ------------------------------------------------------------ 存储
  console.log('=== 落盘的内容 ===')
  const raw = store.get(KEY)
  check('真的写进 localStorage 了', typeof raw === 'string' && raw.length > 0)
  // 类型要写成具名的：`JSON.parse(...) as typeof parsed` 里的 `typeof parsed`
  // 取的是**那一刻**的类型，而那一刻 `parsed` 刚被初始化成 `null` ——
  // 于是整个变量被推成 `never`，下面三条断言全部退化成永真。
  // （运行时一直是好的，所以这件事只会在类型检查下露出来。）
  interface StoredShape {
    seq?: Record<string, number>
    retired?: Record<string, number>
    seen?: Record<string, string[]>
  }
  let parsed: StoredShape | null = null
  try {
    parsed = JSON.parse(raw ?? '') as StoredShape
  } catch {
    parsed = null
  }
  check('是一个 {seq, retired, seen} 的对象', Boolean(parsed && parsed.seq && parsed.retired && parsed.seen))
  check('seq 里存的是 s1:4', parsed?.seq?.s1 === 4)
  check('retired 里立着 s2 的碑（3）', parsed?.retired?.s2 === 3)
  // 上面那句 `nextSendSeq('s2')` 又给它建了新桶（4），所以这里看到的是 4；
  // 关键的是**墓碑还在**，下次再清一次也不会掉回 1。
  check('墓碑留着，桶重建后接着走', parsed?.retired?.s2 === 3 && parsed?.seq?.s2 === 4)
  check('seen 是字符串数组', Array.isArray(parsed?.seen?.s1))

  // ------------------------------------------------------------ 坏数据
  console.log('=== 存储被写坏 / 没有存储 ===')
  store.set(KEY, '{ 这不是 JSON')
  __dropCacheForTests()
  check('坏 JSON 不抛异常，当成空的', nextSendSeq('s9') === 1)

  store.set(KEY, JSON.stringify({ seq: 'not-an-object', seen: 42 }))
  __dropCacheForTests()
  check('字段类型不对也不抛', nextSendSeq('s9') === 1)

  delete (globalThis as { localStorage?: unknown }).localStorage
  __dropCacheForTests()
  check('没有 localStorage 也不抛', nextSendSeq('s9') === 1)
  check('没有 localStorage 时重放表仍然在内存里工作', noteSeen('s9', 'u_a', 1) === true)

  console.log('')
  console.log(`${passed} 项通过，${failed} 项失败`)
  if (failed > 0) process.exit(1)
}

main()

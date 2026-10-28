/**
 * 端到端自测的公共台子：断言计数 + 一张可以随意插拔的假网络。
 *
 * 抽出来是因为有两个端到端自测（`p2p-node-selftest.ts` 验节点、
 * `p2p-transport-selftest.ts` 验传输层），它们必须对「Rust 那一侧是什么样」
 * 有一致的前提。各留一份的话，改了一边忘了另一边，两个测试就会在
 * 不同的世界里断言同一件事 —— 那种失败最难查。
 */

import type { NetBridge, NetEvent } from '../src/p2p/node'

// ---------------------------------------------------------------- 断言

let passed = 0
let failed = 0

export function check(label: string, ok: boolean, extra = ''): void {
  if (ok) {
    passed++
    console.log(`  ok   ${label}${extra}`)
  } else {
    failed++
    console.log(`  FAIL ${label}${extra}`)
  }
}

export function section(title: string): void {
  console.log(`\n== ${title}`)
}

/** 打印汇总并设置退出码。放在脚本最后一行调。 */
export function report(): void {
  console.log(`\n通过 ${passed}，失败 ${failed}`)
  if (failed > 0) process.exitCode = 1
}

export function counts(): { passed: number; failed: number } {
  return { passed, failed }
}

// ---------------------------------------------------------------- 假网络

/**
 * 把若干个 `NetBridge` 连成一张可以随意插拔的网。
 *
 * 它模拟的是 Rust 那一侧对外表现出的语义，不是它的实现：
 * 断开是立刻的、投递给不在线的对端会抛错、握手成功时**两边**都收到 `linked`。
 */
export class FakeNetwork {
  private readonly bridges = new Map<string, FakeBridge>()

  register(bridge: FakeBridge): void {
    this.bridges.set(bridge.selfId, bridge)
  }

  peer(id: string): FakeBridge | undefined {
    return this.bridges.get(id)
  }

  /** 建立双向链路：两边都收到 `linked`。 */
  async link(a: string, b: string): Promise<void> {
    const left = this.bridges.get(a)
    const right = this.bridges.get(b)
    if (!left || !right) throw new Error('la 里有不存在的节点')
    left.connected.add(b)
    right.connected.add(a)
    left.fire({ kind: 'linked', peer_id: b, addr: '10.0.0.1:7000', info: right.info })
    right.fire({ kind: 'linked', peer_id: a, addr: '10.0.0.2:7000', info: left.info })
  }

  /** 断开双向链路。`reason` 用来验它有没有被原样带到上层。 */
  unlink(a: string, b: string, reason = '对端关闭了连接'): void {
    const left = this.bridges.get(a)
    const right = this.bridges.get(b)
    left?.connected.delete(b)
    right?.connected.delete(a)
    left?.fire({ kind: 'unlinked', peer_id: b, reason })
    right?.fire({ kind: 'unlinked', peer_id: a, reason })
  }
}

export class FakeBridge implements NetBridge {
  /**
   * 本机 id。
   *
   * **不是** `readonly`，而且构造时给的值可能只是占位符 —— 真桥也是这样：
   * id 由公钥算出来，在 `start({ selfId })` 的那一刻才告诉传输层。
   * 构造时就得知道 id 的假桥会逼出一个真实代码里不存在的时序问题
   * （先有 id 还是先有桥），那是假问题。
   */
  selfId: string
  readonly connected = new Set<string>()
  info: unknown = {}

  private handler: ((event: NetEvent) => void) | null = null
  private readonly network: FakeNetwork

  /** 收到的帧，按 (来源, 字节数) 记一笔，用来验分帧。 */
  readonly received: { from: string; bytes: number }[] = []
  /** 发出去的帧。分帧要在这上面验 —— 收到的帧是对方发来的。 */
  readonly sent: { to: string; bytes: number }[] = []
  /**
   * 真正过线的字节，一条不漏。
   *
   * `sent` 只记长度，验分帧够用；但要回答「明文有没有漏出去」必须看**内容**。
   * 那是端到端加密唯一有意义的判据：只断言「界面上解出来了」，在两台机器
   * 碰巧共用一把钥匙（或者干脆没加密）的实现下同样是绿的。
   */
  readonly wire: { to: string; data: Uint8Array }[] = []

  constructor(network: FakeNetwork, selfId: string, info: unknown) {
    this.network = network
    this.selfId = selfId
    this.info = info
  }

  subscribe(handler: (event: NetEvent) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }

  /**
   * 起节点。
   *
   * 这里**真的**收下 `selfId` 并按它登记自己 —— 和真桥一样。构造时给的
   * 临时 id 在这一刻被纠正，之后所有路由都按真实 id 走。
   */
  async start(opts: { selfId: string; info: unknown }): Promise<number> {
    this.selfId = opts.selfId
    this.info = opts.info
    this.network.register(this)
    return 7000
  }

  async stop(): Promise<void> {
    this.connected.clear()
  }

  async send(peerId: string, payload: Uint8Array): Promise<void> {
    if (!this.connected.has(peerId)) {
      throw new Error(`${peerId} 不在线`)
    }
    const peer = this.network.peer(peerId)
    if (!peer) throw new Error(`${peerId} 不存在`)
    // 在这里**拷一份**，而且两处都要拷（报告 T6）。
    //
    // 真网卡上字节是离开这台机器的：发送方之后再改自己的缓冲区，不会追溯性
    // 改掉对端收到的东西，也不会改掉「线上到底走过什么」这个事实。原来两处
    // 存的都是同一个 Uint8Array 别名，于是产品代码事后 `buf.fill(0)` 会**同时**
    // 把对端收到的帧和自检读的 `wire` 证据一起改掉 —— 而
    // `p2p-transport-selftest.ts` 的「明文没有出现在任何一条过线的字节里」
    // 读的正是 `wire`，等于让被测代码有机会擦掉自己的证据。
    this.sent.push({ to: peerId, bytes: payload.length })
    this.wire.push({ to: peerId, data: payload.slice() })
    peer.received.push({ from: this.selfId, bytes: payload.length })
    peer.fire({ kind: 'frame', from: this.selfId, data: payload.slice() })
  }

  async broadcast(payload: Uint8Array): Promise<number> {
    let n = 0
    for (const id of this.connected) {
      await this.send(id, payload)
      n++
    }
    return n
  }

  async setInfo(info: unknown): Promise<void> {
    this.info = info
  }

  async announce(): Promise<void> {}

  /** 把事件交给上层。上层内部是异步的，所以调用方随后要 `settle()`。 */
  fire(event: NetEvent): void {
    this.handler?.(event)
  }
}

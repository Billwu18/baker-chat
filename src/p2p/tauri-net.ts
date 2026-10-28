/**
 * `NetBridge` 的 Tauri 实现 —— 全应用**唯一**一处 `invoke('net_*')`。
 *
 * Rust 那边（`src-tauri/src/lib.rs`）只有 10 个命令和一条 `baker://net`
 * 事件流，这个文件把它们翻译成 `node.ts` 认识的 `NetBridge`。翻译本身
 * 没什么内容，值得写下来的只有下面三件容易踩的事。
 *
 * ## 一、为什么字节要转成 `Array.from`
 *
 * `net_send(peer_id, payload: Vec<u8>)` 的参数是 Rust 的 `Vec<u8>`，
 * 而 Tauri 的 `invoke` 走 JSON 序列化。`JSON.stringify(new Uint8Array([1,2]))`
 * 得到的是 `{"0":1,"1":2}` —— 一个**对象**，反序列化成 `Vec<u8>` 会失败，
 * 而且报的错是「invalid type: map, expected a sequence」这种和实际原因
 * 隔了两层的话。所以出去的时候显式 `Array.from`，回来的时候显式
 * `Uint8Array.from`。两端都要写，只写一边不会报错，只会让你的消息变空。
 *
 * （代价是 JSON 数字数组比二进制大 3～6 倍。局域网同步一次几百 KB，
 * 这几毫秒不值得为它引入一个自定义的 IPC 通道。真要优化的时候，
 * 优化点是「别把整个日志一次性发过去」，不是「编码再省几个字节」。）
 *
 * ## 二、为什么 `subscribe` 返回的是同步的退订函数
 *
 * `listen()` 是异步的，而 `NetBridge.subscribe` 必须**同步**返回退订函数
 * —— 因为 `P2pNode.start()` / `stop()` 的调用方不 await 订阅这件事。
 * 所以这里先把 promise 存着，退订时如果还没 resolve，就把「已退订」
 * 记下来，等 resolve 了立刻补一次 unlisten。少了这一步，一个在
 * `start()` 之后马上 `stop()` 的节点会留下一个永远活着的监听器，
 * 于是**停掉的节点仍然在收帧**。
 *
 * ## 三、什么错该抛、什么错不该抛
 *
 * `net_send` 发给一个不在线的人会返回中文错误。**这里让它原样抛出去**，
 * 由 `node.ts` 决定怎么办 —— 而它在每一个调用点都接了 `catch`
 * （`node.ts:256/275/409/445/467/555/588`），并且每个点做的事都不一样：
 * 补发历史失败就中止这一轮、发文件失败只跳过这个人。把判断塞在桥里，
 * 就等于替上层决定「发不出去」是什么意思，而那个意思只有上层知道。
 *
 * 反过来 `net_start` 起不来（端口被占）不能吞：那不是「这次没成功」，
 * 是「这个程序现在不能用」。吞掉它的后果是界面显示「已连接」而实际
 * 什么都不通 —— 这是最贵的一类错误。
 *
 * 中间那类是 `net_stop`：窗口正在关，能做的只有记一笔，不该挡退出。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { NetBridge, NetEvent } from './node'

/** Rust 侧事件名。改了这里也要改 `src-tauri/src/lib.rs:16` 的 `EVENT`。 */
const EVENT = 'baker://net'

/** Rust 发的 `NodeEvent`（`#[serde(tag = "kind", rename_all = "snake_case")]`）。 */
type RawEvent =
  | { kind: 'discovered'; peer: { id: string; addr: string | null; info: unknown } }
  | { kind: 'lost'; id: string }
  | { kind: 'linked'; peer_id: string; addr: string; info: unknown }
  | { kind: 'unlinked'; peer_id: string; reason: string }
  | { kind: 'frame'; from: string; data: number[] | { [key: string]: number } }

export class TauriNetBridge implements NetBridge {
  private unlisten: UnlistenFn | null = null
  private unlistenPending = false

  async start(opts: { selfId: string; info: unknown }): Promise<number> {
    // 不传 tcp_port / udp_port：让 Rust 用它自己的默认端口。
    // 端口是**两端约定**的一部分（`net::DEFAULT_TCP_PORT`），在 TS 里
    // 再硬编一份迟早会和 Rust 那份不一致，而那种不一致的症状是
    // 「同一个局域网里谁都发现不了谁」，最难查。
    return await invoke<number>('net_start', { selfId: opts.selfId, info: opts.info })
  }

  async stop(): Promise<void> {
    // 先退订再停：反过来的话，`net_stop` 期间到达的事件会打到已经
    // 没有接收者的管道上（无害），但停完之后那条监听器还活着（有害）。
    this.detach()
    await invoke('net_stop').catch((error) => {
      // 停不下来不该挡住退出流程 —— 窗口都要关了，能做的只有记下来。
      console.error('[net] 停节点失败：', error)
    })
  }

  async send(peerId: string, payload: Uint8Array): Promise<void> {
    await invoke('net_send', { peerId, payload: Array.from(payload) })
  }

  /**
   * 广播给所有已连接的对端，返回**实际发出去的人数**。
   *
   * 不是「在线人数」：发到一半对方掉线是有可能的，所以返回值严格小于
   * 当时看到的连接数也不算异常。
   */
  async broadcast(payload: Uint8Array): Promise<number> {
    return await invoke<number>('net_broadcast', { payload: Array.from(payload) })
  }

  async setInfo(info: unknown): Promise<void> {
    await invoke('net_set_info', { info })
  }

  async announce(): Promise<void> {
    await invoke('net_announce')
  }

  /** 手填地址直连（组播被交换机/防火墙挡住时的后路）。 */
  async connect(addr: string): Promise<void> {
    await invoke('net_connect', { addr })
  }

  subscribe(handler: (event: NetEvent) => void): () => void {
    let stopped = false

    void listen<RawEvent>(EVENT, (message) => {
      const event = translate(message.payload)
      if (event) handler(event)
    }).then((unlisten) => {
      if (stopped || this.unlistenPending) {
        // 订阅还没落地就已经退订了：立刻补一次，不然这条监听器会一直活着。
        unlisten()
        return
      }
      this.unlisten = unlisten
    })

    return () => {
      stopped = true
      this.detach()
    }
  }

  private detach(): void {
    if (this.unlisten) {
      this.unlisten()
      this.unlisten = null
      return
    }
    // listen() 还没 resolve。标记一下，让它 resolve 时自己收掉。
    this.unlistenPending = true
  }
}

// ---------------------------------------------------------------- 翻译

/**
 * Rust 的 `NodeEvent` → TS 的 `NetEvent`。
 *
 * 不认识的 kind 返回 `undefined` 而不是抛错：Rust 那边加一个新事件类型
 * （比如将来的「传输统计」）不应该让**整个接收循环**死掉。一条读不懂的
 * 事件的最佳处理方式就是当它没来过 —— 后面那些还是好的。
 */
function translate(raw: RawEvent): NetEvent | undefined {
  switch (raw.kind) {
    case 'discovered':
      return { kind: 'discovered', peer: { id: raw.peer.id, addr: raw.peer.addr, info: raw.peer.info } }
    case 'lost':
      return { kind: 'lost', id: raw.id }
    case 'linked':
      return { kind: 'linked', peer_id: raw.peer_id, addr: raw.addr, info: raw.info }
    case 'unlinked':
      return { kind: 'unlinked', peer_id: raw.peer_id, reason: raw.reason }
    case 'frame':
      return { kind: 'frame', from: raw.from, data: toBytes(raw.data) }
    default:
      return undefined
  }
}

/**
 * 把 Rust 送来的字节还原成 `Uint8Array`。
 *
 * 正常是 `number[]`（`Vec<u8>` 的默认序列化），但 Tauri 在某些路径上
 * 会把字节数组喂成 `{ "0": 1, "1": 2 }` 这种对象 —— 这时 `Uint8Array.from`
 * 会**静默**产出一个全零数组（对象的 length 是 undefined，按 0 处理）。
 * 全零帧的后果是「每一条同步都失败，但报错信息指向解密而不是传输」，
 * 所以这里显式认两种情况，认不出来就抛 —— 抛在读取处比抛在解密处好查。
 */
function toBytes(data: number[] | { [key: string]: number }): Uint8Array {
  if (Array.isArray(data)) return Uint8Array.from(data)
  if (data && typeof data === 'object') {
    const keys = Object.keys(data).map(Number).sort((a, b) => a - b)
    if (keys.length > 0 && keys.every((k, i) => k === i)) {
      return Uint8Array.from(keys.map((k) => data[k]))
    }
  }
  throw new Error('传输层收到的帧不是字节数组')
}

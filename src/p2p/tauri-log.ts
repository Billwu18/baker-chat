/**
 * `LogStore` 的落盘实现 —— 事件日志是**唯一**一份需要跨重启活下来的数据。
 *
 * 会话、消息、好友、公告、密钥包全都在事件日志里，界面上的状态是每次
 * 现折出来的。所以这个文件一旦丢东西，丢的不是缓存，是**唯一的原件**：
 * 消息会真的消失，而且没有任何别的地方能把它补回来。
 *
 * ## 为什么不用 `localStorage`
 *
 * 两个理由，第二个是决定性的：
 *
 * 1. 配额。`localStorage` 在浏览器里通常是 5～10MB，一万条事件就到顶了。
 *    而配额满的时候 `setItem` **抛异常**，多数代码没接 —— 表现是
 *    「聊到某一天，从此以后发的消息重启就没了」。
 * 2. 写放大。每来一条事件都要把整份日志重新序列化一遍存进去，
 *    一万条时每条消息的代价是几百 KB 的字符串操作。这是 O(n²)。
 *
 * 文件追加没有这两个问题，代价是每次写要过一次 IPC。
 *
 * ## 批量与串行
 *
 * 一次 IPC 只带一行太浪费，所以这里**攒一个微任务批次**：同一个 tick 里
 * 连着来的 `append` 合成一次 `log_append(lines)`。同时保证两件事：
 * - 多个并发 `append` 共享同一个 promise，所以调用方 `await` 到的
 *   永远是「我这一行确实写下去了」；
 * - 写入本身串行。并发调 `invoke` 的完成顺序没有保证，两个批次的
 *   `log_append` 交错落盘会把日志的顺序打乱 —— 顺序对这个系统不是
 *   可有可无的（游标、`compareEvents`、压缩都依赖它）。
 */

import { invoke } from '@tauri-apps/api/core'
import type { LogStore } from './log'

export class TauriLogStore implements LogStore {
  /** 已经攒下、还没写出去的行。 */
  private pending: string[] = []
  /** 当前这一批的 promise。非 null 时新来的 `append` 挂到它上面。 */
  private batch: Promise<void> | null = null
  /** 正在进行的写盘。用来把写入串行化。 */
  private writing: Promise<void> | null = null

  async read(): Promise<string[]> {
    const lines = await invoke<string[]>('log_read')
    // Rust 侧按 `\n` 切，末尾的换行会切出一个空串。留着它会让 `open()`
    // 多解析一次空行 —— 无害，但空行会在每次压缩时被重新写出去，越积越多。
    return lines.filter((line) => line.trim() !== '')
  }

  async append(line: string): Promise<void> {
    if (!line.trim()) return
    this.pending.push(line)
    if (!this.batch) {
      this.batch = this.drain()
    }
    return this.batch
  }

  async rewrite(lines: string[]): Promise<void> {
    // 重写要把待写的那些也带上，否则压缩期间正在排队的事件会被压在
    // 文件里永远到不了 —— 压缩的语义是「这份内容就是全部」，不是
    // 「把旧的删掉，新的稍后再说」。
    const all = [...this.pending, ...lines.filter((line) => line.trim() !== '')]
    this.pending = []
    await this.writing
    await invoke('log_rewrite', { lines: all })
  }

  /** 把攒着的那批写下去。 */
  private async drain(): Promise<void> {
    // 先让出一个微任务：同一个 tick 里紧接着来的 `append` 会进这一批。
    await Promise.resolve()
    const batch = this.pending
    this.pending = []
    this.batch = null
    if (batch.length === 0) return

    // 串行化。前一批没写完就等它 —— 交错的落盘顺序会让日志乱序。
    if (this.writing) await this.writing
    const write = invoke<void>('log_append', { lines: batch }).finally(() => {
      if (this.writing === write) this.writing = null
    })
    this.writing = write
    return write
  }
}

/**
 * 现在跑在 Tauri 里吗。
 *
 * `npm run dev` 用 Vite 直接开一个浏览器标签页时没有这个对象，那时
 * `invoke` 会抛「window.__TAURI_INTERNALS__ is undefined」—— 报错本身
 * 清楚，但发生在启动路径上，会连带把整个应用挡住。所以先问一句。
 */
export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

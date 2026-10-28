/**
 * `@tauri-apps/api` 的替身 —— **只给自检用**。
 *
 * 为什么要有这个文件：`src/p2p/tauri-net.ts` 是全应用唯一一处 `invoke('net_*')`，
 * 而且藏着一段容易写错的逻辑（`listen()` 是异步的，`subscribe()` 却必须同步
 * 返回退订函数 —— 订阅还没落地就退订的那个竞态）。它原来**零测试**，唯一的
 * 原因是它 import 了 `@tauri-apps/api`，在 node 里加载不起来（报告 T4）。
 *
 * 这里不模拟 Tauri，只做两件事：**记下调了什么**，以及**把回调的控制权交给测试**
 * （什么时候 resolve、什么时候塞一条事件进来）。esbuild 把 `core` 与 `event`
 * 两条 specifier 都 alias 到本文件 —— 所以它同时导出 `invoke` 和 `listen`。
 */

export type UnlistenFn = () => void

export interface InvokeCall {
  cmd: string
  args: unknown
}

export const invokes: InvokeCall[] = []

let impl: ((cmd: string, args: unknown) => unknown) | null = null

interface Listener {
  id: number
  channel: string
  cb: (message: { payload: unknown }) => void
}

const listeners: Listener[] = []
const pending: { id: number; resolve: (fn: UnlistenFn) => void }[] = []
const unlistenCalls: number[] = []
let nextId = 0

/** 每个用例开头调一次。 */
export function resetStub(): void {
  invokes.length = 0
  listeners.length = 0
  pending.length = 0
  unlistenCalls.length = 0
  impl = null
  nextId = 0
}

/** 让某条命令返回指定值，或抛指定错误。 */
export function setInvokeImpl(next: ((cmd: string, args: unknown) => unknown) | null): void {
  impl = next
}

export async function invoke<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  invokes.push({ cmd, args })
  if (impl) return (await impl(cmd, args)) as T
  return undefined as T
}

export function lastInvoke(): InvokeCall | undefined {
  return invokes[invokes.length - 1]
}

export function commands(): string[] {
  return invokes.map((c) => c.cmd)
}

/**
 * 故意**不立刻 resolve**：真实 Tauri 的 `listen()` 是异步的，而那个竞态
 * （订阅还没落地就退订）正是要测的东西。落地时机由 `resolveListeners()` 决定。
 */
export function listen<T>(channel: string, cb: (message: { payload: T }) => void): Promise<UnlistenFn> {
  const id = nextId++
  listeners.push({ id, channel, cb: cb as (m: { payload: unknown }) => void })
  return new Promise<UnlistenFn>((resolve) => {
    pending.push({ id, resolve })
  })
}

/** 让所有挂着的 `listen()` 落地，返回它们各自的 unlisten（会记一次调用）。 */
export function resolveListeners(): void {
  for (const p of pending.splice(0)) {
    p.resolve(() => {
      unlistenCalls.push(p.id)
    })
  }
}

export function unresolvedListenCount(): number {
  return pending.length
}

/** 往所有监听器塞一条事件（模拟 Rust 那边推上来）。 */
export function fireListeners(payload: unknown): void {
  for (const l of listeners) l.cb({ payload })
}

/** 每个 id 的 unlisten 被调了几次 —— 用来抓「该收的时候没收」和「收了两遍」。 */
export function unlistenIds(): number[] {
  return [...unlistenCalls]
}

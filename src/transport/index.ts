/**
 * 传输层工厂 —— 全应用唯一一处知道「消息到底怎么出门」的地方。
 *
 * ## 分成 prepare + create 两步的理由
 *
 * 本机身份（`src/crypto/device.ts`）是异步生成的：WebCrypto 生成密钥对不是
 * 同步操作，第一次跑还要落盘。而 `ChatStore` 的构造是同步的，React 挂载
 * 也是同步的。两者对不上。
 *
 * 所以 `prepareTransport()` 在 React 挂载**之前** await 一次，把身份备好、
 * 把传输层建好；之后 `createTransport()` 就是纯同步的。
 * 调用点在 `src/main.tsx`。
 *
 * ## 为什么 `createTransport()` 不再有「现造一个」的兜底
 *
 * v1 有一条 `if (prepared) return prepared` 之外的分支，用配置里的 id
 * 现造一个连接。那是为服务器准备的：连不上不影响启动，界面会显示登录页。
 *
 * P2P 里没有这个东西。局域网客户端一旦没有身份就没有 id，没有 id 就
 * 既不能被验证也不能被寻址 —— 现造一个只能造出一个连自己都不认识的
 * 对象。所以这里直接抛。真发生时（`main.tsx` 已经 `.catch` 过一次）
 * 说明启动路径被改了，早报错比带着半个应用跑好。
 */

import type { ChatTransport } from './types'
import { loadConfig } from '../config'
import { getDeviceIdentity } from '../crypto/device'
import type { IdentityKeys } from '../crypto/keys'
import { MemoryBlobStore } from '../p2p/blob'
import { MemoryStore } from '../p2p/log'
import { TauriNetBridge } from '../p2p/tauri-net'
import { inTauri, TauriLogStore } from '../p2p/tauri-log'
import { P2pTransport } from './local'

let prepared: ChatTransport | null = null

/**
 * 准备传输层时身份出问题的原因。见 `consumeIdentityError()`。
 *
 * 为什么不是抛出去、也不是只打一行日志：没有身份密钥意味着**算不出 id**，
 * 而 id 是这个系统里唯一的地址。带着一个空 id 跑起来，症状是「谁都不认识
 * 我、我也找不到任何人」，全程零报错。这是最贵的一类 bug，必须让界面说出来。
 */
let identityError: unknown = null

/**
 * 取走身份出错的原因（取一次就清空）。没出错返回 `null`。
 *
 * 调用方（`ChatStore.start()`）负责把它变成界面上看得见的一句话。
 */
export function consumeIdentityError(): unknown {
  const error = identityError
  identityError = null
  return error
}

/**
 * 在 `createRoot(...).render(...)` 之前调一次。
 *
 * 和 v1 不同，这里的失败**会**真的挡住传输层 —— 见文件头。但函数本身不抛：
 * 原因记在 `identityError` 里，让界面起来之后讲得清，而不是让用户面对一个
 * 白屏。
 */
export async function prepareTransport(): Promise<void> {
  if (prepared) return

  let identity: IdentityKeys
  try {
    identity = await getDeviceIdentity()
  } catch (error) {
    identityError = error
    console.error('[transport] 本机身份不可用，聊天功能无法启动：', error)
    return
  }

  const config = loadConfig()

  try {
    prepared = await P2pTransport.create({
      keys: identity,
      net: new TauriNetBridge(),
      // 事件日志是唯一需要跨重启活下来的数据。不在 Tauri 里（用 Vite
      // 直接在浏览器开一个页面）退化成内存 —— 能用，但关掉就没了，
      // 所以要留一条明确的日志，免得被当成「消息丢了」的 bug 报上来。
      store: inTauri() ? new TauriLogStore() : memoryStoreWithWarning(),
      blobs: new MemoryBlobStore(),
      // 自我介绍：局域网里别人「附近的人」列表上显示的东西。
      // 不带任何标识符 —— 名字是用户自己填的，不是从设备名读的。
      info: { name: config.displayName || '' },
      profile: { name: config.displayName || '', avatarKey: config.avatarKey || '' },
    })
  } catch (error) {
    identityError = error
    console.error('[transport] 传输层建不起来：', error)
  }
}

function memoryStoreWithWarning(): MemoryStore {
  console.warn(
    '[transport] 不在 Tauri 里运行，事件日志只存在内存中 —— 关掉窗口聊天记录就没了。',
  )
  return new MemoryStore()
}

/**
 * 同步拿传输层。
 *
 * 没 prepare 过就抛。这条路径上没有任何可以拿来兜底的东西（见文件头），
 * 而调用方 `ChatStore` 本来就在 `prepareTransport()` 之后才构造。
 */
export function createTransport(): ChatTransport {
  if (!prepared) {
    throw new Error('传输层还没准备好：prepareTransport() 必须先 await 完成')
  }
  return prepared
}

/** 测试与「重启节点」用：丢掉已经造好的那个。 */
export function resetTransport(): void {
  prepared = null
}

export type { ChatTransport } from './types'

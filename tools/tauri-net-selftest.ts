/**
 * `src/p2p/tauri-net.ts` 的自检 —— 全应用唯一一处 `invoke('net_*')`。
 *
 * 跑法（要 alias，见 `tools/check-all.ps1` 里的 esbuild 命令行）：
 *   npx esbuild tools/tauri-net-selftest.ts --bundle --format=esm --platform=node \
 *     --alias:@tauri-apps/api/core=./tools/stub-tauri.ts \
 *     --alias:@tauri-apps/api/event=./tools/stub-tauri.ts \
 *     --outfile=.tmp/build/tauri-net-selftest.mjs && node .tmp/build/tauri-net-selftest.mjs
 *
 * 为什么值得单独测（报告 T4 里最刺眼的那条）：几千行 P2P 断言全跑在
 * `FakeBridge` 上，而线上真身是这个文件 —— 零测试。它自己也有两处容易写错、
 * 写错了「功能看起来全对」的地方：
 *   1. `listen()` 是异步的，`subscribe()` 却必须**同步**返回退订函数。
 *      订阅还没落地就退订，监听器会一直活着（或者反过来，被收掉两次）。
 *   2. `toBytes`：Tauri 某些路径把字节喂成 `{"0":1,...}` 这种对象，
 *      `Uint8Array.from` 对它会**静默**产出全零数组 —— 症状是「每条同步都
 *      失败，但报错指向解密」。
 */

import { TauriNetBridge } from '../src/p2p/tauri-net'
import type { NetEvent } from '../src/p2p/node'
import {
  commands,
  fireListeners,
  invokes,
  lastInvoke,
  resetStub,
  resolveListeners,
  setInvokeImpl,
  unlistenIds,
  unresolvedListenCount,
} from './stub-tauri'

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

function section(name: string) {
  console.log(`\n=== ${name} ===`)
}

function report() {
  console.log('')
  console.log('============================================')
  console.log(`  通过 ${passed}，失败 ${failed}`)
  console.log('============================================')
  if (failed > 0) process.exitCode = 1
}

async function main() {
  // ---------------------------------------------------------- 命令映射
  section('命令名与参数形状')
  {
    resetStub()
    setInvokeImpl((cmd) => (cmd === 'net_start' ? 41231 : undefined))
    const bridge = new TauriNetBridge()

    const port = await bridge.start({ selfId: 'u_me', info: { name: '我' } })
    check('start 返回 Rust 给的端口号', port === 41231, ` → ${port}`)
    check(
      'start 只传 selfId / info（端口由 Rust 定，TS 不硬编）',
      JSON.stringify(lastInvoke()) ===
        JSON.stringify({ cmd: 'net_start', args: { selfId: 'u_me', info: { name: '我' } } }),
      ` → ${JSON.stringify(lastInvoke())}`,
    )

    await bridge.send('u_bob', new Uint8Array([1, 2, 255]))
    check('send 走 net_send', lastInvoke()?.cmd === 'net_send')
    check(
      'payload 变成**普通数字数组**再交给 invoke（Tauri 走 JSON，Uint8Array 会被序列化成对象）',
      Array.isArray((lastInvoke()?.args as { payload: unknown }).payload) &&
        JSON.stringify((lastInvoke()?.args as { payload: unknown }).payload) === '[1,2,255]',
      ` → ${JSON.stringify((lastInvoke()?.args as { payload: unknown }).payload)}`,
    )

    setInvokeImpl((cmd) => (cmd === 'net_broadcast' ? 3 : undefined))
    const n = await bridge.broadcast(new Uint8Array([9]))
    check('broadcast 把 Rust 返回的「真正发出去几个」原样返回', n === 3, ` → ${n}`)

    await bridge.setInfo({ name: '改个名' })
    check('setInfo 走 net_set_info', lastInvoke()?.cmd === 'net_set_info')
    await bridge.announce()
    check('announce 走 net_announce（组播问一声）', lastInvoke()?.cmd === 'net_announce')
    await bridge.connect('127.0.0.1:41231')
    check(
      'connect 把地址传下去（组播被挡时的后路）',
      lastInvoke()?.cmd === 'net_connect' &&
        (lastInvoke()?.args as { addr: string }).addr === '127.0.0.1:41231',
    )

    check(
      '没有多余的命令被调用',
      commands().join(',') === 'net_start,net_send,net_broadcast,net_set_info,net_announce,net_connect',
      ` → ${commands().join(', ')}`,
    )
  }

  // ------------------------------------------------------- 事件翻译
  section('Rust 事件 → NetEvent')
  {
    resetStub()
    const bridge = new TauriNetBridge()
    const seen: NetEvent[] = []
    bridge.subscribe((event) => seen.push(event))
    resolveListeners()

    fireListeners({ kind: 'discovered', peer: { id: 'u_b', addr: '10.0.0.2:4123', info: { n: 1 } } })
    check(
      'discovered 带上 id / addr / info',
      seen[0]?.kind === 'discovered' &&
        (seen[0] as { peer: { id: string } }).peer.id === 'u_b',
      ` → ${JSON.stringify(seen[0])}`,
    )

    fireListeners({ kind: 'lost', id: 'u_b' })
    check('lost 带上 id', seen[1]?.kind === 'lost' && (seen[1] as { id: string }).id === 'u_b')

    fireListeners({ kind: 'linked', peer_id: 'u_b', addr: '10.0.0.2:9', info: {} })
    check('linked 保留 Rust 的 snake_case 字段名（上层按这个读）', seen[2]?.kind === 'linked')

    fireListeners({ kind: 'unlinked', peer_id: 'u_b', reason: '对端关了' })
    check(
      'unlinked 带上原因（这条会一路显示到界面上）',
      seen[3]?.kind === 'unlinked' && (seen[3] as { reason: string }).reason === '对端关了',
    )

    const before = seen.length
    fireListeners({ kind: '将来才有的新事件', 随便: 1 })
    check('读不懂的 kind 被当成没来过，而不是让接收循环死掉', seen.length === before)

    // frame：正常是 number[]，但 Tauri 有的路径会给成 {"0":1,...}。
    fireListeners({ kind: 'frame', from: 'u_b', data: [1, 2, 3] })
    const arrFrame = seen[seen.length - 1] as { kind: string; from: string; data: Uint8Array }
    check(
      'frame 的数组成正确还原',
      arrFrame.kind === 'frame' && Array.from(arrFrame.data).join(',') === '1,2,3',
      ` → ${Array.from(arrFrame.data ?? []).join(',')}`,
    )

    fireListeners({ kind: 'frame', from: 'u_b', data: { 0: 7, 1: 8, 2: 9 } })
    const objFrame = seen[seen.length - 1] as { kind: string; data: Uint8Array }
    check(
      '★ 对象形式的字节也被认出来（认不出来就会**静默**变成全零帧，报错却指向解密）',
      Array.from(objFrame.data).join(',') === '7,8,9',
      ` → ${Array.from(objFrame.data).join(',')}`,
    )

    let threw = ''
    try {
      fireListeners({ kind: 'frame', from: 'u_b', data: '这不是字节' as unknown as number[] })
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check('认不出来的字节**当场抛**（抛在读取处比抛在解密处好查）', threw.includes('不是字节数组'), ` → ${threw || '（没抛）'}`)
  }

  // ----------------------------------------------------- 退订的竞态
  section('退订：listen() 还没落地就退订')
  {
    resetStub()
    const bridge = new TauriNetBridge()
    const off = bridge.subscribe(() => {})
    check('subscribe 同步返回退订函数', typeof off === 'function')
    check('此刻 listen() 还没 resolve', unresolvedListenCount() === 1)

    off()
    check('还没落地就退订：当时没有 unlisten 可调', unlistenIds().length === 0)

    resolveListeners()
    await Promise.resolve()
    await Promise.resolve()
    check(
      '★ listen 落地后立刻补一次 unlisten（少了这一步，这条监听器会一直活着）',
      unlistenIds().length === 1,
      ` → ${JSON.stringify(unlistenIds())}`,
    )
  }

  {
    resetStub()
    const bridge = new TauriNetBridge()
    const off = bridge.subscribe(() => {})
    resolveListeners()
    await Promise.resolve()
    await Promise.resolve()
    check('正常路径：resolve 之后 unlisten 还没被调', unlistenIds().length === 0)

    off()
    check('退订时收掉那条监听器', unlistenIds().length === 1)

    off()
    check('重复退订不会收第二遍（否则会把别人的监听器关掉）', unlistenIds().length === 1)
  }

  // ------------------------------------------------------------- stop
  section('stop 的两件事')
  {
    resetStub()
    const bridge = new TauriNetBridge()
    bridge.subscribe(() => {})
    resolveListeners()
    await Promise.resolve()
    await Promise.resolve()

    await bridge.stop()
    check('stop 先退订（停完之后监听器不能还活着）', unlistenIds().length === 1)
    check('stop 调 net_stop', commands().includes('net_stop'))

    // net_stop 失败不该把退出流程卡住 —— 窗口都要关了，能做的只有记下来。
    resetStub()
    const bridge2 = new TauriNetBridge()
    setInvokeImpl((cmd) => {
      if (cmd === 'net_stop') throw new Error('Rust 那边已经没了')
      return undefined
    })
    let stopThrew = ''
    try {
      await bridge2.stop()
    } catch (error) {
      stopThrew = error instanceof Error ? error.message : String(error)
    }
    check('★ net_stop 报错时 stop() 不往外抛（不然关窗口的流程会被一个已经没用的错误打断）', stopThrew === '', ` → ${stopThrew}`)
    check('但那次调用确实发生了', invokes.some((c) => c.cmd === 'net_stop'))
  }

  report()
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

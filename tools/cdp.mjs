#!/usr/bin/env node

/**
 * 接 Chrome DevTools Protocol 的小工具。
 *
 * 用途：Tauri 桌面壳（WebView2）和网页版都能开 CDP，开了之后就能直接读 DOM、
 * 改 localStorage、截图 —— 比用鼠标点像素靠谱得多。
 *
 * 怎么开：
 *   桌面壳   npx tauri build --no-bundle --config src-tauri/tauri.debug.conf.json
 *            （那个配置里 additionalBrowserArgs 带了 --remote-debugging-port=9333）
 *
 * 用法：
 *   node tools/cdp.mjs --list                          列出所有 target
 *   node tools/cdp.mjs --eval "return document.title"
 *   node tools/cdp.mjs --eval "return localStorage.getItem('baker.config.v1')"
 *   node tools/cdp.mjs --shot ref/shots/x.png
 *   node tools/cdp.mjs --reload
 *
 * 端口默认 9333，用 CDP_PORT 环境变量改。
 *
 * 注：用 Node 22 自带的全局 WebSocket，不依赖任何第三方包。
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const PORT = Number(process.env.CDP_PORT ?? 9333)
const args = process.argv.slice(2)

function flag(name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  const next = args[index + 1]
  return next && !next.startsWith('--') ? next : true
}

async function fetchTargets() {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  } catch {
    throw new Error(`连不上 127.0.0.1:${PORT} —— 那个调试端口没开。\n桌面壳要用带调试口的配置编：npx tauri build --no-bundle --config src-tauri/tauri.debug.conf.json`)
  }
  if (!response.ok) throw new Error(`拿 target 列表失败：HTTP ${response.status}`)
  return response.json()
}

/** 挑一个页面 target。跳过 devtools 自己和扩展。 */
function pickTarget(targets) {
  const pages = targets.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  return pages.find((t) => t.url.includes('tauri.localhost') || t.url.includes('localhost')) ?? pages[0] ?? null
}

class Cdp {
  constructor(webSocketDebuggerUrl) {
    this.ws = new WebSocket(webSocketDebuggerUrl)
    this.seq = 0
    this.pending = new Map()
  }

  async open() {
    await new Promise((resolvePromise, reject) => {
      this.ws.onopen = resolvePromise
      this.ws.onerror = () => reject(new Error(`连不上 CDP（127.0.0.1:${PORT}）—— 那个端口开了吗？`))
    })
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
  }

  send(method, params = {}) {
    this.seq += 1
    const id = this.seq
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.ws.close()
  }
}

async function main() {
  if (args.includes('--help') || args.length === 0) {
    console.log(`用法：
  node tools/cdp.mjs --list
  node tools/cdp.mjs --eval "<JavaScript>"     （用 return 交回一个值）
  node tools/cdp.mjs --shot <输出路径.png>
  node tools/cdp.mjs --reload

端口用 CDP_PORT 改，默认 ${PORT}。`)
    return
  }

  const targets = await fetchTargets()

  if (args.includes('--list')) {
    for (const target of targets) {
      console.log(`${target.type.padEnd(8)} ${target.title || '(无标题)'}\n         ${target.url}\n         ${target.webSocketDebuggerUrl}`)
    }
    return
  }

  const target = pickTarget(targets)
  if (!target) {
    console.error('没有找到可用的页面 target。是不是应用还没起来？')
    process.exit(1)
  }

  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.open()

  try {
    if (typeof flag('--eval') === 'string') {
      const code = flag('--eval')
      // 写了 return 就当成函数体（可以多行、可以 await），否则当成一个表达式。
      // 直接往 Runtime.evaluate 里塞 "return x" 会报 Illegal return statement。
      const expression = /\breturn\b/.test(code) ? `(async () => { ${code} })()` : code
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        includeCommandLineAPI: true,
      })
      if (result.exceptionDetails) {
        console.error('页面里抛异常了：')
        console.error(JSON.stringify(result.exceptionDetails, null, 2))
        process.exitCode = 1
      } else {
        const value = result.result?.value
        console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
      }
    } else if (typeof flag('--shot') === 'string') {
      const path = resolve(flag('--shot'))
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, Buffer.from(shot.data, 'base64'))
      console.log(`已出图：${path}`)
    } else if (args.includes('--reload')) {
      await cdp.send('Page.reload', { ignoreCache: false })
      console.log('已重新加载')
    } else {
      console.error(`看不懂这些参数：${args.join(' ')}（加 --help 看用法）`)
      process.exitCode = 2
    }
  } finally {
    cdp.close()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
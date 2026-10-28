/**
 * 两个 BAKER 实例的验收脚本 —— 建单聊、发消息、发文件。
 *
 * 和 `tools/*-selftest.ts` 的区别：那些跑在内存假网上，这个驱动的是
 * **两个真实进程**，中间走真局域网栈（UDP 组播发现 + TCP 直连），
 * 而且点的是真界面。所以它能抓到内存测试抓不到的东西：算错的会话 id、
 * 根本没建出来的钥匙、渲染成空气泡的文件。
 *
 * 前提：两个实例都带 CDP 口跑着（见 `tools/cdp.mjs` 的说明），
 * 调试壳用 `src-tauri/tauri.debug.conf.json` 编，端口写在
 * `additionalBrowserArgs` 里，一个进程一个。
 *
 * ## 起两个实例（CDP 端口烧在 exe 里，所以得编两份）
 *
 *   # ① 把 tauri.debug.conf.json 里的端口改成 9334，编第二份
 *   npx tauri build --debug --no-bundle --config src-tauri/tauri.debug.conf.json
 *   copy src-tauri\target\debug\baker.exe .tmp\bakerB.exe
 *   # ② 把端口改回 9333，编第一份
 *   npx tauri build --debug --no-bundle --config src-tauri/tauri.debug.conf.json
 *   copy src-tauri\target\debug\baker.exe .tmp\bakerA.exe
 *
 * 光靠 `BAKER_DATA_DIR` 分不开两个实例 —— 身份在 WebView2 的
 * localStorage 里，还得给各自一个 `WEBVIEW2_USER_DATA_FOLDER`：
 *
 *   $env:BAKER_DATA_DIR="%CD%\.tmp\verA"
 *   $env:WEBVIEW2_USER_DATA_FOLDER="%CD%\.tmp\verA\webview"
 *   Start-Process .tmp\bakerA.exe
 *
 * 跑法：
 *   node tools/room.mjs a=9333 b=9334
 *   node tools/room.mjs step=create   # 也可以单步：create / peer / text / file
 */

import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()

/** 在某个实例里跑一段页面代码，返回它的值。 */
function cdp(port, code) {
  const out = execFileSync('node', ['tools/cdp.mjs', '--eval', code], {
    cwd: ROOT,
    env: { ...process.env, CDP_PORT: String(port) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const start = out.indexOf('{')
  if (start < 0) return { raw: out.trim() }
  try {
    return JSON.parse(out.slice(start))
  } catch {
    return { raw: out.trim() }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 建一个单聊：打开对话框 → 起名 → 选「私聊」→ 勾第一个成员 → 创建。 */
function createDirect(port, name) {
  return cdp(
    port,
    `
    document.querySelector('#cards-new').click();
    await new Promise(r=>setTimeout(r,400));
    [...document.querySelectorAll('.filter-menu button')].find(x=>x.textContent.includes('新建会话')).click();
    await new Promise(r=>setTimeout(r,700));
    const inp=document.querySelector('.dialog input');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(inp, ${JSON.stringify(name)}); inp.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,200));
    [...document.querySelectorAll('.dialog button')].find(b=>b.textContent.trim()==='私聊')?.click();
    await new Promise(r=>setTimeout(r,300));
    const mem=document.querySelector('.dialog-member');
    if(!mem) return { ok:false, why:'对话框里一个成员都没有' };
    mem.click();
    await new Promise(r=>setTimeout(r,300));
    [...document.querySelectorAll('.dialog button')].find(b=>b.textContent.trim()==='创建').click();
    await new Promise(r=>setTimeout(r,2500));
    return { ok:true, cards:[...document.querySelectorAll('.card')].map(c=>c.innerText.replace(/\\n/g,' | ')) };
  `,
  )
}

/** 在有会话打开的前提下发一条文字消息。 */
function sendText(port, text) {
  return cdp(
    port,
    `
    const ta=document.querySelector('textarea');
    if(!ta) return { ok:false, why:'没有输入框（会话没打开？）' };
    const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    set.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,300));
    ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
    await new Promise(r=>setTimeout(r,1800));
    return { ok:true, cleared: ta.value === '' };
  `,
  )
}

/**
 * 往文件输入框里塞一个真的 File 再触发 change ——
 * 等于用户点了「发送文件」并选了它。内容全是 `byte`，方便对面逐字节比。
 */
function sendFile(port, fileName, size, byte) {
  return cdp(
    port,
    `
    const input=document.querySelector('input[type=file]');
    if(!input) return { ok:false, why:'找不到文件输入框' };
    const bytes=new Uint8Array(${size}).fill(${byte});
    const dt=new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(fileName)}, {type:'application/octet-stream'}));
    input.files=dt.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,4000));
    return { ok:true, bubbles: [...document.querySelectorAll('.message-row-item')].map(m=>m.innerText.replace(/\\n/g,' | ')).slice(-4) };
  `,
  )
}

/** 读当前会话里的消息气泡。 */
function readBubbles(port) {
  return cdp(
    port,
    `
    await new Promise(r=>setTimeout(r,1500));
    return {
      bubbles: [...document.querySelectorAll('.message-row-item')].map(m=>m.innerText.replace(/\\n/g,' | ')),
      fileDisabled: [...document.querySelectorAll('.message-file')].map(b=>b.disabled),
      body: document.body.innerText.split('\\n').filter(s=>s.trim()).slice(0,14)
    };
  `,
  )
}

/** 点开列表里的第 n 张会话卡（默认第一张）。 */
function openCard(port, index = 0) {
  return cdp(
    port,
    `
    const c=document.querySelectorAll('.card')[${index}];
    if(!c) return { ok:false, why:'没有这张卡' };
    c.click();
    await new Promise(r=>setTimeout(r,1500));
    return { ok:true, active: document.body.innerText.split('\\n').filter(s=>s.trim()).slice(0,10) };
  `,
  )
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => a.split('=')),
  )
  const A = Number(args.a ?? 9333)
  const B = Number(args.b ?? 9334)

  const step = args.step ?? 'all'
  const out = {}

  if (step === 'all' || step === 'create') {
    out.createA = createDirect(A, '端到端验收')
    await sleep(4000)
    out.bCardsAfterCreate = cdp(B, `return { cards: [...document.querySelectorAll('.card')].map(c=>c.innerText.trim()) };`)
  }
  if (step === 'all' || step === 'peer') {
    out.openB = openCard(B, 0)
    await sleep(1500)
  }
  if (step === 'all' || step === 'text') {
    out.sendText = sendText(A, '端到端第一条加密消息')
    await sleep(2500)
    out.readA = readBubbles(A)
    out.readB = readBubbles(B)
  }
  if (step === 'all' || step === 'file') {
    out.sendFile = sendFile(A, '验收样本.bin', 4096, 0x5a)
    await sleep(3000)
    out.readA = readBubbles(A)
    out.readB = readBubbles(B)
  }
  console.log(JSON.stringify(out, null, 2))
}

await main()

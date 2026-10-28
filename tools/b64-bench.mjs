/**
 * base64 编码方案的横向对比。
 *
 * 背景：加密路径上真正的瓶颈不是 AES，是 JS 里的 base64（见 docs/加密与身份.md）。
 * 这个脚本把候选写法都跑一遍，选出「浏览器和 Node 都能用、而且最快」的那个。
 *
 * 跑法：node tools/b64-bench.mjs
 */

const SIZE = 4 * 1024 * 1024
const bytes = new Uint8Array(SIZE)
for (let i = 0; i < SIZE; i += 1) bytes[i] = (i * 7 + 13) & 0xff

const ROUNDS = 3

function time(label, fn) {
  // 先跑一次热身，避开 JIT 冷启动
  fn()
  const t0 = performance.now()
  for (let i = 0; i < ROUNDS; i += 1) fn()
  const ms = (performance.now() - t0) / ROUNDS
  const mbps = SIZE / 1024 / 1024 / (ms / 1000)
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(7)} ms   ${mbps.toFixed(0).padStart(5)} MB/s`)
  return ms
}

// ---- 1. 现状：spread + 字符串累加 ----
function current(view) {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// ---- 2. 分块存数组，最后 join ----
function chunkJoin(view) {
  const parts = []
  const CHUNK = 0x8000
  for (let i = 0; i < view.length; i += CHUNK) {
    parts.push(String.fromCharCode(...view.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

// ---- 3. apply 而不是 spread ----
function applyChunks(view) {
  const parts = []
  const CHUNK = 0x8000
  for (let i = 0; i < view.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, view.subarray(i, i + CHUNK)))
  }
  return btoa(parts.join(''))
}

// ---- 4. Node 的原生 Buffer（浏览器没有） ----
function nodeBuffer(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64')
}

// ---- 5. 手写查表，预分配输出 ----
const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function lookup(view) {
  const len = view.length
  const outLen = ((len + 2) / 3) * 4
  const out = new Uint8Array(outLen)
  let o = 0
  let i = 0
  for (; i + 2 < len; i += 3) {
    const n = (view[i] << 16) | (view[i + 1] << 8) | view[i + 2]
    out[o++] = TABLE.charCodeAt((n >> 18) & 63)
    out[o++] = TABLE.charCodeAt((n >> 12) & 63)
    out[o++] = TABLE.charCodeAt((n >> 6) & 63)
    out[o++] = TABLE.charCodeAt(n & 63)
  }
  const rest = len - i
  if (rest === 1) {
    const n = view[i] << 16
    out[o++] = TABLE.charCodeAt((n >> 18) & 63)
    out[o++] = TABLE.charCodeAt((n >> 12) & 63)
    out[o++] = 61
    out[o++] = 61
  } else if (rest === 2) {
    const n = (view[i] << 16) | (view[i + 1] << 8)
    out[o++] = TABLE.charCodeAt((n >> 18) & 63)
    out[o++] = TABLE.charCodeAt((n >> 12) & 63)
    out[o++] = TABLE.charCodeAt((n >> 6) & 63)
    out[o++] = 61
  }
  return fromCharCodeChunked(out.subarray(0, o))
}

/** 分块 fromCharCode，避免超长参数列表爆栈。 */
function fromCharCodeChunked(view, chunk = 0x8000) {
  const parts = []
  for (let i = 0; i < view.length; i += chunk) {
    parts.push(String.fromCharCode.apply(null, view.subarray(i, i + chunk)))
  }
  return parts.join('')
}

/** 每块单独 btoa，不建整段中间字符串。 */
function applyPerChunkBtoa(view, chunk = 0x8000) {
  const parts = []
  for (let i = 0; i < view.length; i += chunk) {
    parts.push(btoa(String.fromCharCode.apply(null, view.subarray(i, i + chunk))))
  }
  return parts.join('')
}

// ---- 6. 查表 + 每块单独 btoa ----
function lookupPerChunk(view) {
  return lookup(view)
}

console.log(`\n${(SIZE / 1024 / 1024).toFixed(1)} MB，${ROUNDS} 轮取平均\n`)

const ref = current(bytes)
const candidates = [
  ['现状：spread 累加 + btoa', current],
  ['分块进数组 + join + btoa', chunkJoin],
  ['apply 版 + join + btoa', applyChunks],
  ['apply 每块单独 btoa', applyPerChunkBtoa],
  ['手写查表 + 分块 fromCharCode', lookup],
]

console.log('--- 纯字符串输出（浏览器 btoa 能吃）---')
const base = time(candidates[0][0], () => candidates[0][1](bytes))
for (const [label, fn] of candidates) {
  const out = fn(bytes)
  const same = out === ref
  const ms = time(label, () => fn(bytes))
  if (!same) console.log(`      ⚠ 结果和现状不一致，不能用`)
  else if (ms > base) console.log(`      （比现状慢 ${(ms / base).toFixed(2)}×）`)
}

console.log('\n--- Node 原生（浏览器用不了，作为上限参考）---')
const nodeMs = time('Buffer.toString(base64)', () => nodeBuffer(bytes))
console.log(`      ${(base / nodeMs).toFixed(1)}× 于现状`)

console.log('\n--- 解码方向 ---')
function curFromB64(text) {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}
const b64 = ref
const decBase = time('atob + 逐字节 charCodeAt', () => curFromB64(b64))
if (typeof Buffer !== 'undefined') {
  const decNode = time('Buffer.from(b64, base64)', () => new Uint8Array(Buffer.from(b64, 'base64')))
  console.log(`      ${(decBase / decNode).toFixed(1)}× 于现状`)
}

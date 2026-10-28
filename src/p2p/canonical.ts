/**
 * 确定性 JSON —— 同一份数据永远序列化成同一串字节。
 *
 * ## 为什么不能用 `JSON.stringify`
 *
 * 这个模块的输出去喂两件事：**内容寻址的 id** 和 **Ed25519 签名**。
 * 两者都要求「语义相同的两份数据 → 逐字节相同的输入」。
 *
 * `JSON.stringify` 不保证这一点：它按**对象键的插入顺序**输出。于是
 *
 *     JSON.stringify({a:1, b:2})  →  '{"a":1,"b":2}'
 *     JSON.stringify({b:2, a:1})  →  '{"b":2,"a":1}'
 *
 * 语义完全一样，字节不一样。A 机器从网络收到一份再序列化、B 机器自己拼一份，
 * 两边算出来的 id 就对不上、签名就验不过。
 *
 * 最要命的是它**不会稳定复现**：同一份数据在对象字面量的书写顺序变了、
 * 经过一次 `JSON.parse` 再 `stringify` 之后，键序就可能变。症状是
 * 「偶尔有人说我发的消息签名无效」「同一条消息在两台机器上是两条」——
 * 而这类 bug 在单机自测里永远看不到。所以从根上堵死：键一律排序。
 *
 * ## 和 JCS（RFC 8785）的关系
 *
 * 规则子集和 JCS 一致（键按 UTF-16 码元排序、数字短表示、字符串按 JSON 转义），
 * 但**不支持 `-0`/指数形式之外的浮点边界**，遇到就抛错而不是猜一个表示法
 * （见下面 `number` 的注释）。宁可当场红，也不要两台机器各自写出一串
 * 「看着都对」的字节。
 */

import type { Bytes } from '../crypto/core'

/** 出错时抛这个，调用方按「这份数据不能进日志」处理。 */
export class CanonicalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalError'
  }
}

/**
 * 嵌套深度上限。
 *
 * 防的是两件事：栈溢出（恶意对端塞一个几千层的数组），以及
 * 一个自己咬自己的对象在 `sort` 里绕不出来 —— 循环引用本来就拒绝，
 * 深度上限是给那些**合法但荒谬**的输入兜底。
 */
const MAX_DEPTH = 64

export function canonicalJson(value: unknown): string {
  const out: string[] = []
  write(value, out, 0, '')
  return out.join('')
}

/** 给哈希 / 签名用的字节。就是上面那串的 UTF-8。 */
export function canonicalBytes(value: unknown): Bytes {
  return new TextEncoder().encode(canonicalJson(value))
}
function fail(path: string, why: string): never {
  throw new CanonicalError(`${path || '<根>'}：${why}`)
}

function write(value: unknown, out: string[], depth: number, path: string): void {
  if (depth > MAX_DEPTH) {
    fail(path, `嵌套超过 ${MAX_DEPTH} 层`)
  }

  if (value === null) {
    out.push('null')
    return
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false')
      return

    case 'string':
      out.push(quote(value))
      return

    case 'number':
      out.push(number(value, path))
      return

    case 'object':
      break

    default:
      // undefined / function / symbol / bigint 都没有 JSON 表示。
      // 不静默变成 null：那会让「字段写错了」表现成「字段是空的」。
      fail(path, `${typeof value} 没有确定性 JSON 表示`)
  }

  if (Array.isArray(value)) {
    // 数组里出现空洞（`[1, , 2]`）或 undefined 时不补 null，直接报错 ——
    // 补 null 等于替调用方做了一个可能会被对方理解成别的意思的决定。
    out.push('[')
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',')
      if (!(i in value)) fail(`${path}[${i}]`, '数组有空洞')
      write(value[i], out, depth + 1, `${path}[${i}]`)
    }
    out.push(']')
    return
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    // Date / Map / Set / 类实例都走这里。它们的「相等」有自己的语义，
    // 悄悄按自有属性序列化会让两台机器得出不同的东西。
    fail(path, `${proto?.constructor?.name ?? '?'} 不是纯对象，不能进确定性 JSON`)
  }

  const record = value as Record<string, unknown>

  // Symbol 键：`Object.keys` 看不见它们，于是「只有 symbol 键的对象」
  // 会安静地序列化成 `{}`。JSON 里没有 symbol，所以这里没有「正确的」
  // 表示可选 —— 只能报错。
  const symbols = Object.getOwnPropertySymbols(record)
  if (symbols.length > 0) {
    fail(path, `有 ${symbols.length} 个 Symbol 键，JSON 表示不了`)
  }

  // 值为 `undefined` 的键由 `write` 的 default 分支拦下 —— 它是带着
  // `${path}.${键名}` 调 fail 的，所以报错仍然点得出是哪个键。
  //
  // 这里曾经另有一圈逐键检查，写的是同一件事。它是**冗余**的：删掉之后
  // `{a: undefined}` 照样报错、报的还是同一个键名，只是少半句括号里的建议，
  // 任何断言都看不出区别。变异检查把这件事指出来了（`canonical-undefined-dropped`
  // 一直报「漏掉」）。同一件事挂着两道闸的代价，是有人以为第一道在管、
  // 改坏了也没人知道 —— 所以删掉一道，只留真在管的那道。
  const keys = Object.keys(record)
  keys.sort(compareCodeUnits)

  out.push('{')
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out.push(',')
    const k = keys[i]
    out.push(quote(k), ':')
    write(record[k], out, depth + 1, `${path}.${k}`)
  }
  out.push('}')
}

/**
 * 按 UTF-16 码元排序。
 *
 * 不能用 `Array.prototype.sort()` 的默认比较 —— 它把元素转成字符串再按
 * **UTF-16 码元**比，对纯 ASCII 键恰好和我们一样；但一旦键里有代理对
 * （emoji、部分汉字扩展），默认比较和 `<` 的语义就有区别。
 * 这里写成显式的 `<` / `>`，和 JCS 一致，也和 Rust / Go 侧的字节序一致。
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 数字的规范表示。
 *
 * `JSON.stringify` 对有限数已经给出最短往返表示，直接借用它 ——
 * 自己实现 `Number.prototype.toString` 的等价物只会引入新的分歧。
 *
 * 但有两个必须挡掉：
 *   - `NaN` / `Infinity`：`JSON.stringify` 会**静默输出 `null`**，
 *     于是「算错了」表现成「这个字段是空的」；
 *   - `-0`：`JSON.stringify` 输出 `0`，但 `Object.is(-0, 0)` 是 false。
 *     序列化成 `0` 是安全的（`-0` 和 `0` 在 JSON 里没法区分，对方解出来
 *     也是 `0`），所以这里跟 `JSON.stringify` 走，**不报错**。
 */
function number(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    fail(path, `数字 ${String(value)} 不能进确定性 JSON`)
  }
  return JSON.stringify(value === 0 ? 0 : value)
}

/**
 * 字符串转义。
 *
 * 和 `JSON.stringify` 的差别只有一处：**不转义非 ASCII**。
 * `JSON.stringify('中')` 给的是 `"中"`（现代引擎不转义），所以这里也不用动。
 * 唯一要自己做的是把 U+2028 / U+2029 转掉 —— 它们在 JSON 里合法，
 * 但直接嵌进 JS 源码会断行，历史上出过事。转义是无害的：对方解出来还是同一个字符。
 */
function quote(text: string): string {
  let out = '"'
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const code = text.charCodeAt(i)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    // 代理项必须自己处理。合法的一对（高位后紧跟低位）原样输出即可 ——
    // 循环按**码元**走，两次 `out += ch` 拼回来正好是那一对。
    //
    // 但**孤立**的那一半绝不能原样输出：`canonicalBytes` 用 `TextEncoder`
    // 编码，而它把每个未配对的代理项替换成 U+FFFD。于是 `"\uD800"`、
    // `"\uD801"` 和 `"\uFFFD"` 会算出**同一串字节** —— 签名覆盖不到它们的
    // 区别（中继改一个字节，签名照样过），事件 id 也会撞车（先到的赢，
    // 后到的被当重复静默丢弃）。按 `JSON.stringify` 的做法转义掉，
    // 编码就重新变成单射。
    else if (code >= 0xd800 && code <= 0xdfff) {
      const next = text.charCodeAt(i + 1)
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += ch + text[i + 1]
        i++
      } else out += '\\u' + code.toString(16).padStart(4, '0')
    }
    else if (code === 0x2028 || code === 0x2029) out += '\\u' + code.toString(16).padStart(4, '0')
    else if (code < 0x20) {
      // 控制字符必须转义（JSON 不允许裸的控制字符）
      out +=
        ch === '\n' ? '\\n'
        : ch === '\r' ? '\\r'
        : ch === '\t' ? '\\t'
        : ch === '\b' ? '\\b'
        : ch === '\f' ? '\\f'
        : '\\u' + code.toString(16).padStart(4, '0')
    } else out += ch
  }
  return out + '"'
}

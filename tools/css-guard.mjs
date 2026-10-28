/**
 * 样式的两个「同名类陷阱」回归护栏。
 *
 * 这两个 bug 都在真浏览器里躲了很久，而且都是**安静的失败** ——
 * 按钮点不到、一行字读不出来，控制台一个字都不报，测试也全绿：
 *
 *   1. `.actions` 本来是消息气泡的悬浮操作条
 *      （`position:absolute; right:100%; bottom:0; visibility:hidden`）。
 *      设置面板的按钮行复用了这个类名，却只覆盖了 flex/gap ——
 *      于是「保存并重连」被推到屏幕左外侧并且 `visibility:hidden`，
 *      在界面上根本没法按。
 *   2. `.build-stamp` 按深色主题写了白字，但它**只**出现在设置面板里（白底），
 *      实际效果是几乎看不见 —— 同一个文件第 14 节开头就警告过这个坑。
 *
 * 它们能同时逃过类型检查、单元测试和 e2e，是因为「样式」根本不在那些网里。
 * 这里用最朴素的办法补一张网：读 CSS 文本 + 读 JSX 里用到的类名，
 * 断言这两件事不会退化。
 *
 * 为什么不引 CSS 解析器：这些断言要防的是「有人把修好的声明删掉了」，
 * 不是「CSS 语法变了」。正则够用，而且零依赖 —— 和这个仓库其它自测一致。
 *
 *   node tools/css-guard.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const STYLE_DIR = join(ROOT, 'src', 'styles')
const PANEL = join(ROOT, 'src', 'components', 'SettingsPanel.tsx')

let passed = 0
let failed = 0

function check(name, ok, extra = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}${extra}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${extra}`)
  }
}

// ---------------------------------------------------------------- 读样式

/** 把 `选择器 { 声明 }` 逐块切出来。够用：这个仓库的 CSS 没有嵌套规则。 */
function parseRules(css, file) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css)) !== null) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // 去掉注释：注释里的花括号已经被上面那条正则吃掉了，这里只需要清掉残留
    if (!selectors.length || selectors.some((s) => s.startsWith('/*'))) continue
    out.push({ selectors, body: m[2], file })
  }
  return out
}

const rules = []
for (const name of readdirSync(STYLE_DIR)) {
  if (!name.endsWith('.css')) continue
  const css = readFileSync(join(STYLE_DIR, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  rules.push(...parseRules(css, name))
}

/** 取某个选择器块里的声明值（最后一条生效，和 CSS 一致）。 */
function decl(body, prop) {
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'gi')
  let value = null
  let m
  while ((m = re.exec(body)) !== null) value = m[1].trim()
  // `#333 !important` 里的 !important 不是颜色的一部分
  return value === null ? null : value.replace(/!\s*important\s*$/i, '').trim()
}

function ruleWith(selectorPart) {
  return rules.filter((r) => r.selectors.some((s) => s.includes(selectorPart)))
}

// ---------------------------------------------------------------- 护栏一

console.log('=== .actions 不能把气泡悬浮条的定位漏进设置面板 ===')

const settingsActions = rules.filter((r) => r.selectors.some((s) => /#settings\s+\.actions\b/.test(s)))
check('存在 #settings .actions 这条规则', settingsActions.length > 0)

const body = settingsActions.map((r) => r.body).join(';')
check(
  '#settings .actions 把 position 还原成 static',
  /position\s*:\s*static/.test(body),
  '（不还原就会继承 .actions 的 position:absolute）',
)
check(
  '#settings .actions 把 visibility 还原成 visible',
  /visibility\s*:\s*visible/.test(body),
  '（不还原的话按钮是隐形的，点不到也读屏不到）',
)
check('#settings .actions 把 right 还原成 auto', /right\s*:\s*auto/.test(body))
check('#settings .actions 把 bottom 还原成 auto', /bottom\s*:\s*auto/.test(body))

// 反过来确认那条气泡悬浮条确实还是绝对定位 ——
// 如果有人为了修上面那个 bug 直接把 .actions 改成 static，
// 消息气泡的操作条就全乱了。
const bubbleActions = rules.filter((r) => r.selectors.includes('.actions'))
check(
  '气泡那条 .actions 仍然是 absolute + hidden（别为了上面那条把它改坏）',
  bubbleActions.some((r) => /position\s*:\s*absolute/.test(r.body)) &&
    bubbleActions.some((r) => /visibility\s*:\s*hidden/.test(r.body)),
)

// ---------------------------------------------------------------- 护栏二

console.log('\n=== 设置面板里的字不能是浅色（那是白底）===')

/** 从一份 JSX/TS 源码里抠出用到的类名。 */
function classesIn(src) {
  const out = new Set()
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const value = m[1] ?? m[2] ?? ''
    // 模板串里的 ${...} 先剔掉，剩下的按空白切
    for (const cls of value.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      const name = cls.trim()
      if (name && !name.includes('{')) out.add(name)
    }
  }
  return out
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const panelClasses = classesIn(readFileSync(PANEL, 'utf8'))
check('从 SettingsPanel 里读到了类名', panelClasses.size > 0, `（${panelClasses.size} 个）`)

/*
 * 「这个类名只被设置面板用到」是判断「它长在白底上」的可靠代理。
 *
 * 反例是 `.actions`：消息气泡也用它。气泡那条是深色背景上的白字，完全合理，
 * 不能因为设置面板也用了 `actions` 就把它报出来 —— 面板里真正生效的是
 * 带 `#settings` 前缀、优先级更高的那条。所以共享类名只在选择器**显式**
 * 写了 `#settings` 时才检查。
 */
const usedElsewhere = new Set()
for (const file of walk(join(ROOT, 'src'))) {
  if (file === PANEL) continue
  for (const cls of classesIn(readFileSync(file, 'utf8'))) usedElsewhere.add(cls)
}

/** `#eeecec` / `rgb(255 239 0 / 0.08)` / `white` → [r,g,b,a]，认不出来返回 null。 */
function parseColor(raw) {
  if (!raw) return null
  const value = raw.trim().toLowerCase()
  if (value === 'white') return [255, 255, 255, 1]
  if (value === 'black') return [0, 0, 0, 1]
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value)
  if (hex) {
    const h = hex[1]
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ]
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(value)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])]
  // oklch / var() 之类一律放过：认不出来就不要瞎报
  return null
}

const lum = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255

/** 把可能带透明度的颜色压到设置面板的底色上，得到实际看到的颜色。 */
function flatten(color, base) {
  if (color[3] >= 1) return color
  const a = color[3]
  return [0, 1, 2].map((i) => color[i] * a + base[i] * (1 - a)).concat(1)
}

const PANEL_BG = parseColor('#eeecec')

/**
 * 设置面板是白底，所以「浅色文字」在这里等于看不见。
 *
 * 判定：这条规则管到了面板里的元素，它声明了浅色 color，
 * 而且**自己没有**给一个深色背景来配它。
 * （`.primary` 按钮就是靠后者翻案的：白字 + #1a1a1a 的黑底，完全合理。）
 */
const offenders = []
for (const rule of rules) {
  const explicitPanel = rule.selectors.some((s) => s.includes('#settings') || s.includes('.dialog'))
  // 没写 #settings 的规则，只有当它管的类名**只**被设置面板用时才检查
  const panelOnlyClass = rule.selectors.some((s) => {
    for (const cls of s.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
      if (panelClasses.has(cls[1]) && !usedElsewhere.has(cls[1])) return true
    }
    return false
  })
  if (!explicitPanel && !panelOnlyClass) continue

  const fg = parseColor(decl(rule.body, 'color'))
  if (!fg) continue

  const bgRaw = decl(rule.body, 'background-color') ?? decl(rule.body, 'background')
  const bg = parseColor(bgRaw)
  const effectiveBg = bg ? flatten(bg, PANEL_BG) : PANEL_BG
  const bgIsDark = lum(effectiveBg) < 0.5

  if (lum(fg) > 0.7 && !bgIsDark) {
    offenders.push(`${rule.file}: ${rule.selectors.join(', ')} → color: ${decl(rule.body, 'color')}`)
  }
}

check(
  '设置面板里没有「浅色字配浅色底」',
  offenders.length === 0,
  offenders.length ? `\n     ${offenders.join('\n     ')}` : '',
)

// 特意确认那一处真实历史 bug 现在被算了进去 ——
// 免得哪天判定逻辑被改松了，护栏还在但已经不防它了。
const stampColor = ruleWith('.build-stamp')
  .map((r) => parseColor(decl(r.body, 'color')))
  .find(Boolean)
check(
  '.build-stamp 的颜色是深色（它只在白底的设置面板里）',
  stampColor ? lum(stampColor) <= 0.7 : false,
  stampColor ? `（亮度 ${lum(stampColor).toFixed(2)}）` : '（没读到颜色）',
)

console.log('\n============================================')
if (failed === 0) {
  console.log(`全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`失败 ${failed} 项 / 共 ${passed + failed} 项`)
process.exit(1)

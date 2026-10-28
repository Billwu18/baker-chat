/** 时间格式化。界面里的时间都要跟游戏一样短，不写「3 分钟前」这种长句。 */

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 一天的稳定标识。日期串、日期分隔线、消息分组都靠它判断「是不是同一天」，
 * 所以只留这一份实现 —— 之前三处各写一遍 `getFullYear/getMonth/getDate` 比较，
 * 改时区口径时很容易漏掉一处。
 */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** 两个时间戳是不是同一天（本地时区）。 */
export function isSameDay(a: number, b: number): boolean {
  return dayKey(a) === dayKey(b)
}

/** HH:MM */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 今天 → HH:MM；昨天 → 昨天 HH:MM；更早 → M月D日 */
export function formatRelative(ts?: number): string {
  if (!ts) return ''
  const now = Date.now()
  if (isSameDay(ts, now)) return formatClock(ts)

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(ts, yesterday.getTime())) return `昨天 ${formatClock(ts)}`

  const d = new Date(ts)
  const n = new Date(now)
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 日期分隔线文案：今天 / 昨天 / M月D日 */
export function formatDayDivider(ts: number): string {
  const now = Date.now()
  if (isSameDay(ts, now)) return '今天'

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(ts, yesterday.getTime())) return '昨天'

  const d = new Date(ts)
  const n = new Date(now)
  if (d.getFullYear() === n.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 把一段文字压成会话卡上的一行摘要。 */
export function summarize(text: string | undefined, fallback: string): string {
  if (!text) return fallback
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 18 ? `${flat.slice(0, 18)}…` : flat
}

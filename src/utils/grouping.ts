import type { Message } from '../protocol/types'
import { dayKey, isSameDay } from './time'

/**
 * 把一串消息整理成「消息行」。
 *
 * 游戏里的规则是：同一个人连着发的消息共用一个头像，气泡上下堆叠。
 * 这里额外加了两条约束——同一行最多跨 5 分钟，中途跨天要断开——
 * 否则挂机一晚上回来会发现有人顶着一个头像刷了几十条。
 */

export const GROUP_WINDOW_MS = 5 * 60 * 1000

export interface MessageRow {
  key: string
  authorId: string
  isSelf: boolean
  messages: Message[]
}

export interface TimelineItem {
  kind: 'divider'
  key: string
  at: number
}

export interface TimelineRow {
  kind: 'row'
  key: string
  row: MessageRow
}

export type TimelineEntry = TimelineItem | TimelineRow

/** 同一天 + 同一作者 + 时间挨得够近 → 并成一行。 */
function canGroup(prev: Message | undefined, next: Message): boolean {
  if (!prev) return false
  if (prev.authorId !== next.authorId) return false
  if (prev.recalled || next.recalled) return false
  if (next.kind === 'system' || prev.kind === 'system') return false
  if (next.sentAt - prev.sentAt > GROUP_WINDOW_MS) return false
  return isSameDay(prev.sentAt, next.sentAt)
}

export function buildTimeline(messages: Message[], selfId: string): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let currentRow: MessageRow | null = null
  let lastDay = ''
  let lastMessage: Message | undefined

  const dayKeyOf = (ts: number) => dayKey(ts)

  for (const message of messages) {
    const key = dayKeyOf(message.sentAt)

    // 跨天先插一条分隔线，并且断开当前行
    if (key !== lastDay) {
      entries.push({ kind: 'divider', key: `day_${key}`, at: message.sentAt })
      lastDay = key
      lastMessage = undefined
      currentRow = null
    }

    if (message.kind === 'system' && message.recalled) {
      // 撤回后原地留一个占位，不跟别人并组。
      // isSelf 必须照作者算：写死 false 的话自己撤回的消息会跑到左边去。
      entries.push({
        kind: 'row',
        key: message.id,
        row: {
          key: message.id,
          authorId: message.authorId,
          isSelf: message.authorId === selfId,
          messages: [message],
        },
      })
      lastMessage = undefined
      currentRow = null
      continue
    }

    if (currentRow && canGroup(lastMessage, message)) {
      currentRow.messages.push(message)
    } else {
      currentRow = {
        key: message.id,
        authorId: message.authorId,
        isSelf: message.authorId === selfId,
        messages: [message],
      }
      entries.push({ kind: 'row', key: currentRow.key, row: currentRow })
    }
    lastMessage = message
  }

  return entries
}

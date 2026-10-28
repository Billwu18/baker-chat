import { useSyncExternalStore } from 'react'
import type { SessionId } from '../protocol/types'

/**
 * 每个会话各存一份没发出去的草稿。
 *
 * 之前切换会话会把输入框清空（怕发错频道），但真聊起来经常是「看到别的频道有消息，
 * 点进去看一眼，回来发现自己打了一半的话没了」。所以改成按会话存草稿：
 * 切走时存下来，切回来原样还原，发出去才清掉。
 *
 * 存 localStorage：桌面壳关掉再打开，没发完的话还在。
 */

const STORAGE_KEY = 'baker.drafts.v1'

type DraftMap = Record<SessionId, string>

let cache: DraftMap = load()
const listeners = new Set<() => void>()

function load(): DraftMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: DraftMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  } catch {
    // 无痕模式写不进去，内存里的照样能用
  }
}

function emit(): void {
  for (const listener of Array.from(listeners)) listener()
}

export function setDraft(sessionId: SessionId, text: string): void {
  if ((cache[sessionId] ?? '') === text) return
  if (text) {
    cache = { ...cache, [sessionId]: text }
  } else {
    const { [sessionId]: _dropped, ...rest } = cache
    cache = rest
  }
  persist()
  emit()
}

export function clearDraft(sessionId: SessionId): void {
  setDraft(sessionId, '')
}

export function getDraft(sessionId: SessionId | null): string {
  return sessionId ? (cache[sessionId] ?? '') : ''
}

/** 有草稿的会话 id，用于在会话卡上挂一个小标记。 */
export function draftSessionIds(): SessionId[] {
  return Object.keys(cache)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const EMPTY: DraftMap = {}

export function useDraft(sessionId: SessionId | null): string {
  const map = useSyncExternalStore(
    subscribe,
    () => cache,
    () => EMPTY,
  )
  return sessionId ? (map[sessionId] ?? '') : ''
}

export function useDraftIds(): DraftMap {
  return useSyncExternalStore(
    subscribe,
    () => cache,
    () => EMPTY,
  )
}

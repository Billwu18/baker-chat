import type { Session, SessionId } from '../protocol/types'

/**
 * 会话上的本地偏好：置顶、免打扰。
 *
 * 这两个是「我这台机器想怎么显示」，不是会话本身的性质。
 * 会话是大家一起算出来的，没地方挂这种私人偏好，所以只落在本地。
 */

const STORAGE_KEY = 'baker.session-prefs.v1'

export interface SessionPrefs {
  pinned?: boolean
  muted?: boolean
}

export type PrefsMap = Record<SessionId, SessionPrefs>

export function loadPrefs(): PrefsMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: PrefsMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const { pinned, muted } = value as SessionPrefs
      const entry: SessionPrefs = {}
      if (pinned === true) entry.pinned = true
      if (muted === true) entry.muted = true
      if (entry.pinned || entry.muted) out[key] = entry
    }
    return out
  } catch {
    return {}
  }
}

export function savePrefs(prefs: PrefsMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 写不进去就算了，内存里的还在
  }
}

/**
 * 把偏好贴到会话上并排好序：置顶的一律在前，其余按最后活跃时间倒序。
 *
 * 排序放在这里而不是组件里，是为了让所有读 sessions 的地方（会话列表、
 * 未读筛选、搜索结果）看到的是同一个顺序。
 */
export function applyPrefs(sessions: Session[], prefs: PrefsMap): Session[] {
  const merged = sessions.map((session) => {
    const pref = prefs[session.id]
    const { pinned: _p, muted: _m, ...rest } = session
    return { ...rest, pinned: pref?.pinned, muted: pref?.muted } as Session
  })
  return merged.sort(compareSessions)
}

export function compareSessions(a: Session, b: Session): number {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
  return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
}

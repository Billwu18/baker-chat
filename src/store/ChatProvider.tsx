import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ChatStore, type ChatState } from './chatStore'
import { createTransport } from '../transport'
import { personOf } from '../data/person'

/**
 * 把 ChatStore 挂到 React 树上。
 *
 * store 用 useSyncExternalStore 订阅，所以任何一次 transport 事件引起的状态变化
 * 都会精确地重渲染读到该字段的组件。
 */

const ChatContext = createContext<ChatStore | null>(null)
const ChatStateContext = createContext<ChatState | null>(null)

export function ChatProvider({
  children,
  store: injected,
}: {
  children: ReactNode
  store?: ChatStore
}) {
  const storeRef = useRef<ChatStore | null>(null)
  if (!storeRef.current) {
    storeRef.current = injected ?? new ChatStore(createTransport())
  }
  const store = storeRef.current

  // 调试口子：URL 带 ?debug=1 时把 store 挂到 window。
  // 这台机器上 Edge 的 headless 与 browser_* 插件都不可用，界面验证只能靠 CDP
  // 直接问页面；有一个稳定的 store 句柄才能把「空状态 / 断线 / 未读」这些
  // 平时靠交互才能进的状态摆出来看。
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')) {
    ;(window as unknown as { __bakerStore?: ChatStore }).__bakerStore = store
  }

  useEffect(() => {
    void store.start()
    return () => {
      void store.stop()
    }
  }, [store])

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  return (
    <ChatContext.Provider value={store}>
      <ChatStateContext.Provider value={state}>{children}</ChatStateContext.Provider>
    </ChatContext.Provider>
  )
}

/** 拿 store 本体，用来调方法（发消息、切会话…）。 */
export function useChatStore(): ChatStore {
  const store = useContext(ChatContext)
  if (!store) throw new Error('useChatStore 必须在 <ChatProvider> 内使用')
  return store
}

/** 拿状态快照。 */
export function useChatState(): ChatState {
  const state = useContext(ChatStateContext)
  if (!state) throw new Error('useChatState 必须在 <ChatProvider> 内使用')
  return state
}

/** 当前会话。 */
export function useActiveSession() {
  const state = useChatState()
  return useMemo(
    () => state.sessions.find((s) => s.id === state.activeSessionId) ?? null,
    [state.sessions, state.activeSessionId],
  )
}

/** 当前会话的消息列表。 */
export function useActiveMessages() {
  const state = useChatState()
  return useMemo(
    () => (state.activeSessionId ? (state.messages[state.activeSessionId] ?? []) : []),
    [state.messages, state.activeSessionId],
  )
}

/**
 * 「正在输入」的人名列表。
 *
 * 过期清理交给 store 里的 sweepTyping（每秒一次，清掉过期项就会 emit），
 * 组件自己再挂一个 1 秒定时器强迫重渲染纯属重复劳动，已经去掉。
 */
export function useTypingNames(): string[] {
  const state = useChatState()
  const entries = state.activeSessionId ? (state.typing[state.activeSessionId] ?? []) : []
  const now = Date.now()
  return entries.filter((e) => e.until > now).map((e) => personOf(state.roster, e.userId).name)
}

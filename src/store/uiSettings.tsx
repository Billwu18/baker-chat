import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * 纯界面偏好（与聊天连接无关，所以不放进 config.ts）。
 *
 * showSenderNames 默认 **false**：游戏原版的 Baker 消息行里根本不画发言人名字
 * （见 baker-dx 的 src/session/view/session.rs MessageRow，结构只有
 *  avatar | content(气泡堆) | avatar），默认关掉才是 1:1。
 * 但真人群聊没有名字会分不清谁是谁，所以留一个开关。
 */
export interface UiSettings {
  showSenderNames: boolean
  /**
   * 会话卡上要不要显示「最后一条消息」摘要。
   *
   * 默认 **false**：游戏原版的会话卡里只有头像 + 名字 + 一条装饰线
   * （对着游戏内截图逐张做过像素签名，9 张卡那排「小方块」图案完全一致，
   *  是装饰不是文字），既不显示摘要也没有时间。真用起来摘要很有用，所以留开关。
   */
  showSessionPreview: boolean
  /** 反方向补白：别人发的消息也铺满整行宽度上限（默认按原版 65%） */
  compactBubbles: boolean
  /** 收到别人的消息时闪一下任务栏（Tauri 下才有效） */
  flashOnMessage: boolean
}

const STORAGE_KEY = 'baker.ui.v1'

const DEFAULTS: UiSettings = {
  showSenderNames: false,
  showSessionPreview: false,
  compactBubbles: true,
  flashOnMessage: true,
}

function load(): UiSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<UiSettings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

interface Ctx {
  settings: UiSettings
  update: (patch: Partial<UiSettings>) => void
  reset: () => void
}

const UiSettingsContext = createContext<Ctx | null>(null)

export function UiSettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<UiSettings>(load)

  // 有些偏好只需要给 <body> 挂个类名让 CSS 去区分（比如是否显示消息摘要），
  // 这样卡片组件里不用到处读 context。
  useEffect(() => {
    const body = document.body
    body.classList.toggle('show-preview', settings.showSessionPreview)
    body.classList.toggle('show-names', settings.showSenderNames)
  }, [settings.showSessionPreview, settings.showSenderNames])

  const update = useCallback((patch: Partial<UiSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // 无痕模式下写不进去，忽略
      }
      return next
    })
  }, [])

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // 同上
    }
    setSettings({ ...DEFAULTS })
  }, [])

  const value = useMemo(() => ({ settings, update, reset }), [settings, update, reset])

  return <UiSettingsContext.Provider value={value}>{children}</UiSettingsContext.Provider>
}

export function useUiSettings(): Ctx {
  const ctx = useContext(UiSettingsContext)
  if (!ctx) throw new Error('useUiSettings 必须在 <UiSettingsProvider> 内使用')
  return ctx
}

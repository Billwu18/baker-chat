import { assets, AVATAR_BACKGROUND, AVATAR_FRAME, BUBBLE_OTHERS, BUBBLE_SELF, ICON_MORE, ICON_MORE_SELECTED } from '../assets/registry'

/**
 * 把原版素材的 URL 注入成 CSS 自定义属性。
 *
 * 这一步对应 baker-dx 里 main.rs 干的事：游戏把 UI 素材以 --xxx 变量的形式喂给 CSS，
 * CSS 里就只写 var(--xxx) 而不关心文件路径。我们照搬这套，好处是：
 *   - CSS 能和游戏原版保持逐行对应，好核对
 *   - 素材换路径只改这一处
 *
 * 变量名故意沿用原版命名（含下划线风格），方便和 main.css 对照。
 */
/**
 * 浏览器或 WebView2 不支持 `url()` 里的空字符串时会报 CSS 解析警告，
 * 所以拿不到素材时退回一个 1x1 透明 data URI，界面只是少个装饰，不会崩。
 *
 * **必须声明在 `ASSET_VARIABLES` 之前。** `const` 有暂时性死区：下面的表在
 * 模块求值时就会调用 `url()`，而 `url()` 要读这个常量。写在后面的话，`vite dev`
 * 里每加载一次就抛一次 `Cannot access 'BLANK' before initialization` → 整个
 * 应用白屏。生产构建之所以看不出来，是因为 Rollup 会把这种纯字面量的 `const`
 * 提到前面去 —— 于是这个 bug 只在开发模式下存在，最容易被漏掉。
 */
const BLANK =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

function url(value: string | undefined): string {
  return `url("${value && value.length > 0 ? value : BLANK}")`
}

export const ASSET_VARIABLES: Record<string, string> = {
  // 消息气泡（九宫格拉伸）
  '--message-bubble-others': url(BUBBLE_OTHERS),
  '--message-bubble-self': url(BUBBLE_SELF),

  // 头像底盘与外框
  '--avatar-background': url(AVATAR_BACKGROUND),
  '--avatar-frame': url(AVATAR_FRAME),

  // 会话标题栏左右装饰
  '--session-title-left-bar': url(assets.deco['session_title_left_bar']),
  '--session-title-right-bar': url(assets.deco['session_title_right_bar']),

  // 输入区
  '--icon-sns-message-02': url(assets.icon['icon_sns_message_02']),
  '--icon-sns-chat-emoticon': url(assets.deco['input_area_emoticon']),
  '--icon-sns-chat-emoticon-selected': url(assets.deco['input_area_emoticon_selected']),
  '--input-area-more': url(ICON_MORE),
  '--input-area-more-selected': url(ICON_MORE_SELECTED),

  // 会话卡片的纹理装饰
  '--deco_sns_tweet_decorate_02': url(assets.decorate['deco_sns_tweet_decorate_02']),
  '--sns_list_decorate_2': url(assets.decorate['sns_list_decorate_2']),
  '--deco_sns_tweet_decorate': url(assets.decorate['deco_sns_tweet_decorate']),

  // 新建会话按钮上的小图标
  '--icon-new-session': url(assets.deco['icon_new_session']),

  // 整个界面顶部的装饰条与彩色渐变
  '--top-deco-left': url(assets.deco['top-deco-left']),
  '--top-deco-right': url(assets.deco['top-deco-right']),
  '--colors': url(assets.deco['colors']),

  // 标题上的小徽记
  '--title-decoration': url(assets.deco['achievement_main_deco05']),
  '--session-decorate': url(assets.decorate['deco_sns_tweet_decorate_50']),
}

/** 把上面这些变量写到 :root 上。在 React 挂载之前调用一次即可。 */
export function installAssetVariables(): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(ASSET_VARIABLES)) {
    root.style.setProperty(name, value)
  }
}

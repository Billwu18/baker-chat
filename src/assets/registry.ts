/**
 * 资源注册表
 *
 * Baker 的界面里大量用到游戏原版素材：干员头像、38 个 emoji、216 张贴纸、
 * 40 个图标、各种装饰件。这里把它们登记成「键 → URL」的表，让业务代码可以
 * 用 `emojiUrl('SNS_EMOJI_001')` 这种稳定写法取图，而不是写死一堆相对路径。
 *
 * Vite 的 import.meta.glob 在构建期就把这些文件收进产物并给出最终 URL，
 * 所以打包后路径依然有效（WebView 里也一样）。
 */

/**
 * 把一张 `import.meta.glob` 的表取出来，取不到就退化成空表。
 *
 * ## 为什么不能写成 `const glob = import.meta.glob; glob(...)`
 *
 * `import.meta.glob` 不是运行时函数，是 **Vite 在编译期认出来的宏**。它只在
 * 实参是字面量、而且调用点长得就是 `import.meta.glob('...')` 的时候才会被替换。
 * 一旦先取到变量里再调用（哪怕类型上完全合法），Vite 扫描不到这个调用点，
 * 什么都不会做 —— 到了浏览器里 `import.meta.glob` 是 undefined，整张表变成 `{}`，
 * 于是**所有头像都是空 src**、贴纸表情全不见。这个错误极其安静：不报错、
 * 不白屏，只是图没了（真实踩过一次，就是这么发现的）。
 *
 * ## 那为什么还要包一层 try
 *
 * 因为同样的代码要在**非 Vite 环境**里跑 —— 集成探针是用 esbuild 打包给 Node 的，
 * 那里同样没有这个宏，直接调用会抛 `import.meta.glob is not a function`，
 * 而报错现场和「图片」八竿子打不着（真实发生过：探针 → chatStore → person →
 * avatars → 这里）。退化成空表是安全的：探针不渲染界面，取不到 URL 没影响。
 *
 * 两条约束合起来，唯一正确的写法就是：**字面量调用点留在原地**，外面套 try。
 */
function safeGlob(load: () => Record<string, string>): Record<string, string> {
  try {
    return load()
  } catch {
    return {}
  }
}

// 注意：avatar / sticker 是多层目录（avatar/operator、avatar/npc、sticker/game…），
// 所以用 ** 递归匹配；键取纯文件名（去扩展名），避免不同子目录同名相撞时才发现。
const avatarModules = safeGlob(() =>
  import.meta.glob('../assets/baker/extracted/avatar/**/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)
const emojiModules = safeGlob(() =>
  import.meta.glob('../assets/baker/extracted/emoji/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)
const stickerModules = safeGlob(() =>
  import.meta.glob('../assets/baker/extracted/sticker/**/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)
const iconModules = safeGlob(() =>
  import.meta.glob('../assets/baker/extracted/icon/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)
const decorateModules = safeGlob(() =>
  import.meta.glob('../assets/baker/extracted/decorate/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)
const maskModules = safeGlob(() =>
  import.meta.glob('../assets/baker/extracted/mask/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)
const bgModules = safeGlob(() =>
  import.meta.glob('../assets/baker/extracted/bg/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)
const decoModules = safeGlob(() =>
  import.meta.glob('../assets/baker/deco/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
  }),
)

/** 把 glob 结果转成「去掉扩展名的文件名 → URL」。 */
function keyByBasename(modules: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, url] of Object.entries(modules)) {
    const file = path.split('/').pop() ?? path
    out[file.replace(/\.png$/, '')] = url
  }
  return out
}

export const assets = {
  avatar: keyByBasename(avatarModules),
  emoji: keyByBasename(emojiModules),
  sticker: keyByBasename(stickerModules),
  icon: keyByBasename(iconModules),
  decorate: keyByBasename(decorateModules),
  mask: keyByBasename(maskModules),
  bg: keyByBasename(bgModules),
  deco: keyByBasename(decoModules),
}

function pick(table: Record<string, string>, key: string, fallback?: string): string {
  return table[key] ?? (fallback ? (table[fallback] ?? '') : '') ?? ''
}

/**
 * 兜底图选字典序最小的那个 key。
 *
 * 不要用 `Object.keys(table)[0]`：那取的是插入顺序，而这里的表是
 * `import.meta.glob` 铺出来的，顺序取决于模块求值次序 —— 构建一变
 * 兜底图就可能换一张，很难查。排序后取首项是稳定的。
 */
function firstKey(table: Record<string, string>): string | undefined {
  return Object.keys(table).sort()[0]
}

/**
 * 用户自己上传的头像：`data:image/<png|jpeg|webp|gif>;base64,...` 一整段。
 *
 * 和 `src/data/avatars.ts` 的判定是同一套规则，改一处要两处一起改。
 */
export const UPLOADED_AVATAR_KEY_PATTERN = /^data:image\/(png|jpeg|webp|gif);base64,/

/**
 * 干员头像。key 形如 `icon_round_chr_0032_lizhiyan`，缺失时退回一个已有头像，避免裂图。
 *
 * **上传的头像必须在这里就认出来**，不能只靠 `src/data/avatars.ts` 的
 * `resolveAvatar()`：全仓库有十来处 `<img src={avatarUrl(x.avatarKey)}>`，
 * 只要有一处忘了先过 `resolveAvatar`，上传的头像就会查不到 → 兜底成
 * **字典序最小的那张内置图**（也就是另一个人），而界面上完全看不出异常。
 * 判断放在这一层，那些调用点不改也是对的。
 */
export function avatarUrl(key: string): string {
  if (UPLOADED_AVATAR_KEY_PATTERN.test(key)) return key
  return pick(assets.avatar, key, firstKey(assets.avatar))
}

/** emoji。key 形如 `sns_emoji_001`（素材文件名是小写的）。 */
export function emojiUrl(key: string): string {
  return pick(assets.emoji, key, firstKey(assets.emoji))
}

/**
 * 贴纸。key 形如 `sns_sticker_001`。
 *
 * 素材里只有 001~014 是三位数字编号，后面那批叫 `sns_sticker_01_01` 这种，
 * 再往后是 skland 导入的 md5 文件名 —— 所以传进来的 key 很可能不存在
 * （比如凭感觉写 sns_sticker_024），这里必须兜底，否则 <img> 的 src 会是空串。
 */
export function stickerUrl(key: string): string {
  return pick(assets.sticker, key, firstGameSticker())
}

function firstGameSticker(): string {
  const keys = Object.keys(assets.sticker).sort()
  return keys.find((k) => /^sns_sticker_\d{3}$/.test(k)) ?? keys[0] ?? ''
}

/**
 * 图片消息里的图。
 *
 * 现在是**直通**：真实的图片消息带的就是 `data:` URL（用户自己挑的图，发之前
 * 已经在客户端压过），照原样交给 `<img>` 即可。
 *
 * 以前这里会拿素材 key（像 `sns_002_settlement`）去查一张内置演示风景图 ——
 * 那是演示版残留，而且兜底行为很坏：**任何**查不到的 key 都会换成同一张风景图。
 * 所以用户上传的第一张照片本来会显示成别人家的图，而且还是静默的。
 */
export function imageUrl(src: string): string {
  return src
}

/** 图标。 */
export function iconUrl(key: string): string {
  return pick(assets.icon, key)
}

/** 装饰件（来自 assets/deco，比 extracted 更常用）。 */
export function decoUrl(key: string): string {
  return pick(assets.deco, key, firstKey(assets.deco))
}

/** 游戏原版的装饰件（assets/extracted/decorate，101 个，命名多为 deco_sns_* / bg_sns_tweet_decorate_*）。 */
export function decorateUrl(key: string): string {
  return pick(assets.decorate, key)
}

// --- 界面里固定用到的几个原版素材，单独导出方便直接引用 ---------------------

/** 气泡：别人（左） */
export const BUBBLE_OTHERS = pick(assets.deco, 'bg_message_left')
/** 气泡：自己（右） */
export const BUBBLE_SELF = pick(assets.deco, 'bg_message_right')
/** 会话标题左侧蓝条 */
export const TITLE_LEFT_BAR = pick(assets.deco, 'session_title_left_bar')
/** 会话标题右侧装饰 */
export const TITLE_RIGHT_BAR = pick(assets.deco, 'session_title_right_bar')
/** 头像底盘（圆形底 + 装饰圈） */
export const AVATAR_BACKGROUND = pick(assets.mask, 'mask_snscharentry_head')
/** 头像外框 */
export const AVATAR_FRAME = pick(assets.bg, 'bg_snscharentry_head_Line')

export const ICON_SEND = iconUrl('icon_sns_message_02')
export const ICON_NEW_SESSION = decoUrl('icon_new_session')
export const ICON_EMOTICON = decoUrl('input_area_emoticon')
export const ICON_EMOTICON_SELECTED = decoUrl('input_area_emoticon_selected')
export const ICON_MORE = decoUrl('input_area_more')
export const ICON_MORE_SELECTED = decoUrl('input_area_more_selected')
export const TOP_DECO_LEFT = decoUrl('top-deco-left')
export const TOP_DECO_RIGHT = decoUrl('top-deco-right')
export const COLORS = decoUrl('colors')
export const TITLE_DECORATION = decoUrl('achievement_main_deco05')

/** 协议里的 emoji key 与游戏内素材编号的对照。 */
export const EMOJI_KEYS: string[] = Object.keys(assets.emoji).sort()

/**
 * 贴纸面板用的 key 列表。
 *
 * 只收游戏原版那批 `sns_sticker_*`：`assets.sticker` 里还混着 48 个 skland 导入的
 * md5 文件名，直接 sort 会让一串乱码排在前面。
 */
export const STICKER_KEYS: string[] = Object.keys(assets.sticker)
  .filter((k) => k.startsWith('sns_sticker'))
  .sort()

/** 全部素材里实际存在的贴纸 key（含 skland 导入的那批），调试用。 */
export const ALL_STICKER_KEYS: string[] = Object.keys(assets.sticker).sort()

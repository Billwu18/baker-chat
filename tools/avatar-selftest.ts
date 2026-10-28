/**
 * 头像解析的自检。
 *
 * 跑法：
 *   npx esbuild tools/avatar-selftest.ts --bundle --format=esm --platform=node \
 *     --outfile=.tmp/avatar-selftest.mjs && node .tmp/avatar-selftest.mjs
 *
 * 为什么这块值得单独测：2.0 加了「用户自己上传头像」，而上传的头像不是
 * 一个内置 key，是一整段 `data:image/...;base64,...`。界面上有十来处
 * `<img src={avatarUrl(x.avatarKey)}>`，只要 `avatarUrl()` 不认这种 key，
 * 它就会走「查不到 → 兜底成字典序最小的那张内置图」那条路 ——
 * **上传的人会顶着一张别人的脸**，而界面、控制台、类型检查全都一声不吭。
 *
 * 这个 bug 真实发生过一次：`resolveAvatar()` 写对了，但只有设置面板调它，
 * 其余十处还在直接调 `avatarUrl()`。所以这里的核心断言不是「resolveAvatar
 * 对不对」，而是「**只调 avatarUrl 也必须对**」—— 那才是绝大多数调用点的样子。
 */

import { avatarUrl, UPLOADED_AVATAR_KEY_PATTERN } from '../src/assets/registry'
import {
  BUILTIN_AVATARS,
  DEFAULT_AVATAR_KEY,
  isUploadedAvatar,
  resolveAvatar,
} from '../src/data/avatars'


let passed = 0
let failed = 0

function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${name}${extra}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${extra}`)
  }
}

/** 上传头像的四种合法图片类型。 */
const VALID_UPLOADS = [
  ['png', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='],
  ['jpeg', 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='],
  ['webp', 'data:image/webp;base64,UklGRhIAAABXRUJQ'],
  ['gif', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP'],
] as const

/** 看着像 data: 但不该被当成图片头像的。 */
const INVALID_UPLOADS = [
  ['svg（能带脚本）', 'data:image/svg+xml;base64,PHN2Zy8+'],
  ['html', 'data:text/html;base64,PGI+aGk8L2I+'],
  ['不是图片协议', 'javascript:alert(1)'],
  ['只是内置相册的 key', 'icon_round_chr_0018_dapan'],
] as const

console.log('=== 上传的头像必须被 avatarUrl 认出来 ===')

for (const [name, url] of VALID_UPLOADS) {
  // 这一条是这个文件存在的理由：**不经过 resolveAvatar**，直接调 avatarUrl。
  check(`avatarUrl 原样返回上传的 ${name}`, avatarUrl(url) === url, ` → ${avatarUrl(url).slice(0, 28)}…`)
}

console.log('\n=== 不该被当成图片的串要被挡住 ===')

for (const [name, url] of INVALID_UPLOADS) {
  const resolved = avatarUrl(url)
  check(`avatarUrl 不把 ${name} 当 src`, !resolved.startsWith('data:'), ` → ${resolved || '(空)'}`)
  check(`isUploadedAvatar 对 ${name} 说不是`, !isUploadedAvatar(url))
}

console.log('\n=== resolveAvatar 的三种情况 ===')

for (const [name, url] of VALID_UPLOADS) {
  check(`resolveAvatar 直通上传的 ${name}`, resolveAvatar(url) === url)
}
check('没挑过头像（空串）退回默认那张', resolveAvatar('') === avatarUrl(DEFAULT_AVATAR_KEY))
check('没挑过头像（undefined）退回默认那张', resolveAvatar(undefined) === avatarUrl(DEFAULT_AVATAR_KEY))
check(
  '内置相册的 key 和直接调 avatarUrl 结果一致',
  resolveAvatar('icon_round_chr_0018_dapan') === avatarUrl('icon_round_chr_0018_dapan'),
)
check(
  '不认识的 key 也不炸（只是兜底）',
  typeof resolveAvatar('这个 key 根本不存在') === 'string',
)

console.log('\n=== 相册本身 ===')

const keys = BUILTIN_AVATARS.map((o) => o.key)
check('相册里没有重复 key', new Set(keys).size === keys.length, ` → ${keys.length} 张`)
check('默认头像在相册里', keys.includes(DEFAULT_AVATAR_KEY))
check('每张都有显示名', BUILTIN_AVATARS.every((o) => o.label.length > 0))
check(
  '凡是客户端认得出的上传头像，都过得了自己的前缀清单',
  VALID_UPLOADS.every(([, url]) => UPLOADED_AVATAR_KEY_PATTERN.test(url)),
)
check(
  '凡是客户端拒掉的串，都过不了前缀清单',
  INVALID_UPLOADS.every(([, url]) => !UPLOADED_AVATAR_KEY_PATTERN.test(url)),
)

console.log(`\n${failed === 0 ? '全部通过' : `有 ${failed} 项失败`}（${passed} 项通过）`)
if (failed > 0) process.exit(1)

import { avatarUrl, UPLOADED_AVATAR_KEY_PATTERN } from '../assets/registry'

/**
 * 内置头像相册。
 *
 * v1 的 `operators.ts` 是一张「假人表」：它把 id / 名字 / 编号 / 在线状态
 * 和头像图捆在一起，于是所有人都只能从这 14 个人里挑，界面显示的人也
 * 全是这张表里的人。
 *
 * 2.0 把这张表拆开，只保留其中真正有价值的那一半 —— **图片**。
 * 它就是一本相册：用户自己挑一张当头像。至于「人是谁、叫什么、编号多少、
 * 在不在线」，一律来自真实身份和名册，不再有任何本地名单。
 */

export interface AvatarOption {
  /** 素材 basename，同时就是 `avatarUrl()` 认的 key。 */
  key: string
  /** 相册里的显示名。只是给用户认脸用的标签，不是谁的名字。 */
  label: string
}

export const BUILTIN_AVATARS: AvatarOption[] = [
  { key: 'icon_round_chr_0003_endminf', label: '管理员' },
  { key: 'icon_round_chr_0032_lizhiyan', label: '李织烟' },
  { key: 'icon_round_chr_0030_zhuangfy', label: '庄方宜' },
  { key: 'icon_round_chr_0005_chen', label: '陈千语' },
  { key: 'icon_round_chr_0031_mifu', label: 'Mifu' },
  { key: 'icon_round_chr_0004_pelica', label: '佩丽卡' },
  { key: 'icon_round_chr_0013_aglina', label: '安洁莉娜' },
  { key: 'icon_round_chr_0006_wolfgd', label: '狼卫' },
  { key: 'icon_round_chr_0007_ikut', label: '伊库特' },
  { key: 'icon_round_chr_0011_seraph', label: '赛希' },
  { key: 'icon_round_chr_0018_dapan', label: '大潘' },
  { key: 'icon_round_chr_0027_tangtang', label: '糖糖' },
  { key: 'icon_round_chr_0017_yvonne', label: '伊冯' },
  { key: 'icon_round_chr_0038_purrche', label: '秋栗' },
]

/** 没挑过头像时给这张。 */
export const DEFAULT_AVATAR_KEY = 'icon_round_chr_0003_endminf'

/**
 * 上传的头像就是一段 data: URL，直接当 `src` 用。
 *
 * 之所以不做成「存文件 + 一条取文件的协议」：那要为一个头像单独加一套
 * 请求/应答，还要考虑对面不在线时怎么办。data: URL 跟着名册一起走，
 * 天然可用，也不需要任何额外的往返。
 *
 * 代价是名册会变大，所以上传前要压到很小（见 AVATAR_MAX_BYTES），
 * 收的那一方也按同一套规则拒收过大的串。
 */
export function isUploadedAvatar(key: string | undefined): boolean {
  return typeof key === 'string' && UPLOADED_AVATAR_KEY_PATTERN.test(key)
}

/**
 * 把 avatarKey 解析成 `<img src>`：内置相册的 key、上传的 data: URL、或者空值。
 *
 * 空值退回默认头像，让「没挑过」和「key 写错了」不会长得一模一样。
 * 另外两种情况交给 `avatarUrl()` —— 它那一层认得 data: URL（理由见那边的注释）。
 */
export function resolveAvatar(key: string | undefined): string {
  return avatarUrl(key || DEFAULT_AVATAR_KEY)
}

/** 上限。收到别人名册的那一方也按同一套规则校验。 */
export const AVATAR_MAX_BYTES = 32 * 1024
export const NAME_MAX_LENGTH = 24

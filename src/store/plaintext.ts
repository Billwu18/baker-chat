import type { Message } from '../protocol/types'

/**
 * 「这条消息是不是明文走的？」
 *
 * 单独拎出来而不是写在 `chatStore` 里的原因和 `crypto/keyOwnership.ts` 一样：
 * 这是一条**规则**，规则要能被单测钉住。放在 store 里面就只能靠手工点界面验证，
 * 而这个判定的误报特别隐蔽 —— 判错一次用户就学会无视那条警告，等于没有。
 *
 * ## 三个条件缺一不可
 *
 * 1. **没有 `cipher`**。有信封就是加密过的，不用看别的。
 *
 * 2. **不是还没落地的乐观消息**（`pending` / `failed`）。
 *    乐观消息是拿 `sendText` 的入参直接铺出来的，天生没有 `cipher`、天生带 `text`。
 *    不排掉的话，**每一次正常发消息**都会在 `message:ack` 回来之前闪一下
 *    「明文发出去了」，而这是最常走的那条路 —— 误报比不报更糟。
 *    排掉之后语义也正好：能走到判定这一步，说明这条已经落地了（对端收下并回了
 *    ack，本地回显也算），此时 `text` 还在而 `cipher` 还是没有，那就真是明文。
 *
 * 3. **身上确实有正文**（`text` / `imageUrl` / `stickerKey`）。
 *    ⚠ 不能简单地「没有 `cipher` 就算明文」：`fileId` / `fileName` / `fileMime`
 *    这些字段**本来就在信封外面**（发送路径只把 `text` / `imageUrl` / `stickerKey`
 *    塞进密文，见 `chatStore.sendMessage`），所以传文件的那条路上这几个字段
 *    永远不加密。按「没有 cipher」判，每一次传文件都会被误报成明文。
 *    反过来说，`fileId` 是内容哈希、`fileName` 是文件名，它们确实会明文经手 ——
 *    但那不是这个提示要管的事（它管的是**正文**），所以不算。
 *
 * 系统消息（`kind: 'system'`，比如「消息已被撤回」）没有上面任何一个字段，
 * 自然就落在 `false` 这边 —— 它们本来也不携带用户内容。
 */
export function isPlaintextMessage(message: Message): boolean {
  if (message.cipher) return false
  if (message.pending || message.failed) return false
  return Boolean(message.text || message.imageUrl || message.stickerKey)
}

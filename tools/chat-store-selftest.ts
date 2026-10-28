/**
 * store 层纯规则的自检。
 *
 * 跑法：
 *   npx esbuild tools/chat-store-selftest.ts --bundle --format=esm --platform=node \
 *     --outfile=.tmp/chat-store-selftest.mjs && node .tmp/chat-store-selftest.mjs
 *
 * 目前只有一条规则：`isPlaintextMessage`（报告 M3「明文降级没有用户可见提示」）。
 *
 * 为什么把它拎出来单独测：这条判定**只影响一条警告**，判错不会崩、不会抛，
 * 类型检查也看不出来 —— 但误报的代价是用户从此无视这条警告，那比不提示更糟
 * （提示的价值全靠它稀少而准确）。所以「不该报的四种情况」和「该报的三种情况」
 * 都要钉死，尤其是最常走的两条路：**正常加密发送**和**乐观消息**。
 */

import { isPlaintextMessage } from '../src/store/plaintext'
import type { Message } from '../src/protocol/types'

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

/** 铺一条消息。字段都给了默认值，测哪一项就覆盖哪一项。 */
function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    authorId: 'u_a',
    kind: 'text',
    sentAt: 1,
    ...over,
  } as unknown as Message
}

function main() {
  // ------------------------------------------------------------ 不该报
  console.log('=== 不该报「明文」的四种情况 ===')

  // ★ 最常走的一条路：正常加密发送。ack 回来之后 cipher 就有值了。
  check(
    '加密过的正文不算明文',
    !isPlaintextMessage(msg({ cipher: '{"v":1}', cipherVersion: 1, cipherSeq: 3 })),
  )
  check(
    '加密过的图片不算明文',
    !isPlaintextMessage(msg({ kind: 'image', cipher: '{"v":1}', cipherSeq: 4 })),
  )

  // ★ 第二条常走的路：我刚发出去、ack 还没回来的那条乐观消息。
  //   它是拿入参直接铺的，天生没有 cipher 又天生带 text。
  check('还没落地的乐观消息不算（不然每发一条都要闪一次）', !isPlaintextMessage(msg({ text: '在吗', pending: true })))
  check('发失败的也不算（那条会显示「重发」，不是明文警告）', !isPlaintextMessage(msg({ text: '在吗', failed: true })))
  check(
    'pending 且带图的乐观消息也不算',
    !isPlaintextMessage(msg({ kind: 'image', imageUrl: 'blob:x', pending: true })),
  )

  // ★ 传文件这条路上 fileId / fileName 从来就在信封外面 —— 按「没有 cipher 就算明文」
  //   会把每一次传文件都误报。它们确实明文经手，但那不是这条提示管的事。
  check(
    '只有 fileId / fileName（文件声明本身不加密）不算',
    !isPlaintextMessage(
      msg({ kind: 'file', fileId: 'sha256-abc', fileName: '报告.pdf', fileMime: 'application/pdf', fileSize: 123 }),
    ),
  )
  check('文件下载好了也不是正文泄露', !isPlaintextMessage(msg({ kind: 'file', fileId: 'sha256-abc', fileUrl: 'blob:y' })))

  // 系统消息没有任何一个正文字段，自然落在 false。
  check('撤回后的系统消息不算', !isPlaintextMessage(msg({ kind: 'system', systemText: '消息已被撤回', recalled: true })))
  check('完全空的消息不算', !isPlaintextMessage(msg({})))

  // ------------------------------------------------------------ 该报
  console.log('=== 该报「明文」的三种情况 ===')

  // 这三种只有一种可能：当时没有会话密钥，正文原样发了出去。
  check('没加密的文本算明文', isPlaintextMessage(msg({ text: '在吗' })))
  check('没加密的图片算明文', isPlaintextMessage(msg({ kind: 'image', imageUrl: 'blob:x' })))
  check('没加密的贴纸算明文', isPlaintextMessage(msg({ kind: 'sticker', stickerKey: 'st_1' })))

  // 空字符串是「没有正文」，不能因为 Boolean('') === false 之外的原因漏判。
  check('空 text 不算（没有可泄露的正文）', !isPlaintextMessage(msg({ text: '' })))

  // 同一条消息只认一个结论：有 cipher 就是加密的，text 还留着也只说明
  // 别的环节没清干净（见 sendMessage 里那句「留着等于明文照样发出去了」）。
  check(
    'cipher 和 text 同时存在时按加密算',
    !isPlaintextMessage(msg({ text: '在吗', cipher: '{"v":1}', cipherSeq: 5 })),
  )

  console.log('')
  console.log(`${passed} 项通过，${failed} 项失败`)
  if (failed > 0) process.exit(1)
}

main()

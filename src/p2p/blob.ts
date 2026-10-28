/**
 * 文件块仓库 —— 按内容寻址（`sha256(内容)` 就是它的名字）。
 *
 * ## 为什么按内容而不是按文件名
 *
 * 局域网里「同一张图发给三个人」是很常见的。按文件名寻址时，三个人各存一份，
 * 而且改名之后对不上；按内容寻址时，**同一坨字节全局只有一个名字**，
 * 于是：
 *
 *   - 天然的自动去重：第二个人发同一张图，本地一行都不用重存；
 *   - 天然的完整性校验：收到之后重算一遍哈希，对不上就不是它，
 *     不需要另立一套校验和字段；
 *   - 「我要这个文件」变成一个精确的问题（按 id 要），不会因为重名而歧义。
 *
 * ## 为什么不做分块（chunk）上传
 *
 * 局域网里单次传输的典型规模是照片和文档（几百 KB 到几十 MB），一次
 * TCP 帧就能装下，分块带来的是「断点续传」这种我们暂时不需要的能力，
 * 代价却是每个文件多一层块索引、多一堆「哪些块到了」的状态。
 * 超过 `MAX_BLOB_BYTES` 的文件这一版直接拒收，比做半个分块实现好。
 */

import { fromB64, toB64, toB64Url } from '../crypto/core'
import type { Bytes } from '../crypto/core'

/**
 * 一个仓库能装多少。
 *
 * 按「总字节」而不是「文件个数」限，因为撑爆内存的是字节。256MB 大约是
 * 几千张照片 —— 到了这个量级用户该自己清理了，而不是让应用悄悄吃掉几 GB。
 */
export const MAX_BLOB_TOTAL_BYTES = 256 * 1024 * 1024

/** 单个文件的上限。和 Rust 那层 64MB 的帧上限对齐（base64 会膨胀 4/3）。 */
export const MAX_BLOB_BYTES = 32 * 1024 * 1024

/** 一个文件块在仓库里的样子。 */
export interface BlobMeta {
  /** = sha256 内容的 base64url。既是 id，也是校验和。 */
  id: string
  /** 字节数。 */
  size: number
  /** 原始文件名，只用于显示和保存对话框的默认值，不参与寻址。 */
  name: string
  /** MIME 类型（尽力而为，来自发送方）。 */
  mime: string
}

/**
 * 字节放哪儿。
 *
 * 接口只要求「按 id 拿、按 id 放」，**不要求持久化** —— 内存实现就能满足
 * 一次会话内的收发。持久化（IndexedDB）是后续的事，接口留在这里是为了
 * 那时候不用改调用方。
 */
export interface BlobStore {
  has(id: string): boolean
  get(id: string): Bytes | undefined
  /** 放一坨字节。返回 false = 没放进去（超上限），调用方要据此告诉用户。 */
  put(id: string, bytes: Bytes): boolean
  meta(id: string): BlobMeta | undefined
  /** 记下显示用的元信息（名字 / MIME）。字节可以由别人先放进来。 */
  describe(id: string, patch: Partial<Pick<BlobMeta, 'name' | 'mime' | 'size'>>): void
  /** 现在占用多少字节。 */
  usage(): number
  /** 列出全部文件（给「文件」页面用）。 */
  list(): BlobMeta[]
}

/** 内容 → id。发送方和接收方都用它，是两边对齐的唯一凭据。 */
export async function blobIdOf(bytes: Bytes): Promise<string> {
  return toB64Url(await crypto.subtle.digest('SHA-256', bytes))
}

/**
 * 收到字节之后重算一遍，看它是不是自称的那个文件。
 *
 * 这一步不能省：`blob-data` 帧里的 id 是对端写的，而对端可能写错、
 * 也可能故意写错（把一张图说成另一张的 id，让接收方覆盖掉已有的那份）。
 * 哈希对不上就当这坨字节没来过。
 */
export async function blobMatches(id: string, bytes: Bytes): Promise<boolean> {
  return (await blobIdOf(bytes)) === id
}

/** 把 base64（线上格式）解成字节。 */
export function decodeBlob(b64: string): Bytes | undefined {
  try {
    return fromB64(b64)
  } catch {
    return undefined
  }
}

/** 把字节编成线上格式。 */
export function encodeBlob(bytes: Bytes): string {
  return toB64(bytes)
}

// ---------------------------------------------------------------- 内存实现

/**
 * 纯内存的块仓库。
 *
 * `describe` 和 `put` 分开，是因为元信息和字节**来源不同**：文件的字节可能
 * 是从对端拉来的，而「它叫什么名字」来自事件（`file` kind 的 body）。
 * 于是接收顺序不影响结果 —— 先收到事件（知道叫「合同.pdf」）还是先收到
 * 字节（知道 id 和大小）都行。
 */
export class MemoryBlobStore implements BlobStore {
  private readonly bytes = new Map<string, Bytes>()
  private readonly metas = new Map<string, BlobMeta>()
  private used = 0

  has(id: string): boolean {
    return this.bytes.has(id)
  }

  get(id: string): Bytes | undefined {
    return this.bytes.get(id)
  }

  /**
   * 放一坨字节进去。**超过总量上限时拒收**（返回 false），而不是悄悄挤掉
   * 别人 —— 被挤掉的那个可能是用户正在看的一张图。
   */
  put(id: string, bytes: Bytes): boolean {
    const existing = this.bytes.get(id)
    if (existing) return true // 同一个内容重复放入：天然幂等

    if (this.used + bytes.length > MAX_BLOB_TOTAL_BYTES) return false
    if (bytes.length > MAX_BLOB_BYTES) return false

    this.bytes.set(id, bytes)
    this.used += bytes.length

    const meta = this.metas.get(id)
    if (meta) meta.size = bytes.length
    else this.metas.set(id, { id, size: bytes.length, name: '', mime: '' })
    return true
  }

  meta(id: string): BlobMeta | undefined {
    return this.metas.get(id)
  }

  describe(id: string, patch: Partial<Pick<BlobMeta, 'name' | 'mime' | 'size'>>): void {
    const existing = this.metas.get(id)
    if (existing) {
      if (patch.name) existing.name = patch.name
      if (patch.mime) existing.mime = patch.mime
      if (patch.size) existing.size = patch.size
      return
    }
    this.metas.set(id, {
      id,
      size: patch.size ?? 0,
      name: patch.name ?? '',
      mime: patch.mime ?? '',
    })
  }

  usage(): number {
    return this.used
  }

  list(): BlobMeta[] {
    return [...this.metas.values()].filter((m) => this.bytes.has(m.id))
  }
}

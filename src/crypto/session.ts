/**
 * 会话密钥管理 —— 把 envelope.ts 里的零件接成「一个会话一把钥匙」。
 *
 * ## 为什么是「一个会话一把钥匙」而不是「每人一把」
 *
 * 群聊里如果对每个收件人各加密一次，14 个人的会话发一张 4MB 的图就是
 * 14 次 AES + 14 次 base64 —— 实测 base64 是 28MB/s（见 docs/加密与身份.md），
 * 那就是 2 秒。改成「会话密钥加密一次，密钥包各发一份」，成本回到 1 次。
 *
 * 代价是：**任何持有会话密钥的成员都能解密该会话的全部消息**，而且
 * 因为 senderId 进了 AAD，成员不能冒充另一个成员发消息（改了 AAD 就验不过）。
 *
 * ## 密钥怎么到别人手里
 *
 * 第一个发言的人（或者第一个建会话的人）生成会话密钥，然后用 X25519
 * 对每个成员**各包一份**（wrapSessionKey），把这一把包好的副本各发一份过去。
 * 密钥包走的是事件日志，每一个经手的节点（包括转发它的第三方）都解不开 ——
 * 他们没有成员的私钥。
 *
 * 密钥包的 AAD 绑的是 `会话 + 发件人 + 收件人` 三样（见 `envelope.ts` 的
 * `wrappedKeyAad`）。少一样都不行：只绑发件人/收件人的话，同一对人在两个群里
 * 都在，包就能互换 —— 群里另一个成员可以把「给鲍勃的 S1 包」塞进 S2，
 * 把鲍勃顶到 S1 的钥匙上，然后拿自己那份 S1 钥匙读鲍勃在 S2 里说的话。
 *
 * ## 前向保密：没有
 *
 * 会话密钥是长期存在的，一旦泄露，之前抓到的密文全部可解。
 * 要做成 Signal 那种每条消息换一次密钥的双棘轮，前提是消息严格有序，
 * 而这个应用是多设备、可能乱序的。这是明确的取舍，不是遗漏。
 */

import {
  importAesKey,
  generateSessionKey,
  exportAesKey,
  seal,
  open,
  wrapSessionKey,
  unwrapSessionKey,
  type Envelope,
} from './envelope'
import type { IdentityKeys, PublicIdentity } from './keys'
import { importPublicX, exportPublic } from './keys'
import { toB64, fromB64 } from './core'

/**
 * 名册里一个人的身份 —— 公钥 + 别人自己起的名字。
 *
 * 名字只是**标签**，公钥才是身份（`id` 就是从公钥算出来的，见 p2p/event.ts）。
 * 所以这里两个都要：名字用来认人，公钥用来保证认对的是那个人。
 */
export interface PeerIdentity extends PublicIdentity {
  id: string
}

/** 一个会话当前生效的那把钥匙。 */
interface SessionKey {
  version: number
  key: CryptoKey
  /**
   * 旧版本的钥匙，按版本号留着。
   *
   * `version` 往上走本意是「这把钥匙坏了 / 建钥人换人了 → 换一把」。但换掉
   * 之后，用旧版本写出去的那些消息仍然是旧钥匙加密的 —— 只留最新那一把的话，
   * **轮换本身就等于把历史消息全部变成空气泡**。于是「钥匙出问题时重建一把」
   * 这条路谁都不敢走，宁可整套卡死也不换钥匙（报告 M2 说的就是这个终态）。
   *
   * 留着旧版本，轮换才是一个能用来救场的动作，而不是一次数据丢失。
   */
  history: Map<number, CryptoKey>
  /** 我是不是这把钥匙的生成者 —— 生成者才有义务把包发出去。 */
  mine: boolean
  /**
   * 我已经给谁包过一份了。
   *
   * 存在的理由：建群的那一刻，某个成员的 profile 事件可能**还没同步过来** ——
   * 名册里没有他的公钥，我就包不了。等他同步过来之后要补包，
   * 补包时得知道「哪些人已经有了」，否则每来一个人就把所有人都重包一遍。
   *
   * 只有在**发布成功之后**才会往里加（见 markWrapped），失败不加 ——
   * 否则一次网络抖动就会让某个人永久地被跳过。
   */
  wrappedFor: Set<string>
}

/**
 * 别人发布 `key` 事件时，顺手带给我的那份密钥包 ——
 * 收件人是我，所以只有我的私钥能开它。
 */
export interface WrappedKey {
  senderId: string
  keyVersion: number
  env: Envelope
}

/**
 * 附加认证数据。四段各自钉死一件事：
 *   sessionId  —— 消息不能被挪到别的会话
 *   keyVersion —— 换过钥匙之后，旧密钥加密的消息不能拿来冒充新的
 *   authorId   —— 不能冒充别人发消息
 *   seq        —— 不能重放第 2 条来冒充第 1 条
 */
export function messageAad(
  sessionId: string,
  keyVersion: number,
  authorId: string,
  seq: number,
): string {
  return `msg|${sessionId}|${keyVersion}|${authorId}|${seq}`
}

export class CryptoSessionManager {
  private keys = new Map<string, SessionKey>()

  constructor(
    private readonly identity: IdentityKeys,
    private readonly selfId: string,
  ) {}

  hasKey(sessionId: string): boolean {
    return this.keys.has(sessionId)
  }

  keyVersion(sessionId: string): number {
    return this.keys.get(sessionId)?.version ?? 0
  }

  /**
   * 第一次进这个会话时，生成一把钥匙并给每个成员各包一份。
   *
   * 注意：**只生成，不发送**。把包发出去是调用方的事 ——
   * 这个模块不碰网络，这样它才能在 node 里被直接测。
   *
   * 如果这个会话**已经有我建的钥匙**，不会再造一把：换钥匙意味着
   * 已经发出去的消息全部作废。这时退化成 {@link wrapFor}，只给还没包过的人补。
   * 早期版本在这里无条件覆盖，结果是「补一次包就把自己的钥匙换掉，
   * 于是连原本能读消息的人都读不了了」。
   *
   * **给自己也包一份**（见 {@link selfEnvelope}）。这一步不是多余的：
   * 建钥匙的人原来只在内存里留着这把钥匙，日志里只有「发给别人」的包，
   * 于是**一重启，建钥匙的人自己就把钥匙弄丢了** —— 它会以为自己是第一次
   * 进来，重新生成一把，然后：
   *   - 自己发的旧消息解不开（界面上一排空气泡）
   *   - 新消息用一把别人手上没有的钥匙发出去，于是**所有人都解不开**
   * 两个症状都不报错，只是默默读不出来。给自己包一份，重启后就能像别人那样
   * 从日志里查回来（`keyFetch`）。
   *
   * @returns 每个成员一份的密钥包；members 里不含自己，但返回值里有。
   */
  async createFor(
    sessionId: string,
    members: PeerIdentity[],
    options: { minVersion?: number } = {},
  ): Promise<{ keyVersion: number; wrapped: Record<string, Envelope> }> {
    const existing = this.keys.get(sessionId)
    if (existing) {
      return (await this.wrapFor(sessionId, members)) ?? { keyVersion: existing.version, wrapped: {} }
    }

    const key = await generateSessionKey()
    // ---------------------------------------------------------------
    // 版本号必须**真的比已经发布过的那个高**。
    //
    // 对端对「不高于自己」的版本一律拒收（单向棘轮），同版本的包只会被拿去
    // 补空缺。所以「本地没有钥匙、但日志里躺着一个更高版本的包」时，
    // 拿 1 去建一把新钥匙 = 对端静默丢弃 + 本地拿它发消息 = 双向全哑、零报错。
    // `minVersion` 就是给这种情况留的：调用方已经从日志里看到过第 N 版，
    // 那就从 N+1 开始。
    // ---------------------------------------------------------------
    // 能走到这里就说明本地**没有**这个会话的钥匙（有的话上面已经去补包了），
    // 所以版本的下界只能来自 `minVersion` —— 也就是「调用方在日志里见过第几版」。
    const version = (options.minVersion ?? 0) + 1
    const entry: SessionKey = {
      version,
      key,
      history: new Map(),
      mine: true,
      wrappedFor: new Set(),
    }
    this.keys.set(sessionId, entry)

    const wrapped: Record<string, Envelope> = {}
    // 单个成员封包失败**不能**拖垮整个会话。
    //
    // 一个成员的 X25519 公钥如果是小阶点（或者干脆是坏 base64），
    // `wrapSessionKey` 会抛。原来这里没有 try —— 异常穿透 `createFor`，
    // `keyPublish` 永不执行，于是**谁都没有钥匙**，所有人静默降级成明文。
    // 而公钥来自对端自己发的 profile 事件，谁都能写。
    //
    // 跳过个别成员是有代价的（他这次收不到钥匙，之后会走「补包」那条路），
    // 但「这个会话少一个人」远好过「这个会话全员明文」。
    for (const member of members) {
      if (member.id === this.selfId) continue
      try {
        const theirPub = await importPublicX(member.x)
        wrapped[member.id] = await wrapSessionKey(
          this.identity.xPrivate,
          theirPub,
          key,
          sessionId,
          this.selfId,
          member.id,
        )
      } catch (error) {
        console.warn(
          `[crypto] 会话 ${sessionId}：给 ${member.id} 的密钥包封不出来，跳过这个人。`,
          error,
        )
      }
    }
    const mine = await this.selfEnvelope(sessionId)
    if (mine) wrapped[this.selfId] = mine
    return { keyVersion: version, wrapped }
  }

  /**
   * 把会话密钥包一份给**自己**。
   *
   * 用自己的 X25519 私钥 + 自己的公钥做一次 ECDH —— 数学上和给别人包没区别，
   * 只是收发双方是同一个人。这样日志里就有一份「只有我能开」的副本，
   * 重启 / 换设备之后能取回来；别人依然解不开它（他们没有我的私钥）。
   */
  async selfEnvelope(sessionId: string): Promise<Envelope | null> {
    const entry = this.keys.get(sessionId)
    if (!entry) return null
    const minePub = await exportPublic(this.identity)
    const selfPub = await importPublicX(minePub.x)
    return wrapSessionKey(
      this.identity.xPrivate,
      selfPub,
      entry.key,
      sessionId,
      this.selfId,
      this.selfId,
    )
  }

  /**
   * 给「还没包过的成员」补包，**沿用当前这把钥匙**。
   *
   * 用在两个地方：
   *   1. 建群时对方的 profile 还没同步过来、拿不到公钥；等他出现后这里补上
   *   2. 会话中途加入了新成员
   *
   * 返回的包由调用方发布；**发布成功之后必须调 {@link markWrapped}**，
   * 否则下次还会重包一遍。
   *
   * @returns 没有我建的钥匙时返回 null（补包只能由建钥匙的人做）
   */
  async wrapFor(
    sessionId: string,
    members: PeerIdentity[],
  ): Promise<{ keyVersion: number; wrapped: Record<string, Envelope> } | null> {
    const entry = this.keys.get(sessionId)
    if (!entry || !entry.mine) return null

    const wrapped: Record<string, Envelope> = {}
    // 同 `createFor`：一个人封包失败不能拖垮补包这件事本身。
    // 跳过他就少一个收件人，`missingPeers` 下次还会把他带进来重试；
    // 而不跳过的代价是整次补包抛出、其余成员全都拿不到钥匙。
    for (const member of members) {
      if (member.id === this.selfId) continue
      if (entry.wrappedFor.has(member.id)) continue
      try {
        const theirPub = await importPublicX(member.x)
        wrapped[member.id] = await wrapSessionKey(
          this.identity.xPrivate,
          theirPub,
          entry.key,
          sessionId,
          this.selfId,
          member.id,
        )
      } catch (error) {
        console.warn(`[crypto] 会话 ${sessionId}：补包时 ${member.id} 封不出来，跳过。`, error)
      }
    }
    return { keyVersion: entry.version, wrapped }
  }

  /**
   * 我建了钥匙，但这些人还没有份。
   *
   * 返回的是**当前成员里有公钥、但我还没包过**的人。名册里根本没公钥的
   * 成员不会出现在这里 —— 那要等对方的 profile 同步过来，是另一条路径。
   */
  missingPeers(sessionId: string, members: PeerIdentity[]): string[] {
    const entry = this.keys.get(sessionId)
    if (!entry || !entry.mine) return []
    return members
      .filter((m) => m.id !== this.selfId && !entry.wrappedFor.has(m.id))
      .map((m) => m.id)
  }

  /**
   * 记下「这些人的包已经发出去了」。
   *
   * 必须**在发布确实成功之后**调。提前调的话，一次失败就会让这个人
   * 被永久跳过 —— 而那正是最难查的一类 bug：谁都没报错，就是有个人读不到。
   */
  markWrapped(sessionId: string, ids: string[]): void {
    const entry = this.keys.get(sessionId)
    if (!entry) return
    for (const id of ids) entry.wrappedFor.add(id)
  }

  /**
   * 收到别人发给我的密钥包，解开它。
   *
   * @param senderPub 发件人的公开身份 —— 必须是 `verifyEvent` 验过签的
   *                  `profile` 里那份，否则中间人可以塞自己的公钥换掉会话密钥。
   * @returns 成功与否。失败通常是包被篡改、或者发件人搞错了。
   */
  async accept(
    sessionId: string,
    senderId: string,
    senderPub: PublicIdentity,
    keyVersion: number,
    env: Envelope,
  ): Promise<boolean> {
    // 已经有更高版本的钥匙就不接受旧的。防止有人拿旧包把会话降级回去。
    const existing = this.keys.get(sessionId)
    if (existing && existing.version >= keyVersion) return false

    const theirPub = await importPublicX(senderPub.x)
    const key = await unwrapSessionKey(
      this.identity.xPrivate,
      theirPub,
      env,
      sessionId,
      senderId,
      this.selfId,
    )
    if (!key) return false

    // 收件人是我、发件人也是我 —— 这是**我自己包给自己的那一份**，
    // 也就是刷新之后认领回来的那把钥匙。必须把它记成 `mine: true`：
    // 否则「谁负责补包」这件事会在我身上失效（`wrapFor` 只认 `mine`），
    // 于是刷新过的人再也补不了包，晚登录的成员永远读不到群消息。
    const mine = senderId === this.selfId
    // 被顶掉的旧钥匙进 history，而不是直接丢掉。
    //
    // 换到新版本之后，用旧版本写出去的那些消息仍然是旧钥匙加密的 —— 不留下它，
    // 「收到更高版本的包」就等于「历史消息全部变空气泡」，于是需要轮换时谁都
    // 不愿意轮换（报告 M2）。留一份代价是每个会话多几把 AES key，很小。
    const history = existing ? new Map(existing.history) : new Map<number, CryptoKey>()
    if (existing) history.set(existing.version, existing.key)
    this.keys.set(sessionId, { version: keyVersion, key, history, mine, wrappedFor: new Set() })
    return true
  }

  /** 加解密用。明文进，信封出。没钥匙就返回 null（调用方决定是否明文发）。 */
  async encrypt(
    sessionId: string,
    authorId: string,
    seq: number,
    plaintext: string,
  ): Promise<Envelope | null> {
    const entry = this.keys.get(sessionId)
    if (!entry) return null
    return seal(entry.key, plaintext, messageAad(sessionId, entry.version, authorId, seq))
  }

  /** 失败一律返回 null —— GCM 校验不过会抛异常，这里统一吞成 null。 */
  async decrypt(
    sessionId: string,
    keyVersion: number,
    authorId: string,
    seq: number,
    env: Envelope,
  ): Promise<string | null> {
    const entry = this.keys.get(sessionId)
    if (!entry) return null
    // 按消息自带的 keyVersion 找**对应的那把**钥匙。
    //
    // 原来无视 keyVersion、一律拿当前那把试，于是「轮换」实际等于「历史消息
    // 全部变成空气泡」—— 这正是轮换这条路一直没人敢走的原因（报告 M2）。
    // 找不到对应版本时退回当前钥匙：新版本的密钥包可能还没同步过来，
    // 而对方已经用新钥匙把消息发出来了。
    const key =
      entry.version === keyVersion ? entry.key : (entry.history.get(keyVersion) ?? entry.key)
    return open(key, env, messageAad(sessionId, keyVersion, authorId, seq))
  }

  /** 会话被销毁 / 退出时清掉，免得钥匙越攒越多。 */
  forget(sessionId: string): void {
    this.keys.delete(sessionId)
  }

  forgetAll(): void {
    this.keys.clear()
  }

  /**
   * 供测试与调试：导出一把钥匙的原始字节。**生产路径永远不该调**。
   *
   * 它和 `installForTest` 是两个「只有测试需要、却住在生产模块里」的口子
   * （报告里点过）：只要能 import 到这个类，任何一行代码都能把会话密钥导成
   * base64 带走。它们没法简单删掉 —— `tools/crypto-selftest.ts` 要靠这两个方法
   * 模拟「已经协商好了」和「钥匙没变」。
   *
   * 折中是加一道**显式的测试开关**：没打开就抛错。这样误用是当场炸，
   * 而不是安静地把密钥交出去。测试在开头调一次 `enableTestHooks()`。
   */
  async exportKeyForTest(sessionId: string): Promise<string | null> {
    if (!testHooksEnabled) throw new Error(TEST_HOOKS_OFF)
    const entry = this.keys.get(sessionId)
    if (!entry) return null
    return exportAesKey(entry.key)
  }

  /** 供测试：直接塞一把已知钥匙，模拟「已经协商好了」。同样要 `enableTestHooks()`。 */
  async installForTest(sessionId: string, raw: string, version = 1, history?: Map<number, CryptoKey>): Promise<void> {
    if (!testHooksEnabled) throw new Error(TEST_HOOKS_OFF)
    this.keys.set(sessionId, {
      version,
      key: await importAesKey(raw),
      history: history ?? new Map(),
      mine: false,
      wrappedFor: new Set(),
    })
  }
}

/**
 * 测试钩子总开关，默认 **关**。
 *
 * 用模块级变量而不是构造函数参数：这些方法本来就只该被测试碰，
 * 而测试是直接 import 这个模块的 —— 参数化反而会让生产调用点顺手传个 `true`。
 */
let testHooksEnabled = false

const TEST_HOOKS_OFF =
  'exportKeyForTest / installForTest 是测试专用接口：先调 enableTestHooks() 打开，生产路径不该碰它们。'

/** 只有测试会调。生产代码调它等于自己把密钥出口打开。 */
export function enableTestHooks(): void {
  testHooksEnabled = true
}

/** 密钥包在网络上和落盘时的形状，base64 是为了塞进 JSON。 */
export function serializeKeyBundle(bundle: {
  keyVersion: number
  wrapped: Record<string, Envelope>
}): { keyVersion: number; wrapped: Record<string, string> } {
  const out: Record<string, string> = {}
  for (const [userId, env] of Object.entries(bundle.wrapped)) {
    out[userId] = serializeKeyEnvelope(env)
  }
  return { keyVersion: bundle.keyVersion, wrapped: out }
}

/**
 * 把一个信封变成可以塞进 JSON 的字符串。
 *
 * 用 base64 而不是直接 JSON 的原因：信封里有二进制（ct/iv 是原始字节），
 * 直接 JSON 化会先被 UTF-8 编码一次，遇到非法字节序列就会坏掉 ——
 * 而且是**概率性**的坏，本地小数据测不出来，线上大图片才炸。
 */
export function serializeKeyEnvelope(env: Envelope): string {
  return toB64(new TextEncoder().encode(JSON.stringify(env)))
}

export function deserializeKeyEnvelope(raw: string): Envelope | null {
  try {
    return JSON.parse(new TextDecoder().decode(fromB64(raw))) as Envelope
  } catch {
    return null
  }
}

/** 打印出来给人看的短签名，用于人工核对「对面那个人是不是真的」。 */
export { fingerprintOf, safetyNumber } from './keys'
export type { PublicIdentity, IdentityKeys } from './keys'

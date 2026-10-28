/**
 * P2P 传输层的端到端自测 —— 全程在内存里，不碰 Tauri、不开端口。
 *
 * `node.ts` 的测试验的是「事件有没有同步过去」；这里验的是**上层看到的
 * 东西对不对**：会话列表画出来是什么、消息有没有、撤回和表情有没有生效、
 * 文件到没到、好友是不是双向才算。换句话说：
 *
 *     node 测试问「字节到了吗」  →  transport 测试问「界面该显示什么」
 *
 * 两者中间隔着一层折叠 + 差集，而那正是最容易「逻辑没错但用户看到的不对」
 * 的地方 —— 所以这里断言的几乎全是**事件**，不是内部状态。
 *
 * 跑法：
 *   npx esbuild tools/p2p-transport-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=.tmp/p2p-transport.mjs
 *   node .tmp/p2p-transport.mjs
 */

import { exportPublic, generateIdentityKeys, importPublicX, type IdentityKeys } from '../src/crypto/keys'
import {
  CryptoSessionManager,
  deserializeKeyEnvelope,
  serializeKeyBundle,
  serializeKeyEnvelope,
} from '../src/crypto/session'
import { generateSessionKey, wrapSessionKey } from '../src/crypto/envelope'
import { identityOf, type UserId } from '../src/p2p/event'
import { MemoryBlobStore } from '../src/p2p/blob'
import { MemoryStore } from '../src/p2p/log'
import type { ChatEventMap, ChatEventName } from '../src/protocol/types'
import { directSessionId, P2pTransport } from '../src/transport/local'
import type { Bytes } from '../src/crypto/core'
import { check, report, section, FakeNetwork, FakeBridge } from './p2p-fake-net'

// ---------------------------------------------------------------- 台子

const peers: Peer[] = []

interface Recorded {
  name: ChatEventName
  payload: unknown
}

interface Peer {
  name: string
  id: UserId
  keys: IdentityKeys
  transport: P2pTransport
  bridge: FakeBridge
  blobs: MemoryBlobStore
  /** 收到的全部事件，按发生顺序。断言基本都在这上面做。 */
  events: Recorded[]
}

async function makePeer(network: FakeNetwork, name: string): Promise<Peer> {
  const keys = await generateIdentityKeys()
  const blobs = new MemoryBlobStore()
  const events: Recorded[] = []

  // 测试自己也算一遍 id，这样和传输层算出来的**独立**比一遍 ——
  // 如果哪天 `create()` 换了算法（比如退回用 40 位的短码），
  // 这里会先炸，而不是等到「有人能冒充别人」才发现。
  const id = await identityOf(await exportPublic(keys))

  const bridge = new FakeBridge(network, id, { name })
  const transport = await P2pTransport.create({
    keys,
    net: bridge,
    store: new MemoryStore(),
    blobs,
    info: { name },
    profile: { name },
  })

  const peer: Peer = { name, id, keys, transport, bridge, blobs, events }
  peers.push(peer)

  // 把所有事件记下来。这是本文件的主要观察面。
  const names: ChatEventName[] = [
    'connection:state',
    'message:new',
    'message:update',
    'message:recall',
    'session:update',
    'session:remove',
    'presence:update',
    'message:ack',
    'announcement',
    'announcements:update',
    'friends:update',
    'roster:update',
  ]
  for (const name of names) {
    transport.on(name, (payload: ChatEventMap[typeof name]) => {
      events.push({ name, payload })
    })
  }
  return peer
}

/** 把两个传输层都推到没事可做。 */
async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await Promise.all(peers.map((p) => p.transport.p2p.settled()))
  }
}

function of(peer: Peer, name: ChatEventName): unknown[] {
  return peer.events.filter((e) => e.name === name).map((e) => e.payload)
}

function lastOf<T>(peer: Peer, name: ChatEventName): T | undefined {
  const all = of(peer, name)
  return all[all.length - 1] as T | undefined
}

function bytes(text: string): Bytes {
  return new TextEncoder().encode(text) as Bytes
}

function textOf(b: Bytes): string {
  return new TextDecoder().decode(b)
}

function findSession(peer: Peer, id: string) {
  return peer.transport.p2p.getState().sessions.get(id)
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  // ============================================================= 连上
  section('传输层：两台机器互相发现并连上')

  const network = new FakeNetwork()
  const alice = await makePeer(network, '爱丽丝')
  const bob = await makePeer(network, '鲍勃')

  await alice.transport.connect()
  await bob.transport.connect()
  await network.link(alice.id, bob.id)
  await settle()

  check('爱丽丝连上了', alice.transport.state === 'connected')
  check('鲍勃连上了', bob.transport.state === 'connected')
  check(
    '传输层算出来的 id 和测试独立算的一致（换了算法这里会先炸）',
    alice.transport.p2p.getState().self === alice.id,
  )
  check('两边不是同一个人', alice.id !== bob.id)

  // 上层（chatStore）拿「我是谁」只能走 `transport.self`。以前它是
  // `loadConfig().selfId` —— 服务器时代的遗留，P2P 下是空串，于是界面把
  // 自己渲染成「未知用户 / ????」。这条断言盯着那条路不再被走回去。
  check('transport.self.id 就是本机 id', alice.transport.self.id === alice.id)
  check(
    'transport.self.number 是给人看的 8 位短码，不是占位符',
    /^[0-9A-Z]{8}$/.test(alice.transport.self.number),
    ` → ${alice.transport.self.number}`,
  )
  check(
    '两个人的短码不一样',
    alice.transport.self.number !== bob.transport.self.number,
  )
  check('transport.self 带着 isSelf 标记', alice.transport.self.isSelf === true)
  check(
    '名册里查得到自己（界面靠它显示名字与头像）',
    alice.transport
      .p2p
      .getState()
      .people.has(alice.id),
  )
  check(
    '爱丽丝看到鲍勃在线',
    alice.transport.p2p.listPeers().some((p) => p.id === bob.id && p.connected),
  )

  // ============================================================= 发消息
  section('传输层：建会话 + 发一条消息，对面收到的是界面能直接画的东西')

  const session = await alice.transport.createSession({
    name: '调试群',
    kind: 'group',
    memberIds: [bob.id],
  })
  await settle()

  check('会话 id 不是空的', session.id.length > 0)
  check('会话成员里有自己', session.memberIds.includes(alice.id))
  check('鲍勃那边也出现了这个会话', findSession(bob, session.id) !== undefined)

  // ================================================= 单聊 id + 没钥匙时的错误码
  section('传输层：单聊 id 两边算得一样，没钥匙时抛 no_bundle')

  // 新建会话对话框传的是 `[自己, 对方]`，好友流程传的是 `[对方]` —— 两种形状
  // 必须算出**同一个** id。曾经这里是 `directSessionId(self, memberIds[0])`，
  // 在第一种形状上算成 `d:自己:自己`，于是两边各建各的单聊、谁都收不到谁。
  const directA = await alice.transport.createSession({
    name: '',
    kind: 'direct',
    memberIds: [alice.id, bob.id],
  })
  const directB = await bob.transport.createSession({
    name: '',
    kind: 'direct',
    memberIds: [bob.id, alice.id],
  })
  check(
    '两种成员顺序算出同一个单聊 id',
    directA.id === directB.id,
    ` → ${directA.id} vs ${directB.id}`,
  )
  check(
    '单聊 id 是 directSessionId(自己, 对方)',
    directA.id === directSessionId(alice.id, bob.id),
    ` → ${directA.id}`,
  )
  check(
    '单聊 id 里没有自己和自己',
    !directA.id.includes(`${alice.id}:${alice.id}`),
    ` → ${directA.id}`,
  )

  // 日志里没有钥匙时必须抛 `code: 'no_bundle'`。上层（`chatStore.acceptKey`）
  // 按这个码分诊：「允许去新建一把钥匙」。丢了它就被当成「有钥匙但打不开」，
  // 于是永远不建钥 —— 没有 `key` 事件、消息**静默降级成明文**发出去。
  let keyFetchCode: string
  try {
    await alice.transport.keyFetch('s:从来没有过的会话')
    keyFetchCode = '（没抛错）'
  } catch (error) {
    keyFetchCode = (error as { code?: string }).code ?? '（无 code）'
  }
  check('没有钥匙时 keyFetch 抛 no_bundle', keyFetchCode === 'no_bundle', ` → ${keyFetchCode}`)

  bob.events.length = 0
  alice.events.length = 0

  const sent = await alice.transport.send({
    sessionId: session.id,
    kind: 'text',
    text: '下班了没',
    clientId: 'c1',
  })
  await settle()

  const bobsNew = of(bob, 'message:new') as { text?: string; authorId: string; sessionId: string }[]
  check('鲍勃收到了一条新消息', bobsNew.length === 1, ` → ${bobsNew.length}`)
  check('作者是爱丽丝', bobsNew[0]?.authorId === alice.id)
  check('正文没坏', bobsNew[0]?.text === '下班了没', ` → ${bobsNew[0]?.text}`)
  check('会话对得上', bobsNew[0]?.sessionId === session.id)

  // 自己发的那条也应该推给自己（同一个窗口要立刻看到）
  const aliceNew = of(alice, 'message:new') as { id: string }[]
  check('爱丽丝自己也收到了 message:new', aliceNew.length === 1)
  check('而且和 send() 返回的是同一条', aliceNew[0]?.id === sent.id)

  const acked = lastOf<{ clientId: string; message: { id: string } }>(alice, 'message:ack')
  check('乐观消息被对账掉了', acked?.clientId === 'c1')
  check('对账用的是正式 id，不是 clientId', acked?.message.id === sent.id)

  // ⚠ 这条是「界面不会闪出两条」的全部依据：ack 和 new 用的是同一个 id，
  // 而界面按正式 id 去重。如果哪天 ack 带的是 clientId，两边都会显示。
  check(
    '两个通道指向同一条消息（界面按 id 去重就不会重复）',
    acked?.message.id === aliceNew[0]?.id,
  )

  // ============================================================= 历史
  section('传输层：历史消息能翻页')

  for (let i = 2; i <= 6; i++) {
    await alice.transport.send({
      sessionId: session.id,
      kind: 'text',
      text: `第 ${i} 条`,
      clientId: `c${i}`,
    })
  }
  await settle()

  const recent = await bob.transport.history({ sessionId: session.id, limit: 3 })
  check('默认拉最近 3 条', recent.length === 3, ` → ${recent.length}`)
  check('最后一条是第 6 条', recent[recent.length - 1]?.text === '第 6 条')
  check('顺序是最旧在前', recent[0]?.text === '第 4 条')

  const older = await bob.transport.history({
    sessionId: session.id,
    before: recent[0].id,
    limit: 100,
  })
  check('往前翻拿到更早的', older.length === 3, ` → ${older.length}`)
  check('翻出来的确实都更早', older[older.length - 1]?.text === '第 3 条')

  // ============================================================= 撤回
  section('传输层：撤回')

  bob.events.length = 0
  await alice.transport.recall(session.id, sent.id)
  await settle()

  const recalls = of(bob, 'message:recall') as { messageId: string }[]
  check('鲍勃收到撤回通知', recalls.length === 1, ` → ${recalls.length}`)
  check('撤的是那一条', recalls[0]?.messageId === sent.id)
  const updated = of(bob, 'message:update') as { id: string; recalled?: boolean }[]
  check(
    '而且有配套的 update（撤回后正文要换成占位）',
    updated.some((m) => m.id === sent.id && m.recalled === true),
  )

  // ============================================================= 表情
  section('传输层：表情回应是幂等翻转')

  bob.events.length = 0
  await alice.transport.addReaction(session.id, sent.id, '👍')
  await settle()

  const withOne = (
    await alice.transport.history({ sessionId: session.id })
  ).find((m) => m.id === sent.id)
  check('加上了', withOne?.reactions?.[0]?.userIds.length === 1, ` → ${JSON.stringify(withOne?.reactions)}`)

  await alice.transport.addReaction(session.id, sent.id, '👍')
  await settle()

  const withNone = (
    await alice.transport.history({ sessionId: session.id })
  ).find((m) => m.id === sent.id)
  check('再点一次就取消了', (withNone?.reactions?.length ?? 0) === 0, ` → ${JSON.stringify(withNone?.reactions)}`)

  // ============================================================= 好友
  section('传输层：好友 —— 单向是 followers，双向才成好朋友并自动开单聊')

  bob.events.length = 0
  const oneWay = await alice.transport.pin(bob.id)
  await settle()

  check('单向的时候还不是好友', oneWay.mutual === false)
  check('单向的时候没有自动开单聊', oneWay.session === undefined)
  check('爱丽丝的 pins 里有鲍勃', oneWay.pins.includes(bob.id))
  const bobsFollowers = lastOf<{ followers: string[] }>(bob, 'friends:update')
  check(
    '鲍勃那边显示「有人想加你」',
    bobsFollowers?.followers.includes(alice.id) === true,
    ` → ${JSON.stringify(bobsFollowers?.followers)}`,
  )

  const twoWay = await bob.transport.pin(alice.id)
  await settle()

  check('双向之后是好友了', twoWay.mutual === true)
  check('friends 里有对方', twoWay.friends.includes(alice.id))

  const expected = directSessionId(alice.id, bob.id)
  check('自动开出来的单聊 id 是两边算出来的同一个', twoWay.session?.id === expected)

  // 两边都各自建过一次，但用的是同一个 id —— 所以只有一条。
  const aliceDirects = [...alice.transport.p2p.getState().sessions.values()].filter(
    (s) => s.kind === 'direct',
  )
  const bobDirects = [...bob.transport.p2p.getState().sessions.values()].filter(
    (s) => s.kind === 'direct',
  )
  check('爱丽丝那边只有一条单聊', aliceDirects.length === 1, ` → ${aliceDirects.length}`)
  check('鲍勃那边也只有一条', bobDirects.length === 1, ` → ${bobDirects.length}`)
  check(
    '而且两边是同一条',
    aliceDirects[0]?.id === bobDirects[0]?.id && aliceDirects[0]?.id === expected,
  )

  // ============================================================= 公告
  section('传输层：公告 —— 任何节点都能发，且带作者名')

  bob.events.length = 0
  await alice.transport.announce({ title: '今晚维护', body: '十点重启路由器' })
  await settle()

  const announcements = await new Promise<{ title: string; by: string }[]>((resolve) => {
    const latest = lastOf<{ title: string; by: string }[]>(bob, 'announcements:update')
    resolve(latest ?? [])
  })
  check('鲍勃收到了公告', announcements.length === 1, ` → ${announcements.length}`)
  check('标题对', announcements[0]?.title === '今晚维护')
  check(
    '带着作者名（不是匿名的系统通知）',
    announcements[0]?.by === '爱丽丝',
    ` → ${announcements[0]?.by}`,
  )

  // ============================================================= 文件
  section('传输层：文件 —— 声明进日志，字节直接推')

  bob.events.length = 0
  alice.events.length = 0
  const payload = bytes('这是一份很短的附件')
  await alice.transport.sendFile({
    sessionId: session.id,
    bytes: payload,
    name: 'readme.txt',
    mime: 'text/plain',
    clientId: 'f1',
  })
  await settle()

  // ★ 发文件的人必须也拿到 ack —— 不是「有就发、没有就算了」。
  //
  // 原实现是 `const parsed = state.messages.get(event.id); if (parsed) { …
  // emit('message:ack', …) }`，**没有 else**。而 `publish` 之后折叠还没跑
  // （`scheduleRefold` 是排队的），所以 `parsed` 恰好就是空的 —— 于是
  // 既不 ack 也不报错，界面上那条乐观消息永远停在「传输中…」。更糟的是
  // 「重发」只对 `failed` 渲染（见 `MessageRow.tsx`），所以用户连手动救一下
  // 的机会都没有，只能重开会话。
  const fileAck = lastOf<{ clientId: string; message: { fileId?: string } }>(alice, 'message:ack')
  check('★ 发文件的人也拿到 ack', fileAck?.clientId === 'f1', ` → ${JSON.stringify(fileAck)}`)
  check('★ ack 里带着 fileId', Boolean(fileAck?.message?.fileId), ` → ${JSON.stringify(fileAck)}`)

  {
    // ★ 折叠还没把这条 file 事件变成消息时，也必须回 ack。
    //
    // 这是那个 `if (parsed)` 没有 else 时**唯一真正走得到**的分支：
    // `publish()` 是同步 `refold()` 的（见 `node.ts`），所以只要折叠认可
    // 这条事件，`parsed` 就一定在。反过来说，`parsed` 为空只可能是折叠
    // **不认**它 —— 最典型的就是会话定义还没同步到我这儿：没有会话就没有
    // 成员表，`foldMessage` 会把作者不是成员的消息丢掉。
    //
    // 原来的代码在这里什么都不做：不发 ack、不报错，界面上那条乐观消息
    // 永远停在「传输中…」，而「重发」只对 failed 渲染 —— 只能重开会话。
    alice.events.length = 0
    await alice.transport.sendFile({
      sessionId: 's:没人知道的会话' as typeof session.id,
      bytes: bytes('孤儿附件'),
      name: 'orphan.txt',
      mime: 'text/plain',
      clientId: 'f-orphan',
    })
    await settle()
    const orphanAck = lastOf<{ clientId: string }>(alice, 'message:ack')
    check(
      '★ 折叠不认这条事件时也要回 ack（别让气泡永远转圈）',
      orphanAck?.clientId === 'f-orphan',
      ` → ${JSON.stringify(orphanAck)}`,
    )
  }

  const fileMsgs = (await bob.transport.history({ sessionId: session.id })).filter(
    (m) => m.fileId,
  )
  check('鲍勃收到了文件消息', fileMsgs.length === 1, ` → ${fileMsgs.length}`)
  check('文件名对', fileMsgs[0]?.fileName === 'readme.txt')
  check('大小对', fileMsgs[0]?.fileSize === payload.length)
  check(
    '字节到了，所以 fileUrl 有值',
    typeof fileMsgs[0]?.fileUrl === 'string' && fileMsgs[0]!.fileUrl!.startsWith('data:text/plain'),
    ` → ${fileMsgs[0]?.fileUrl?.slice(0, 40)}`,
  )

  const gotBytes = fileMsgs[0]?.fileId ? bob.transport.blobOf(fileMsgs[0].fileId) : undefined
  check('拿出来的内容一致', gotBytes ? textOf(gotBytes) === '这是一份很短的附件' : false)

  // 不假设「字节一定比声明后到」：局域网上两种顺序都会出现。
  // 真正该成立的是**最终界面拿得到带地址的那一条** —— 声明先到时靠
  // `onBlob` 补一条 update，字节先到时 message:new 本身就带着地址。
  const announced = [...of(bob, 'message:new'), ...of(bob, 'message:update')] as {
    fileId?: string
    fileUrl?: string
  }[]
  const forThisFile = announced.filter((m) => m.fileId === fileMsgs[0]?.fileId)
  check('这个文件被推给了界面', forThisFile.length >= 1, ` → ${forThisFile.length}`)
  check(
    '而且至少有一条带着可用地址',
    forThisFile.some((m) => Boolean(m.fileUrl)),
    ` → ${forThisFile.map((m) => (m.fileUrl ? '有' : '无')).join(',')}`,
  )
  check(
    '自己发的那条本地立刻就能显示',
    (await alice.transport.history({ sessionId: session.id }))
      .filter((m) => m.fileId)
      .every((m) => Boolean(m.fileUrl)),
  )

  // ============================================================= 离线
  section('传输层：断线期间的消息，重连后补上')

  network.unlink(alice.id, bob.id)
  await settle()
  check('鲍勃发现自己掉线了', bob.transport.p2p.listPeers().every((p) => !p.connected || p.id !== alice.id))

  const offlineCount = (await alice.transport.history({ sessionId: session.id })).length
  for (let i = 0; i < 3; i++) {
    await alice.transport.send({
      sessionId: session.id,
      kind: 'text',
      text: `断线期间 ${i}`,
      clientId: `off${i}`,
    })
  }
  await settle()

  const beforeReconnect = (await bob.transport.history({ sessionId: session.id })).length
  check('鲍勃此刻还没有这三条', beforeReconnect === offlineCount, ` → ${beforeReconnect}/${offlineCount}`)

  bob.events.length = 0
  await network.link(alice.id, bob.id)
  await settle(6)

  const afterReconnect = (await bob.transport.history({ sessionId: session.id })).length
  check(
    '重连后三条一条不少',
    afterReconnect === offlineCount + 3,
    ` → ${afterReconnect}`,
  )
  const texts = (await bob.transport.history({ sessionId: session.id })).map((m) => m.text)
  check('内容也对', texts.includes('断线期间 2'), ` → ${texts.slice(-4).join(' / ')}`)
  check(
    '补上来的走的是 message:new（界面会正常显示，不用刷新）',
    (of(bob, 'message:new') as { text?: string }[]).filter((m) => m.text?.startsWith('断线期间'))
      .length === 3,
  )

  // ============================================================= 在线状态
  section('传输层：在线状态跟着链路走')

  const presence = of(bob, 'presence:update') as { userId: string; online: boolean }[]
  check('重连推了「在线」', presence.some((p) => p.userId === alice.id && p.online === true))

  bob.events.length = 0
  network.unlink(alice.id, bob.id)
  await settle()
  const gone = of(bob, 'presence:update') as { userId: string; online: boolean }[]
  check(
    '断线推了「离线」',
    gone.some((p) => p.userId === alice.id && p.online === false),
    ` → ${JSON.stringify(gone)}`,
  )

  // ============================================================= 名册
  section('传输层：名册 —— 名字是从事件里来的')

  const roster = bob.transport.p2p.getState().people
  check('鲍勃的名册里有爱丽丝', roster.has(alice.id))
  check('而且名字是「爱丽丝」', roster.get(alice.id)?.name === '爱丽丝', ` → ${roster.get(alice.id)?.name}`)
  check('自己也在名册里，标着 isSelf', roster.get(bob.id)?.isSelf === true)
  check(
    '名字没设过的人退回编号显示（不编一个假的）',
    roster.get(alice.id)?.name !== '' || roster.get(alice.id)?.number !== '',
  )

  // ============================================================= 端到端加密
  section('传输层：端到端加密 —— 明文不上线')

  // 密钥包必须走**真实链路**发过去，不能在这两个 manager 之间直接传对象：
  // 直接传的话，验的是「加密算法对不对」，而这件事 `crypto-selftest` 已经验过。
  // 这里要验的是另一件事 —— 换到 P2P 这条路上，钥匙还到不到得了、密文还开不开。
  // 上一节把链路拔掉验「离线」了；密钥包是要**发过去**的，先把线接回来。
  // （这也顺带说明了一件事：密钥包和消息走的是同一条同步路径，
  //   离线时发的钥匙，等对方上线照样会补上。）
  await network.link(alice.id, bob.id)
  await settle()

  const aMgr = new CryptoSessionManager(alice.keys, alice.id)
  const bMgr = new CryptoSessionManager(bob.keys, bob.id)
  const alicePub = await exportPublic(alice.keys)
  const bobPub = await exportPublic(bob.keys)

  const made = await aMgr.createFor(session.id, [{ id: bob.id, ...bobPub }])
  check('造钥匙的人给收件人也包了一份', Object.keys(made.wrapped).includes(bob.id))
  check('也给自己留了一份（换设备后才认得回这把钥匙）', Object.keys(made.wrapped).includes(alice.id))

  const wireBundle = serializeKeyBundle({ keyVersion: made.keyVersion, wrapped: made.wrapped })
  await alice.transport.keyPublish(session.id, wireBundle.keyVersion, wireBundle.wrapped)
  await settle()

  const fetched = await bob.transport.keyFetch(session.id)
  check('鲍勃从链路上取到了给自己的那一份', fetched.env.length > 0)
  check('发件人是爱丽丝', fetched.senderId === alice.id)

  const envForBob = deserializeKeyEnvelope(fetched.env)
  check('信封解得开（是个结构，不是坏字符串）', envForBob !== null)
  const claimed = await bMgr.accept(
    session.id,
    fetched.senderId,
    alicePub,
    fetched.keyVersion,
    envForBob!,
  )
  check('鲍勃认领成功（只有他的 X25519 私钥能开）', claimed)

  // 第三方捡到同一个信封也开不了 —— AAD 绑了 (发件人, 收件人)。
  const eveKeys = await generateIdentityKeys()
  const eveId = await identityOf(await exportPublic(eveKeys))
  const eve = new CryptoSessionManager(eveKeys, eveId)
  const stolen = await eve.accept(session.id, fetched.senderId, alicePub, fetched.keyVersion, envForBob!)
  check('路过的人捡到这个密钥包也开不了', stolen === false)

  // ---------------------------------------------------------------
  // 密钥包投毒：版本更高的假包能不能把真包挤掉？
  //
  // `keyFetch` 取的是**全日志里版本最高的那一份**，不看过发件人是谁
  // （`local.ts` 的循环里只有 `version > best.keyVersion`）。
  // 而 `key` 事件要进日志只要求签名有效 —— `log.ts` 的 `ingest` 不查会话成员，
  // `fold.ts` 里**根本没有 `key` 这个分支**，所以没人拦它。
  // 于是局域网里任何一个对端，只要换过 profile、知道会话 id（单聊的 id
  // 就是两个人公钥哈希拼出来的，公开可算），就能往别人的日志里塞一条
  // `keyVersion: 99` 的包。
  //
  // 它开不开得开不重要 —— 信封是对**鲍勃的公钥**封的，鲍勃当然打得开。
  // 要紧的是它把真包挤下去了：`acceptKey` 一看发件人不是建钥人就整条拒收，
  // 于是鲍勃永远拿不到钥匙，而 `chatStore` 在拿不到钥匙时**照发不误**
  // （`chatStore.ts` 的 `if (envelope) {...} else { void ensureSessionKey }`），
  // 消息就这么静默降级成明文出了局域网。
  // ---------------------------------------------------------------
  const pestKeys = await generateIdentityKeys()
  const pestPub = await exportPublic(pestKeys)
  const pestId = await identityOf(pestPub)
  const pestBridge = new FakeBridge(network, pestId, { name: '捣乱的人' })
  const pest = await P2pTransport.create({
    keys: pestKeys,
    net: pestBridge,
    store: new MemoryStore(),
    blobs: new MemoryBlobStore(),
    info: { name: '捣乱的人' },
    profile: { name: '捣乱的人' },
  })
  await pest.connect()
  await network.link(pestId, bob.id)
  await settle()

  const junk = await generateSessionKey()
  const poison = await wrapSessionKey(
    pestKeys.xPrivate,
    await importPublicX(bobPub.x),
    junk,
    session.id,
    pestId,
    bob.id,
  )
  await pest.keyPublish(session.id, 99, { [bob.id]: serializeKeyEnvelope(poison) })
  await settle()

  const afterPoison = await bob.transport.keyFetch(session.id)
  check(
    '版本更高的假密钥包挤不掉真包',
    afterPoison.senderId === alice.id,
    ` → 取到的是 ${afterPoison.senderId === pestId ? '捣乱的人' : afterPoison.senderId} 的包，版本 ${afterPoison.keyVersion}`,
  )
  check('挤不掉之后取回来的还是能开的那一份', deserializeKeyEnvelope(afterPoison.env) !== null)

  // ---- 第二层：建钥人**一个包都还没发**的时候，陌生人也不能顶上 ----
  //
  // 上面那条测的是「建钥人发过包」的情形 —— 那时光靠「只认建钥人」就挡得住，
  // 成员名单那道检查是多余的。这一条测的是它的**唯一**作用场景：名单里的
  // 人谁都没发，此时取包会退到「别的成员发的」那一档；陌生人必须两档都进不去。
  const fresh = await alice.transport.createSession({
    name: '',
    kind: 'direct',
    memberIds: [alice.id, bob.id],
  })
  await settle()
  await pest.keyPublish(fresh.id, 99, { [bob.id]: serializeKeyEnvelope(poison) })
  await settle()

  let freshErr: unknown = null
  try {
    await bob.transport.keyFetch(fresh.id)
  } catch (err) {
    freshErr = err
  }
  check(
    '建钥人还没发包时，陌生人的包也顶不上（取不到就是取不到）',
    (freshErr as { code?: string } | null)?.code === 'no_bundle',
    ` → ${freshErr ? JSON.stringify(freshErr) : '竟然取到了陌生人的包'}`,
  )

  await network.unlink(pestId, bob.id)
  await settle()

  bob.events.length = 0
  // `bridge.wire` **故意不清**：密钥包也是要验的「什么东西过了线」，
  // 清掉它就得另存一份快照，而这个测试的全部意义就是「看真实字节」。

  // 明文选一句**不可能碰巧出现在密文里**的话，否则下面的「没漏出去」是假绿。
  const secret = '口令是-开口的椰子-7391'
  const sealed = await aMgr.encrypt(session.id, alice.id, 1, secret)
  check('要发的这句话封成了信封', sealed !== null)

  const sealedSent = await alice.transport.send({
    sessionId: session.id,
    kind: 'text',
    cipher: serializeKeyEnvelope(sealed!),
    cipherVersion: 1,
    cipherSeq: 1,
    clientId: 'sealed-1',
  })
  await settle()
  check('send() 回来了一个正式 id', sealedSent.id.length > 0)

  const got = (
    of(bob, 'message:new') as {
      id: string
      text?: string
      cipher?: string
      cipherVersion?: number
      cipherSeq?: number
      sentAt?: number
    }[]
  )[0]
  check('鲍勃收到了一条消息', got !== undefined)
  check('它带着密文', typeof got?.cipher === 'string' && got.cipher.length > 0)
  check('它**没有**明文（传输层不替上层解密，也不凭空填 text）', !got?.text)
  check('版本与序号原样带过来了（它们参与 AAD，错一个就开不了）', got?.cipherVersion === 1 && got?.cipherSeq === 1)

  // ★ 这条是「时间戳显示成公元 58761 年」那个 bug 的回归守卫。
  //
  // 事件里的 `ts` 是编码过的 HLC（毫秒 × 1000 + 序号），而 `Message.sentAt`
  // 必须是毫秒 —— 两个数差 1000 倍，当年 fold 里就是直接写的 `sentAt: event.ts`。
  // 它不会在这一层爆：断言全绿、消息照收，坏在界面上（每条消息的时钟都不对、
  // 日期分隔线每 86 秒冒一条、5 分钟分组永远不生效）。所以判据只能看
  // 「这个数**像不像**一个当前时间」。
  check(
    '★ 消息的 sentAt 是毫秒时间戳（不是 HLC 编码值）',
    typeof got?.sentAt === 'number' && Math.abs(got.sentAt - Date.now()) < 24 * 60 * 60 * 1000,
    ` → ${got?.sentAt}（编码值会是它的 1000 倍）`,
  )

  const envGot = got?.cipher ? deserializeKeyEnvelope(got.cipher) : null
  const plain = envGot
    ? await bMgr.decrypt(session.id, got!.cipherVersion ?? 1, alice.id, got!.cipherSeq ?? 1, envGot)
    : null
  check('鲍勃解出来的就是原话', plain === secret, ` → ${plain}`)

  // 反证：换个人来解，必须解不开。
  const evePlain = envGot
    ? await eve.decrypt(session.id, got!.cipherVersion ?? 1, alice.id, got!.cipherSeq ?? 1, envGot)
    : null
  check('没有钥匙的人解出来是 null', evePlain === null)

  // ------------------------------------------------- 网线上到底跑的什么
  // 上面所有断言加起来仍然可能在一个「两台机器共用一把钥匙」的实现下全绿，
  // 所以必须直接看**过线的字节**。
  const crossed = [...alice.bridge.wire, ...bob.bridge.wire].map((f) => textOf(f.data as Bytes))
  check('确实有线过（不然下面那条是假绿）', crossed.length > 0, ` → ${crossed.length} 条`)

  const leaked = crossed.filter((t) => t.includes(secret))
  check('明文没有出现在任何一条过线的字节里', leaked.length === 0, ` → 泄漏 ${leaked.length} 条`)

  const carried = got?.cipher ? crossed.filter((t) => t.includes(got.cipher!.slice(0, 32))) : []
  check('密文反倒确实从链路上走过', carried.length > 0)

  // 密钥包本身也是信封；它过线了，但只有收件人开得了。
  check(
    '密钥包也是以密文形式过线的（没有裸着传钥匙）',
    crossed.some((t) => t.includes(fetched.env.slice(0, 32))),
  )

  // 这个测试**故意不调** enableTestHooks()：它就是来证明那两个测试专用口子
  // 默认是关着的。只要有谁在生产路径上顺手调 exportKeyForTest，这里会先红。
  let gateClosed = false
  try {
    await bMgr.exportKeyForTest(session.id)
  } catch (err) {
    gateClosed = err instanceof Error && err.message.includes('测试专用接口')
  }
  check('没打开测试开关时，导出密钥字节会被拒绝', gateClosed)

  report()
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

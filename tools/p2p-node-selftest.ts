/**
 * P2P 节点的端到端自测 —— 全程在内存里，不碰 Tauri、不开端口。
 *
 * 这里验的是 `node.ts` 把「日志 / 同步协议 / 传输层」缝在一起之后，
 * 那几件在单模块测试里验不到的事：
 *   · 两个节点连上之后**真的**会互相同步
 *   · 断开期间产生的事件，重连后真的会补上（离线消息）
 *   · A 同时认识 B 和 C、而 B 与 C 互不相识时，A 不被「B 的进度」带偏
 *   · 重复投递不会产生重复
 *   · 伪造签名的事件进不来
 *   · 上千条事件会分帧，一条不丢
 *
 * 跑法：
 *   npx esbuild tools/p2p-node-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=.tmp/p2p-node.mjs
 *   node .tmp/p2p-node.mjs
 */

import { EventLog, MemoryStore } from '../src/p2p/log'
import { HybridClock } from '../src/p2p/hlc'
import { P2pNode } from '../src/p2p/node'
import { identityOf, signEvent, type P2pEvent, type UserId } from '../src/p2p/event'
import { generateIdentityKeys, exportPublic, type IdentityKeys, type PublicIdentity } from '../src/crypto/keys'
import { messagesOf } from '../src/p2p/fold'
import { MemoryBlobStore, blobIdOf, encodeBlob } from '../src/p2p/blob'
import { encodeFrame, decodeFrame } from '../src/p2p/wire'
import type { Bytes } from '../src/crypto/core'

import { check, report, FakeNetwork, FakeBridge } from './p2p-fake-net'
/**
 * 把两个节点都推到「没事可做了」。
 *
 * 不能靠「等若干轮 setImmediate」—— 一次 1100 条事件的同步要验 1100 个
 * 签名，那是秒级的活，固定轮数会提前返回然后断言读到中间状态（第一版
 * 就是这么写，于是同步只落下 8 条却看不出为什么）。改成问节点自己：
 * 队列排空、折叠追上，才算完。
 */
const allNodes: Node[] = []

async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await Promise.all(allNodes.map((n) => n.node.settled()))
  }
}

// ---------------------------------------------------------------- 搭台子

interface Node {
  name: string
  id: UserId
  keys: IdentityKeys
  pub: PublicIdentity
  log: EventLog
  clock: HybridClock
  bridge: FakeBridge
  node: P2pNode
  blobs: MemoryBlobStore
  problems: string[]
}

async function makeNode(
  network: FakeNetwork,
  name: string,
  options: { syncRate?: { bucket?: number; refillMs?: number; now?: () => number } } = {},
): Promise<Node> {
  const keys = await generateIdentityKeys()
  const pub = await exportPublic(keys)
  const id = await identityOf(pub)
  const log = new EventLog(new MemoryStore())
  const clock = new HybridClock()
  const bridge = new FakeBridge(network, id, { name })
  const problems: string[] = []
  const blobs = new MemoryBlobStore()
  const node = new P2pNode({
    keys,
    selfId: id,
    log,
    clock,
    net: bridge,
    info: { name },
    blobs,
    onProblem: (text) => problems.push(text),
    ...options,
  })
  network.register(bridge)
  await node.start()
  const made = { name, id, keys, pub, log, clock, bridge, node, blobs, problems }
  allNodes.push(made)
  return made
}

/** 让对方的名字先到 —— 名字是事件，不是发现信标。 */
async function introduce(who: Node): Promise<void> {
  await who.node.publish('profile', { name: who.name, ed: who.pub.ed, x: who.pub.x })
}

/**
 * 让两个人互相认识，并开一个单聊会话。
 *
 * 会话**必须**显式建：`foldMessage` 里 `state.sessions.get(sessionId)` 拿不到
 * 会话就把消息丢掉（事件仍在日志里，等会话定义到了下一轮折叠会补上）。
 * 这是刻意的 —— 否则任何人都能凭一条消息把陌生人塞进你的会话列表。
 * 所以「发消息」之前一定要先有「建会话」。
 */
async function meet(a: Node, b: Node): Promise<string> {
  await introduce(a)
  await introduce(b)
  const id = direct(a.id, b.id)
  await a.node.publish('session', { id, kind: 'direct', memberIds: [a.id, b.id].sort() })
  return id
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  console.log('=== 节点：连上就同步 ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')

    await introduce(alice)
    await introduce(bob)
    check('握手之前互相不知道名字', !alice.node.getState().people.has(bob.id))

    await network.link(alice.id, bob.id)
    await settle()

    check('爱丽丝拿到了鲍勃的名字', alice.node.getState().people.get(bob.id)?.name === '鲍勃')
    check('鲍勃拿到了爱丽丝的名字', bob.node.getState().people.get(alice.id)?.name === '爱丽丝')
    check('两边日志条数一致', alice.log.size() === bob.log.size(), ` → ${alice.log.size()} / ${bob.log.size()}`)
    check('双方都认为对方在线', alice.node.status().linked === 1 && bob.node.status().linked === 1)
  }

  console.log('\n=== 节点：连上之后发的消息 ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')
    await network.link(alice.id, bob.id)
    await settle()

    const session = await meet(alice, bob)
    const published = await alice.node.publish('msg', { sessionId: session, cipher: '在吗' })
    await settle()

    const bobSees = messagesOf(bob.node.getState(), session)
    check('鲍勃收到了那条消息', bobSees.length === 1)
    check('内容一致', bobSees[0]?.cipher === '在吗', ` → ${JSON.stringify(bobSees[0]?.cipher)}`)
    check('作者是爱丽丝', bobSees[0]?.authorId === alice.id)
    // 这里原来断的是 `pending !== true`。`P2pMessage` 上**没有** `pending`
    // 这个字段 —— 它是 1.x 的乐观消息标记（先画出来、等服务器回执确认），
    // 所以那条断言恒真、从来没可能失败。P2P 里没有这个中间态：消息必须由
    // 一条验过签名的事件折叠出来才算存在，于是改断**同一性** ——
    // 鲍勃看到的就是爱丽丝发的那一条，不是一条本地占位的回声。
    check(
      '鲍勃看到的和爱丽丝发的是同一条（不是本地占位）',
      bobSees[0]?.id === published.id,
      ` → ${bobSees[0]?.id} vs ${published.id}`,
    )
  }

  console.log('\n=== 节点：断开期间的离线消息 ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')
    await network.link(alice.id, bob.id)
    await settle()
    const session = await meet(alice, bob)
    await settle()

    const before = bob.log.size()

    network.unlink(alice.id, bob.id)
    await settle()
    check('断开后双方都知道对方离线', alice.node.status().linked === 0)

    // 爱丽丝在鲍勃不在线时连发几条。
    for (const text of ['第一条', '第二条', '第三条']) {
      await alice.node.publish('msg', { sessionId: session, cipher: text })
    }
    await settle()
    check('离线期间鲍勃一条没收到', bob.log.size() === before, ` → ${bob.log.size()}`)
    check('离线发送不抛错', alice.problems.every((p) => !p.includes('重新同步失败')))

    await network.link(alice.id, bob.id)
    await settle()

    const texts = messagesOf(bob.node.getState(), session).map((m) => m.cipher)
    check(
      '重连后三条离线消息全部补上',
      texts.join(',') === '第一条,第二条,第三条',
      ` → ${texts.join(',')}`,
    )
  }

  console.log('\n=== 节点：A 认识 B 和 C，B 与 C 互不相识 ===')

  {
    // 这是「游标同步」会丢消息的那个拓扑。用 id 集合就不会。
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')
    const carol = await makeNode(network, '卡罗尔')

    // 只有爱丽丝同时见过两个人。
    await network.link(alice.id, bob.id)
    await settle()
    await network.link(alice.id, carol.id)
    await settle()

    await introduce(alice)
    await introduce(bob)
    await introduce(carol)
    await alice.node.publish('session', {
      id: direct(alice.id, bob.id),
      kind: 'direct',
      memberIds: [alice.id, bob.id].sort(),
    })
    await alice.node.publish('session', {
      id: direct(alice.id, carol.id),
      kind: 'direct',
      memberIds: [alice.id, carol.id].sort(),
    })
    await settle()

    // B 和 C 各发一批，彼此完全不知情。爱丽丝两边都在收。
    for (const n of [1, 2, 3]) {
      await bob.node.publish('msg', { sessionId: direct(bob.id, alice.id), cipher: `B${n}` })
    }
    for (const n of [1, 2, 3]) {
      await carol.node.publish('msg', { sessionId: direct(carol.id, alice.id), cipher: `C${n}` })
    }
    await settle()

    const aliceTexts = [
      ...messagesOf(alice.node.getState(), direct(bob.id, alice.id)).map((m) => m.cipher),
      ...messagesOf(alice.node.getState(), direct(carol.id, alice.id)).map((m) => m.cipher),
    ].sort()

    check(
      '爱丽丝同时拿到了 B 和 C 的全部',
      aliceTexts.join(',') === ['B1', 'B2', 'B3', 'C1', 'C2', 'C3'].join(','),
      ` → ${aliceTexts.join(',')}`,
    )

    // B 和 C 之间没有链路，所以 B 看不见 C 的消息 —— 这是**故意的**。
    //
    // 收到的事件不会再转发给别人：转发会让每条事件在网络里走 N 遍，
    // 而且「A 把 B 的私人消息转给 C」在信任上是说不清的。局域网里
    // 组播发现本来就会让所有人互相连上（一张全连通图），转发只是在
    // 补偿「连不上」这种少数情况，不值得用它换掉上面两个代价。
    const bobSeesCarol = messagesOf(bob.node.getState(), direct(carol.id, alice.id)).length
    check('B 看不见 C 的消息（不转发）', bobSeesCarol === 0, ` → ${bobSeesCarol}`)

    // 但 C 的消息确实已经到了爱丽丝手里，所以 B 一旦和 C 连上就立刻补齐。
    await network.link(bob.id, carol.id)
    await settle(300)
    const bobSeesCarolAfter = messagesOf(bob.node.getState(), direct(carol.id, alice.id)).length
    check('B 和 C 连上之后立刻看到彼此的全部', bobSeesCarolAfter === 3, ` → ${bobSeesCarolAfter}`)
    check('三人日志条数一致', alice.log.size() === bob.log.size() && bob.log.size() === carol.log.size(),
      ` → ${alice.log.size()}/${bob.log.size()}/${carol.log.size()}`)
  }

  console.log('\n=== 节点：重复投递与伪造 ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')
    await network.link(alice.id, bob.id)
    await settle()
    const session = await meet(alice, bob)
    await settle()

    const event = await alice.node.publish('msg', { sessionId: session, cipher: '只应出现一次' })
    await settle()
    const after = bob.log.size()

    // 同一条再投三次。
    for (let i = 0; i < 3; i++) {
      await bob.log.ingest(event)
    }
    check('重复投递不会增加条数', bob.log.size() === after, ` → ${bob.log.size()}`)

    // 伪造：payload 声称 author 是爱丽丝，但用别人的私钥签。
    const mallory = await generateIdentityKeys()
    const forged = await signEvent(mallory, {
      author: alice.id,
      ts: alice.clock.peek() + 5,
      kind: 'msg',
      body: { sessionId: session, cipher: '我是爱丽丝，给我转账' },
    })
    const result = await bob.log.ingest(forged)
    check('冒名签的事件被拒（bad-sig）', result === 'bad-sig', ` → ${result}`)

    // 改内容：id 是内容算出来的，改了就对不上。
    //
    // 两个坑：① 要用**鲍勃还没见过**的事件 —— 拿已经收到过的那条改，
    // 日志会因为「这个 id 我有了」先返回 duplicate，测的就成了去重；
    // ② 所以先断开，让这条新事件不要经正常同步送到鲍勃手里。
    network.unlink(alice.id, bob.id)
    await settle(50)
    const fresh = await alice.node.publish('msg', { sessionId: session, cipher: '还没同步给鲍勃' })
    const tampered: P2pEvent = { ...fresh, body: { ...(fresh.body as object), cipher: '被改过了' } }
    const result2 = await bob.log.ingest(tampered)
    check('改过内容的事件被拒（bad-id）', result2 === 'bad-id', ` → ${result2}`)

    check('被拒之后日志没变', bob.log.size() === after)
  }

  console.log('\n=== 节点：上千条事件的分帧同步 ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')
    const session = await meet(alice, bob)
    const total = 1100
    for (let i = 0; i < total; i++) {
      await alice.node.publish('msg', { sessionId: session, cipher: `第${i}条` })
    }
    check('本地攒了足够多的事件', alice.log.size() === total + 2, ` → ${alice.log.size()}`)

    // 还没连上，所以 Bob 这边是空的。
    await network.link(alice.id, bob.id)
    await settle(600)

    check('一条不少地同步过去了', bob.log.size() === alice.log.size(), ` → ${bob.log.size()} / ${alice.log.size()}`)
    const bobTexts = messagesOf(bob.node.getState(), session)
    check('鲍勃能看到全部消息', bobTexts.length === total, ` → ${bobTexts.length}`)

    // 分帧：爱丽丝**发出去**的帧应该有好几帧（每帧 512 条封顶）。
    // 注意看的是 `sent` 不是 `received` —— received 是鲍勃发给她的。
    const sizes = alice.bridge.sent.map((r) => r.bytes)
    check('确实分成了多帧', sizes.length >= 3, ` → ${sizes.length} 帧`)
    check('单帧不超过 64MB', sizes.every((n) => n < 64 * 1024 * 1024))

    // 幂等：再同步一次不会翻倍。
    await network.unlink(alice.id, bob.id)
    await settle(50)
    await network.link(alice.id, bob.id)
    await settle(400)
    check('再次同步不会产生重复', bob.log.size() === alice.log.size(), ` → ${bob.log.size()} / ${alice.log.size()}`)
  }

  console.log('\n=== 节点：对方离线时的直接发送 ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')

    const session = await meet(alice, bob)
    await alice.node.publish('msg', { sessionId: session, cipher: '你还没上线' })
    await settle()
    check('发给从没连过的人不抛错', alice.problems.length === 0, ` → ${alice.problems.join('|')}`)

    await network.link(alice.id, bob.id)
    await settle()
    check('他上线之后收到了', messagesOf(bob.node.getState(), direct(alice.id, bob.id)).length === 1)
  }

  console.log('\n=== 节点：文件（在线直发） ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')

    const session = await meet(alice, bob)
    await network.link(alice.id, bob.id)
    await settle(6)
    check('文件和字节之前，会话已经两边都有', bob.node.getState().sessions.has(session))
    const content = new TextEncoder().encode('这是一份文件的内容，装作它很大')

    const id = await alice.node.shareBlob(content as Bytes, '合同.txt', 'text/plain', [bob.id])
    check('共享文件拿到了内容 id', typeof id === 'string' && id.length > 20)
    check('自己手上也有了', alice.blobs.has(id!))

    // 声明走日志：内容 id 进事件，字节不走日志。
    await alice.node.publish('file', {
      sessionId: session,
      fileId: id,
      name: '合同.txt',
      mime: 'text/plain',
      size: content.length,
    })
    await settle()

    check('鲍勃收到了文件声明', messagesOf(bob.node.getState(), direct(alice.id, bob.id)).length === 1)
    const got = bob.blobs.get(id!)
    check('鲍勃拿到了字节', got !== undefined)
    check('字节内容一致', got ? new TextDecoder().decode(got) === '这是一份文件的内容，装作它很大' : false)
    check('名字跟着过来了', bob.blobs.meta(id!)?.name === '合同.txt')
  }

  console.log('\n=== 节点：文件（对方离线时发的） ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')

    // 先互相认识、建会话，然后**断开**。
    await network.link(alice.id, bob.id)
    await introduce(alice)
    await introduce(bob)
    await settle()
    const session = direct(alice.id, bob.id)
    await alice.node.publish('session', {
      id: session,
      kind: 'direct',
      name: '',
      memberIds: [alice.id, bob.id],
    })
    await settle()

    await network.unlink(alice.id, bob.id)
    await settle()

    // 鲍勃不在线时发一个文件。
    const content = new TextEncoder().encode('离线期间发的图')
    const id = await alice.node.shareBlob(content as Bytes, '离线.png', 'image/png', [bob.id])
    await alice.node.publish('file', {
      sessionId: session,
      fileId: id,
      name: '离线.png',
      mime: 'image/png',
      size: content.length,
    })
    await settle()

    check('鲍勃此刻没有这个字节', !bob.blobs.has(id!))

    // 他上线。声明随同步过去，字节由他自己按 id 来要。
    await network.link(alice.id, bob.id)
    await settle(6)

    check('鲍勃上线后自动要到了字节', bob.blobs.has(id!))
    check(
      '内容还是对的',
      bob.blobs.get(id!) ? new TextDecoder().decode(bob.blobs.get(id!)!) === '离线期间发的图' : false,
    )
    check(
      '爱丽丝没有报文件相关的错',
      // 「断开了」是 unlink 的正常产物，不算错；只挑文件相关的看。
      alice.problems.every((p) => !p.includes('文件')),
      ` → ${alice.problems.join('|')}`,
    )
  }

  console.log('\n=== 节点：文件（不在会话里的人要不到字节） ===')

  {
    /*
     * 这一节防的是一条**安全边界**，不是功能。
     *
     * 文件字节不走日志（日志要同步给所有认识的人），所以「谁能拿到字节」
     * 只能靠发送方自己记一张表 —— 记的就是 shareBlob 的 audience。
     * 表松了，局域网上任何一个连上来的进程发一帧 blob-want 就能把
     * 别人私聊里的文件原文拖走，而且这事在功能测试里**看不出来**：
     * 该收到的人确实收到了，一切「正常」。
     *
     * 所以这里要害是**同一个请求、两个人、两种结果** ——
     * 只看卡罗尔要不到，分不清是「被拒了」还是「根本没人搭理他」。
     */
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')
    const carol = await makeNode(network, '卡罗尔')

    await network.link(alice.id, bob.id)
    await network.link(alice.id, carol.id)
    await settle()

    const content = new TextEncoder().encode('私聊里发的合同') as Bytes
    const id = (await alice.node.shareBlob(content, '合同.txt', 'text/plain', [bob.id]))!

    // 两边都用同一种帧、同一个 id 去要。区别只有一个：鲍勃在名单里。
    //
    // 走 `wantBlobs` 而不是手搓帧：索取要**记账**（收到回包时才知道这是
    // 「我们要过的」而不是「别人硬塞的」）。手搓一帧的话，对方的回复到了
    // 会被接收侧的闸门拒掉，这一节就变成在测闸门、不是在测名单。
    await bob.node.wantBlobs(alice.id, [id])
    await carol.node.wantBlobs(alice.id, [id])
    await settle(6)

    check('名单里的人拿到了字节', bob.blobs.has(id))
    check('不在名单里的人没拿到', !carol.blobs.has(id))
    check(
      '而且爱丽丝没报错（装作没有，不暴露「这儿确实有」）',
      alice.problems.every((p) => !p.includes('文件')),
      ` → ${alice.problems.join('|')}`,
    )
  }

  console.log('\n=== 节点：我们没要过的文件字节不会被收下 ===')

  {
    /*
     * 这一节防的是**灌仓**，不是哈希。
     *
     * 出站那两条路（推给名单里的人、回答 blob-want）都老老实实过了名单，
     * 但入站原来是「谁来推都收」—— 一个连上来的进程可以不停推 32 MB 的块，
     * 把 256 MB 的仓库灌满，而 `put()` 是**拒收**不是挤掉，于是真文件再也
     * 放不进来。哈希校验挡不住这个：它保证的是「内容没被改过」，不是
     * 「我本来想要它」。
     */
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')

    await network.link(alice.id, bob.id)
    await introduce(alice)
    await settle()

    const content = new TextEncoder().encode('没人要过的东西') as Bytes
    const id = await blobIdOf(content)
    await alice.bridge.send(
      bob.id,
      encodeFrame({ t: 'blob-data', id, b64: encodeBlob(content), name: '硬塞.txt' }),
    )
    await settle()

    check('没要过的字节没落库', !bob.blobs.has(id))
    check('而且报出来了', bob.problems.some((p) => p.includes('没要过')), ` → ${bob.problems.join('|')}`)
  }

  console.log('\n=== 节点：帧不能自称来自我本人或陌生人 ===')

  {
    /*
     * `event.from` 是 Rust 那层转上来的一个字符串，hello 里的 id 只校验了
     * 「非空、不超长」，**没有任何东西把它和公钥绑起来**。
     *
     * 上面「自称是我本人的链路」那一节守的是 peers 注册表；这一节守的是
     * **帧通道**，它原来完全不查来源。不查的话，一条自称「我就是你」的帧
     * 就能直接拿到任意 blob（`maySeeBlob` 曾经放行 selfId）、整个日志
     * （`sync`）、或让本机把文件字节发回去（`blob-want`）。
     */
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')

    await settle()

    const handler = (alice.bridge as unknown as { handler: ((e: unknown) => void) | null }).handler
    const inert = Array.from(encodeFrame({ t: 'ping', ts: Date.now() }))
    handler?.({ kind: 'frame', from: alice.id, data: inert })
    handler?.({ kind: 'frame', from: 'mNCxsF10hnWdg1uXstxeigmKzjYXSxV1HuuKBT-m72M', data: inert })
    await settle()

    check('自称本人的帧被丢掉', alice.problems.some((p) => p.includes('自称来自我本人')))
    check('陌生人的帧被丢掉', alice.problems.some((p) => p.includes('未知对端')))
  }

  console.log('\n=== 节点：同一坨字节共享给两个人，第一个人不被踢掉 ===')

  {
    /*
     * 内容寻址下，同一份内容只有一个 id。甲和乙都该看到同一个文件时，
     * 会先后两次 `shareBlob`。名单如果是**覆盖**而不是并集，第二次就把甲
     * 踢了出去 —— 甲明明该看到，之后推和取都被当局外人。
     *
     * 这里走「要」的路径：先不给甲字节（推送会被接收侧的索取闸门挡掉），
     * 之后再让他去要一次。名单里还有他，就应当要到。
     */
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')
    const carol = await makeNode(network, '卡罗尔')

    await network.link(alice.id, bob.id)
    await network.link(alice.id, carol.id)
    await settle()

    const content = new TextEncoder().encode('两个人都该看到的东西') as Bytes
    const first = await alice.node.shareBlob(content, '共享.txt', 'text/plain', [bob.id])
    const second = await alice.node.shareBlob(content, '共享.txt', 'text/plain', [carol.id])
    check('同一份内容只有一个 id', first === second)
    await settle(4)
    check('鲍勃此刻手上还没有（推送被索取闸门挡掉了）', !bob.blobs.has(first!))

    await bob.node.wantBlobs(alice.id, [first!])
    await settle(4)

    check('先共享给鲍勃、又共享给卡罗尔之后，鲍勃仍然要得到', bob.blobs.has(first!))
  }

  console.log('\n=== 节点：一帧要太多文件会被截断 ===')

  {
    /*
     * 接收侧必须自己设上限：一帧 `blob-want` 能塞最多 6 万个 id，而我们是
     * 逐 id 回一整帧 `blob-data`。不封顶就是一个放大器。
     *
     * 判据不能只看「有没有报错」—— 报错和截断是两件事，得看**实际有没有
     * 把超出上限的那部分服务出去**。所以这里把真 id 放到第 200 位，然后
     * 数爱丽丝实际发出去的 blob-data 帧。
     */
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')

    await network.link(alice.id, bob.id)
    await settle()

    const content = new TextEncoder().encode('排在很后面的真文件') as Bytes
    const id = (await alice.node.shareBlob(content, '后面的.txt', 'text/plain', [bob.id]))!
    await settle()

    const junk = Array.from({ length: 199 }, (_, i) => `junk-${i}`)
    alice.bridge.wire.length = 0
    await bob.bridge.send(alice.id, encodeFrame({ t: 'blob-want', ids: [...junk, id] }))
    await settle(4)

    const served = alice.bridge.wire
      .map((r) => decodeFrame(r.data))
      .filter((f) => f?.t === 'blob-data')
    check('第 200 位那个真 id 没有被服务（每帧只认前 128 个）', served.length === 0)
    check('而且报出来了', alice.problems.some((p) => p.includes('一次要了')))
  }

  console.log('\n=== 节点：内容对不上时拒收 ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')

    await network.link(alice.id, bob.id)
    await introduce(alice)
    await settle()

    // 有人声称「id = X 的文件」但发来的是别的内容。
    // 直接用底层桥发一帧，绕过 shareBlob 的诚实封装。
    const id = await blobIdOf(new TextEncoder().encode('真的内容') as Bytes)
    const bogus = new TextEncoder().encode('假的内容') as Bytes

    // 先真的去要一次，好让这一节测的是**哈希校验**而不是接收侧的索取闸门
    // （闸门会先一步把「没要过的推送」丢掉，那样这一节就测不到哈希了）。
    await bob.node.wantBlobs(alice.id, [id])

    await alice.bridge.send(
      bob.id,
      encodeFrame({ t: 'blob-data', id, b64: encodeBlob(bogus), name: '坏东西' }),
    )
    await settle()

    check('内容对不上的文件没有落库', !bob.blobs.has(id))
    check('而且报出来了', bob.problems.some((p) => p.includes('对不上')), ` → ${bob.problems.join('|')}`)
  }

  console.log('\n=== 节点：反复要日志会被节流（不是拒绝一次性全量）===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')
    const bob = await makeNode(network, '鲍勃')

    await network.link(alice.id, bob.id)
    await meet(alice, bob)
    await settle()

    /** 看爱丽丝往鲍勃那条链路上发了几帧 `events`、一共带了多少条。 */
    const drainEvents = (): { frames: number; ids: string[] } => {
      const out: { frames: number; ids: string[] } = { frames: 0, ids: [] }
      for (const r of alice.bridge.wire) {
        if (r.to !== bob.id) continue
        const f = decodeFrame(r.data)
        if (f?.t !== 'events') continue
        out.frames++
        for (const e of f.events) out.ids.push(e.id)
      }
      return out
    }

    // ── 第一件事：一次 sync 必须能把缺的**全部**发完 ────────────────────
    //
    // 这条是节流存在的前提。`sync` 只在握手和 markDirty 时触发，被截断的
    // 部分再没有第二次机会补 —— 所以闸门必须挡「重复」而不是挡「全量」。
    //
    // 桶是**跟着链路**走的：刚连上时鲍勃自己那一侧已经发过一轮 `resync`，
    // 说不定还因为 markDirty 补过，所以这里不能假设「现在一定还有令牌」。
    // 等它回填（最多 5 秒一轮），比把测试写成依赖时序要诚实。
    const total = alice.log.all().length
    check('爱丽丝日志里确实有东西可补', total > 1, ` → ${total}`)

    const syncOnce = async (): Promise<{ frames: number; ids: string[] }> => {
      for (let attempt = 0; attempt < 40; attempt++) {
        alice.bridge.wire.length = 0
        await bob.bridge.send(alice.id, encodeFrame({ t: 'sync', have: [] }))
        await settle(6)
        const got = drainEvents()
        if (got.frames > 0) return got
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return { frames: 0, ids: [] }
    }

    const first = await syncOnce()
    check(
      `一次 sync 就把 ${total} 条全发了（没有截断）`,
      new Set(first.ids).size === total,
      ` → 发出 ${new Set(first.ids).size} 条 / ${first.frames} 帧`,
    )

    // ── 第二件事：连灌 10 次只放行令牌桶那么多 ──────────────────────────
    //
    // `{t:'sync',have:[]}` 合法且只有约 25 字节，回礼却是整个日志 ——
    // 这就是 S5 那条「25 字节换 ~98 帧」。不节流的话，所有其他对端的帧
    // 都会被挤出那条全局串行队列。
    alice.bridge.wire.length = 0
    for (let i = 0; i < 10; i++) {
      await bob.bridge.send(alice.id, encodeFrame({ t: 'sync', have: [] }))
    }
    await settle(6)

    const flood = drainEvents()
    // 见 `src/p2p/node.ts` 的 `SYNC_BUCKET_SIZE`。
    const SYNC_BUCKET = 3
    check(
      `10 次 sync 只回了 ${SYNC_BUCKET} 轮以内（实际 ${flood.frames} 帧）`,
      flood.frames <= SYNC_BUCKET,
      ` → ${flood.frames}`,
    )
    check('而且报出来了', alice.problems.some((p) => p.includes('补得太频繁')))
  }

  console.log('\n=== 节点：时间在走，额度就会回填（挡的是重复，不是重试）===')

  {
    // 这一节存在的唯一理由：`takeSyncToken` 里那句
    // `at = gained > 0 ? now : prev.at` —— 如果写成 `at = now`，
    // **每一次**被拒的请求都会把回填窗口的起点推到「现在」，
    // 于是只要有对端一直在敲，这个桶就永远是空的 —— 连正常补日志
    // （连接抖动后 markDirty 那一次重试）也拿不到令牌，丢了帧就再也补不回来。
    //
    // 这个差异只有在「时间在两次拒绝之间往前走」时才看得见，
    // 所以这一节必须能自己推时钟 —— 否则就得真睡 5 秒才验得出来。
    let now = 1_000_000
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝', {
      syncRate: { bucket: 2, refillMs: 1_000, now: () => now },
    })
    const bob = await makeNode(network, '鲍勃')

    await network.link(alice.id, bob.id)
    await meet(alice, bob)
    await settle()

    /** 让鲍勃要一次日志，回爱丽丝发了几帧 `events`。 */
    const sync = async (): Promise<number> => {
      alice.bridge.wire.length = 0
      await bob.bridge.send(alice.id, encodeFrame({ t: 'sync', have: [] }))
      await settle(6)
      let frames = 0
      for (const r of alice.bridge.wire) {
        if (r.to !== bob.id) continue
        if (decodeFrame(r.data)?.t === 'events') frames++
      }
      return frames
    }

    // 时钟停住，连要 4 次 —— 桶一定空（握手那几轮也在花额度）。
    let last = -1
    for (let i = 0; i < 4; i++) last = await sync()
    check('时钟停住时反复索取，最后一定被挡住', last === 0, ` → ${last} 帧`)

    // 现在让时钟每问一次走 600ms —— 不到一个回填窗口，但一直在走。
    let granted = 0
    for (let i = 0; i < 8; i++) {
      now += 600
      if ((await sync()) > 0) granted++
    }
    check(
      '★ 时间在走，额度就会回填（8 次索取里至少放行 2 次）',
      granted >= 2,
      ` → 放行 ${granted} 次`,
    )
  }

  console.log('\n=== 节点：自称是我本人的链路不被认作对端 ===')

  {
    const network = new FakeNetwork()
    const alice = await makeNode(network, '爱丽丝')

    // 伪造一条「握手成功，对端 id 就是我自己的 id」的事件。
    //
    // 这在真链路上不需要任何凭据：对端 id 是它在 TCP hello 里自己填的，
    // Rust 侧只校验「非空、不超长」，不把它和公钥绑起来。而 `maySeeBlob()`
    // 有一条 `peerId === selfId → true` 的捷径（本机取自己的文件用），
    // 所以这条假链路一旦进了 `peers` 表，**任何** blob 的名单检查都会放行，
    // 字节会被原样推过去 —— 线上只是 base64，不是密文。
    const inject = (
      alice.bridge as unknown as { handler: ((e: unknown) => void) | null }
    ).handler
    check('能拿到桥的事件回调（否则这条测试是假的）', typeof inject === 'function')
    inject?.({ kind: 'linked', peer_id: alice.id, addr: '10.0.0.9:1234', info: {} })
    await settle()

    check('自称是我本人的链路没进对端表', alice.node.status().linked === 0, ` → ${alice.node.status().linked}`)
  }

  report()
}

/** 单聊会话 id：两边各算各的，必须得出同一个 —— 所以排序取小者固定。 */
function direct(a: string, b: string): string {
  return a < b ? `d:${a}:${b}` : `d:${b}:${a}`
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

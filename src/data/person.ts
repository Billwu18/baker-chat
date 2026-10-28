import type { Operator, UserId } from '../protocol/types'
import { DEFAULT_AVATAR_KEY } from './avatars'

/**
 * 从名册里查人。
 *
 * v1 这里会退回一张硬编码的 14 人表（`src/data/operators.ts`），后果是
 * **「查不到」和「查到了」在界面上长得一模一样** —— 一个名册里根本没有的
 * id 会被渲染成「李织烟」，头像、名字、编号一应俱全，看起来完全正常。
 * 排查的时候这种「安静地冒充另一个人」最难发现。
 *
 * 2.0 不再有任何本地名单：名册里没有就明确给一个占位，让「这个人我不知道」
 * 一眼看得出来 —— 名字是「未知用户」、编号是 `????`、头像是默认的那张。
 *
 * 注意它只负责**显示**。需要公钥做加解密的地方不要用它兜底，那些地方
 * 「查不到」必须就是查不到（见 chatStore.operatorOf）。
 */
export function personOf(roster: Operator[], id: UserId): Operator {
  return (
    roster.find((op) => op.id === id) ?? {
      id,
      name: '未知用户',
      number: '????',
      avatarKey: DEFAULT_AVATAR_KEY,
    }
  )
}

/**
 * 名字，没设名字就退回编号。
 *
 * 界面上绝大多数地方是「名字 + #编号」并排显示的（`{op.name}` 后面紧跟
 * `<i>#{op.number}</i>`），那种地方名字为空也没关系，编号本来就在那儿。
 * 但有几处**只有名字**：撤回提示（「「谁」撤回了一条消息」）、引用预览、
 * 建群时的成员按钮 —— 名字由本人填，没人替别人编，
 * 所以那几处必须自己退回编号，否则会出现「「」撤回了一条消息」。
 */
export function nameOrNumber(op: Operator): string {
  return op.name || op.number
}

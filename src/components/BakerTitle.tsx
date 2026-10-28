import titleDecoration from '../assets/baker/deco/achievement_main_deco05.png'
import type { ConnectionState } from '../protocol/types'

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: '未启动',
  connecting: '连接中…',
  connected: '已连接',
  reconnecting: '重连中…',
  offline: '已断开',
}

/**
 * 顶栏标题。
 *
 * 对应原版 main.css 的 #title：一行 `//BAKER/会话消息`，左上角叠一个小徽记
 * （absolute top:-12px left:0 width:55px opacity:0.4）。
 *
 * 连接状态（`● 已连接 · UID: …`）**紧跟在标题右边**，默认完全透明，鼠标移到这一行上才浮现：
 * 静止画面跟游戏一模一样，但「这是哪台机器连着」这件事仍然看得见。
 * 它不占独立的一栏，也不会被甩到屏幕最右边 —— 想确认自己是谁，视线不用横跨整个窗口。
 *
 * ⚠ 这一行**不再是打开设置的入口**。原来点它开设置（原版 #title 是 cursor:pointer，
 * 当时顺手给了个真实用途），但那让游戏 HUD 的装饰变成了按钮，而且一整行都在命中范围里，
 * 点到空白处也会弹面板。设置挪到顶栏右边那个齿轮上（`BakerTabBar` 的 `.tabbar-settings`）。
 */
export function BakerTitle({ connection, uid }: { connection: ConnectionState; uid: string }) {
  return (
    <div id="title">
      <img src={titleDecoration} alt="" aria-hidden="true" />
      <span className="title-text">{'//BAKER/会话消息'}</span>

      <span id="title-status" data-connection={connection}>
        <i className="dot" data-state={connection} />
        {STATE_LABEL[connection]}
        {/* 身份还没就位时**不写 `UID:`**。写出来只会是 `UID: ????`，
            而 `????` 在别处是有确切含义的（「名册里查不到这个人」），
            两者混在一起会让人以为身份出了问题。 */}
        {uid ? ` · UID: ${uid}` : ''}
      </span>
    </div>
  )
}

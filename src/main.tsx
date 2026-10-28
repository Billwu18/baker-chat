import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installAssetVariables } from './styles/assetVars'
import { prepareTransport } from './transport'
import './styles/fonts.css'
import './styles/baker.css'
// 补遗：顶部标签栏、空状态、滚动条等对着游戏真实截图补的样式，必须在 baker.css 之后
import './styles/baker-hud.css'
// 功能层：搜索/会话设置/灯箱/@提及/拖拽发图，原版没有的东西都放这里
import './styles/baker-features.css'

// 素材地址必须先注入，否则第一帧会因为 var(--xxx) 为空而闪一下
installAssetVariables()

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

// 先把传输层备好（里面要 await 本机身份密钥），再挂载。
// 传输层本身不会抛（身份出问题它自己记着，见 consumeIdentityError）；
// 这里兜住任何意外，挂载**绝不**被挡住 —— 界面起来之后才讲得清问题。
void prepareTransport()
  .catch((error) => {
    console.error('[boot] 传输层准备失败：', error)
  })
  .finally(() => {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })

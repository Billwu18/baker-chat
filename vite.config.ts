import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 在开发时注入的宿主信息
const host = process.env.TAURI_DEV_HOST

// 把构建时间烤进产物，跑起来之后在设置面板底部能直接看到是哪一版 —— 
// 免得「网页版改了、baker.exe 还是旧的」这种糊涂账。
const now = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const buildStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_STAMP__: JSON.stringify(buildStamp),
    __BUILD_KIND__: JSON.stringify(process.env.TAURI_ENV_PLATFORM === 'windows' ? '桌面版' : '网页版'),
  },
  // 让 Tauri CLI 自己输出日志，Vite 不要清屏
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // ref/ 里是调研资料，src-tauri 由 cargo 自己管，都不参与前端热更新
      ignored: ['**/src-tauri/**', '**/ref/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // 桌面端只需照顾 WebView2 的内核版本
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
})

/// <reference types="vite/client" />

// Vite 的 ?url 导入在 TS 里需要这些声明，否则 import.meta.glob 的结果推不出 string。
declare module '*.png' {
  const url: string
  export default url
}

declare module '*.webp' {
  const url: string
  export default url
}

declare module '*.svg' {
  const url: string
  export default url
}

declare module '*.ttf' {
  const url: string
  export default url
}

declare module '*.otf' {
  const url: string
  export default url
}

// vite.config.ts 的 define 注入：构建时间和构建类型（网页版 / 桌面版）
declare const __BUILD_STAMP__: string
declare const __BUILD_KIND__: string

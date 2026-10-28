/**
 * 兜底猜 MIME。
 *
 * 浏览器给的 `File.type` 经常是空串（尤其是从某些压缩包、或者拖进来的
 * 冷门扩展名），而 MIME 决定三件事：气泡要渲染成图片还是文件卡片、
 * 保存时 data URL 该用什么类型、以及接收端该不该试着预览。
 *
 * 所以猜不出来时**返回空串**，由调用方按「不是图片」处理 ——
 * 猜一个 `application/octet-stream` 出来只会让判定多一个分支，
 * 而空串在两边都是「不认识」，语义最清楚。
 */
export function mimeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (/\.(png)$/.test(lower)) return 'image/png'
  if (/\.(jpe?g)$/.test(lower)) return 'image/jpeg'
  if (/\.(gif)$/.test(lower)) return 'image/gif'
  if (/\.(webp)$/.test(lower)) return 'image/webp'
  if (/\.(svg)$/.test(lower)) return 'image/svg+xml'
  if (/\.(mp4)$/.test(lower)) return 'video/mp4'
  if (/\.(txt|md|log)$/.test(lower)) return 'text/plain'
  if (/\.(pdf)$/.test(lower)) return 'application/pdf'
  if (/\.(zip)$/.test(lower)) return 'application/zip'
  return ''
}

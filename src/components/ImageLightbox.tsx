import { useEffect } from 'react'

/**
 * 图片放大查看。
 *
 * 消息里的图片是缩略尺寸，游戏里点开会全屏看原图 —— 这里照做。
 * 关闭方式给了三种：点背景、点右上角的 ×、按 Esc。
 */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片查看"
      onClick={onClose}
    >
      <img src={src} alt="" onClick={(event) => event.stopPropagation()} />
      <button type="button" className="image-lightbox-close" onClick={onClose} aria-label="关闭" />
    </div>
  )
}

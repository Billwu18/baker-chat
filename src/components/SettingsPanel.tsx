import { useEffect, useState } from 'react'
import { loadConfig, resetConfig, saveConfig, type AppConfig } from '../config'
import { useUiSettings } from '../store/uiSettings'
import {
  AVATAR_MAX_BYTES,
  BUILTIN_AVATARS,
  DEFAULT_AVATAR_KEY,
  NAME_MAX_LENGTH,
  isUploadedAvatar,
  resolveAvatar,
} from '../data/avatars'
import {
  deviceFingerprint,
  deviceIdentityCreatedAt,
  exportDeviceIdentity,
  getDeviceIdentity,
  importDeviceIdentity,
  resetDeviceIdentity,
} from '../crypto/device'

/**
 * 把用户挑的图压成一小段 data: URL。
 *
 * 为什么必须压：头像跟着名册一起下发（原因见 `src/data/avatars.ts`），而名册
 * 每次登录都要整份传一遍。一张手机照片直接塞进去，连接会变得又慢又容易被
 * 服务端拒掉。压到 32KB 以内大约是 128×128 的 JPEG 质量 0.7 上下，当头像
 * 绰绰有余。
 *
 * 先裁成正方形再缩放：头像框是圆的，不裁的话竖长图会被压扁成椭圆脸。
 * 只靠降质量是压不下来的 —— 手机拍的照片动辄四千像素宽。
 */
async function shrinkToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = 128
  const cut = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('这个浏览器不给画布，换不了头像')
  ctx.drawImage(bitmap, (bitmap.width - cut) / 2, (bitmap.height - cut) / 2, cut, cut, 0, 0, side, side)
  bitmap.close()
  // 从高质量往下试，第一个装得下的就用 —— 简单图会停在高质量那一档。
  for (const quality of [0.85, 0.7, 0.55, 0.4, 0.25]) {
    const url = canvas.toDataURL('image/jpeg', quality)
    if (approxBytes(url) <= AVATAR_MAX_BYTES) return url
  }
  throw new Error('这张图压不到 32KB 以内，换一张简单点的吧')
}

/** data: URL 的实际字节数。base64 每 4 个字符还原 3 字节。 */
function approxBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  return Math.ceil((dataUrl.length - comma - 1) * 0.75)
}

/**
 * 「我叫什么、长什么样」。
 *
 * 这里只有两样东西，而且都是**给别人看的**：显示名和头像。真正的身份
 * （编号 + 密钥对）改不了，也不该让人以为能改 —— 那是下面「本机身份」那一段。
 *
 * 名字**不是身份**：谁都能叫「管理员」。所以界面里名字旁边永远跟着编号，
 * 这一段也把这句话直接写出来，免得用户以为起了名字就等于「认领了这个人」。
 */
function ProfileSection({
  config,
  patch,
}: {
  config: AppConfig
  patch: (next: Partial<AppConfig>) => void
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const upload = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setNotice('')
    try {
      patch({ avatarKey: await shrinkToDataUrl(file) })
      setNotice('图片已压缩，点「保存」生效。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="profile">
      <h3>个人设置</h3>

      <label>
        显示名
        <input
          type="text"
          value={config.displayName}
          maxLength={NAME_MAX_LENGTH}
          placeholder={config.selfId ? `留空则显示编号 ${config.selfId}` : '留空则显示编号'}
          onChange={(event) => patch({ displayName: event.target.value })}
        />
      </label>

      <div className="avatar-picker">
        <span className="avatar-picker-label">头像</span>
        <div className="avatar-grid">
          {BUILTIN_AVATARS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={option.key === config.avatarKey ? 'avatar-choice on' : 'avatar-choice'}
              title={option.label}
              aria-label={option.label}
              aria-pressed={option.key === config.avatarKey}
              onClick={() => patch({ avatarKey: option.key })}
            >
              <img src={resolveAvatar(option.key)} alt="" />
            </button>
          ))}
          {/* 上传的那张不在相册里，但得让人看见自己现在用的是它 */}
          {isUploadedAvatar(config.avatarKey) && (
            <button
              type="button"
              className="avatar-choice on"
              title="你上传的那张"
              aria-pressed
              onClick={() => patch({ avatarKey: DEFAULT_AVATAR_KEY })}
            >
              <img src={config.avatarKey} alt="你上传的头像" />
            </button>
          )}
        </div>
      </div>

      <div className="row">
        <input
          id="cfg-avatar-file"
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(event) => void upload(event.target.files?.[0])}
        />
        <label htmlFor="cfg-avatar-file">
          或者上传一张
        </label>
      </div>

      {notice && <p className="hint">{notice}</p>}
    </section>
  )
}

/**
 * 本机身份。
 *
 * 这是整个安全模型里唯一需要用户**亲手做**的一件事：核对指纹。
 * 其它一切都是自动的（事件签名、TOFU、加密），但「名册里那把公钥
 * 到底是不是对方的」只能靠人从另一条信道确认 —— 当面、电话、或者
 * 任何不经过局域网的途径。
 *
 * 所以这一段不藏在折叠里，指纹也做得足够大、足够好念。
 */
function IdentitySection() {
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [createdAt, setCreatedAt] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [bundle, setBundle] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void deviceFingerprint().then(setFingerprint)
    void getDeviceIdentity()
      .then(() => setCreatedAt(deviceIdentityCreatedAt()))
      .catch((error: unknown) => {
        setCreatedAt(null)
        // 本机存着身份但读不出来（见 device.ts 的 DeviceIdentityUnreadableError）。
        // 必须在这里说出来：静默显示成「还没有身份」会把人引向「重置身份」，
        // 而那一步会把仅剩的恢复线索（旧字节）也覆盖掉。
        setNotice(error instanceof Error ? error.message : String(error))
      })
  }, [])

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice(`${what}已复制到剪贴板`)
    } catch {
      setNotice(`复制失败 —— 手动选中下面那段文本吧`)
    }
  }

  return (
    <section className="identity">
      <h3>本机身份</h3>

      {fingerprint ? (
        <>
          <div className="identity-fingerprint" title="指纹">
            {fingerprint}
          </div>
          <p className="hint">
            {createdAt
              ? `生成于 ${new Date(createdAt).toLocaleString('zh-CN')}`
              : '这台设备已经有身份了。'}
          </p>
        </>
      ) : (
        <p className="hint">正在读取本机身份…</p>
      )}

      <div className="identity-actions">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              setBundle(await exportDeviceIdentity())
              setNotice('身份包已生成')
            } catch (error) {
              setNotice(`导出失败：${String(error)}`)
            } finally {
              setBusy(false)
            }
          }}
        >
          导出身份
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (!bundle.trim()) {
              setNotice('先粘贴身份包')
              return
            }
            try {
              const fp = await importDeviceIdentity(bundle)
              setFingerprint(fp)
              setNotice('身份已导入')
            } catch (error) {
              setNotice(`导入失败：${error instanceof Error ? error.message : String(error)}`)
            }
          }}
        >
          导入身份
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm('换一把全新身份？')) return
            setFingerprint(await resetDeviceIdentity())
            setBundle('')
            setNotice('已换新身份')
          }}
        >
          重新生成
        </button>
      </div>

      {bundle && (
        <>
          <textarea
            className="identity-bundle"
            value={bundle}
            readOnly
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="identity-actions">
            <button type="button" onClick={() => void copy(bundle, '身份包')}>
              复制身份包
            </button>
          </div>
          <p className="hint">
            <strong>这就是你的私钥</strong>，别发给任何人。
          </p>
        </>
      )}

      {notice && <p className="hint identity-notice">{notice}</p>}
    </section>
  )
}

/**
 * 设置面板。
 *
 * 用游戏原版 `#settings` 的外观（白底、680×480 那个弹窗的配色）。
 * 这里放的都是「需要重建连接才生效」的项，所以保存后会重载窗口 ——
 * 比在 store 里做热切换可靠得多，也不会让已经建立的会话状态半新半旧。
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<AppConfig>(loadConfig)
  const { settings, update, reset } = useUiSettings()

  const patch = (next: Partial<AppConfig>) => setConfig((cur) => ({ ...cur, ...next }))

  // Esc 关掉。backdrop 能点，但键盘用户按 Esc 是肌肉记忆 —— 而这个面板
  // 盖住了整个界面，找不到出路时只能乱点。
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

  const save = () => {
    saveConfig(config)
    window.location.reload()
  }

  const restore = () => {
    resetConfig()
    reset()
    window.location.reload()
  }

  return (
    <div id="settings-backdrop" onClick={onClose}>
      <div id="settings" onClick={(event) => event.stopPropagation()}>
        <h2>Baker 设置</h2>

        <div className="row">
          <input
            id="cfg-names"
            type="checkbox"
            checked={settings.showSenderNames}
            onChange={(event) => update({ showSenderNames: event.target.checked })}
          />
          <label htmlFor="cfg-names">
            在气泡上方显示发言人名称
          </label>
        </div>

        <div className="row">
          <input
            id="cfg-flash"
            type="checkbox"
            checked={settings.flashOnMessage}
            onChange={(event) => update({ flashOnMessage: event.target.checked })}
          />
          <label htmlFor="cfg-flash">收到新消息时闪一下任务栏</label>
        </div>

        <ProfileSection config={config} patch={patch} />

        <IdentitySection />

        <p className="build-stamp">
          {__BUILD_KIND__} · 构建于 {__BUILD_STAMP__}
        </p>

        <div className="actions">
          <button type="button" onClick={restore}>
            恢复默认
          </button>
          <button type="button" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

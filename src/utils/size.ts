/**
 * 把字节数写成人看的一句话。
 *
 * 保留一位小数就够：文件卡片上「2.3 MB」和「2.31 MB」对人没有区别，
 * 而多出来的那一位只会让同一行里的文件名和大小打架。
 *
 * `1024` 而不是 `1000`：这里的数字来自 `File.size` 和 `bytes.length`，
 * 都是二进制计数，用十进制换算会让同一个文件在「发送前」和「收到后」
 * 显示出不一样的大小。
 */
export function formatBytes(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // 1.0 KB 这种写法很难看：整数就不带小数点。四舍五入之后再判断，
  // 否则 1023.95 KB 会先被写成「1.0 MB」再被砍成「1 MB」，跳过一位单位。
  const rounded = Math.round(value * 10) / 10
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`
}

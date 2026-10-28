/**
 * 图片地址的白名单。
 *
 * ## 为什么需要它
 *
 * 消息的正文、图片、贴纸是**整个打包进密文**的（见 `store/chatStore.ts` 的
 * `decryptMessage`），所以 `imageUrl` 是对端自己拼的字符串，拆开信封就是一个
 * 普通人写的字段 —— 没有任何地方能保证它是我们生成的那种 data URL。
 *
 * 它随后一路直通进 `<img src>`：`assets/registry.ts` 的
 * `imageUrl(src) { return src }` 是个恒等函数，中间没有第二道关。
 *
 * 于是把一个 `https://…/px.gif?who=…` 塞进来，就等于在**别人的机器上**
 * 插了一个出网信标：谁打开了这张图、什么时候打开的、那台机器的出口 IP 是
 * 什么，外面那个服务器全知道。而这是个明确宣称「纯局域网、不联网」的产品 ——
 * 这件事一旦发生，产品说的话就不再成立了。
 *
 * ## 为什么是白名单而不是黑名单
 *
 * 「挡掉 http/https」会被 `//evil.com/x.gif`（协议相对）、`data:text/html,…`
 * 之类的写法绕过去。真正想表达的是「只接受我们自己产生的这一种」，那就直接
 * 把这一种写出来。`assets/registry.ts` 里头像那条路用的是同一张名单。
 *
 * @returns 可以直接用的字符串；不像 data 图片就返回 `undefined`。
 */
export function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/.test(value) ? value : undefined
}

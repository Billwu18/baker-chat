# 素材目录说明

这个目录里的**图片和字体不随仓库分发**。原因见根目录 `NOTICE.md`：
它们是从游戏里提取的美术资源，著作权不属于本项目。

## 现在仓库里有什么

| 路径 | 内容 | 说明 |
|---|---|---|
| `baker/background/app-background.webp` | 1×1 深灰 WebP | 占位图，拉伸后是一整块纯色底 |
| `baker/deco/achievement_main_deco05.png` | 1×1 透明 PNG | 占位图，标题栏那块装饰看不见 |
| `fonts/` | 空 | 需要自己放字体，否则界面回落到系统字体 |

## 为什么还要留占位图

`src/App.tsx` 和 `src/components/BakerTitle.tsx` 是**静态 import** 这两个文件 ——
文件不存在会直接编译失败。其余素材（头像、贴纸、表情、装饰、遮罩）走的是
`src/assets/registry.ts` 里的 `import.meta.glob`：**找不到就返回空表**，
界面相应位置留空，但项目照常编译、照常运行。

## 想要完整外观

把你的素材按下面的路径放进来即可，不需要改代码：

```
src/assets/baker/extracted/avatar/      头像     （文件名即 avatarKey）
src/assets/baker/extracted/emoji/       行内表情 （文件名即 emojiKey，如 sns_emoji_001.png）
src/assets/baker/extracted/sticker/     贴纸     （子目录名 + 文件名 = stickerKey）
src/assets/baker/extracted/icon/        界面图标
src/assets/baker/extracted/decorate/    装饰
src/assets/baker/extracted/mask/        遮罩
src/assets/baker/extracted/bg/          背景
src/assets/baker/deco/                  其他零散装饰
src/assets/fonts/                       HarmonyOS_Sans_SC_{Regular,Medium,Bold}.ttf、bender.otf
```

`src/assets/registry.ts` 里能看到每一类确切的 glob 规则和命名约定。

> 放之前请先确认**你有权使用这些文件**。本项目不接受包含第三方游戏美术资源的 PR。

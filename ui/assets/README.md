# 品牌图标

- `chatgpt.png`：OpenAI 官方桌面应用附带的 `icon-chatgpt.png` 原始素材。
- `codex.png`：OpenAI 官方桌面应用附带的 `icon-codex-light.png` 原始素材。

以上图标仅用于标识连接的产品，相关品牌与素材权利归 OpenAI 所有，不纳入本项目 MIT 授权。

## 应用头像

`arc-remote.png` 是 ARC 的应用头像，使用不透明浅鼠尾草底色。网页品牌图和 favicon 引用同一源图。桌面图标位于 `desktop/icons/`，可在仓库根目录使用以下命令重新生成：

```sh
npx tauri icon ui/assets/arc-remote.png --output desktop/icons
```

macOS 运行时 Dock 图标跟随系统外观：浅色使用安装包原图，深色由 AppKit 绘制深色圆角底板并叠加 `arc-remote-head.png`，系统切换外观时立即更新。应用内深浅主题不改变 Dock 外观。未运行时以及 Finder 中仍使用安装包的静态图标。

菜单栏使用 `desktop/icons/tray-logo.png`：应用头像去除底色后的透明彩色版本，不使用系统单色模板渲染。

首页互动头像使用 `arc-remote-head.png`（高清透明底），背景由 CSS 单独绘制，点击动画只作用于头像。

## Agent 单色图标

`agents/` 中的内置 Agent 品牌 SVG（包括 Claude、Cursor、Gemini、Grok、GitHub、Kimi、Qwen、Kiro、Devin、Cline、Junie、Hermes、OpenAI、Pi 和 OpenCode）来源于 [Lobe Icons](https://github.com/lobehub/lobe-icons)，按 MIT 授权使用，许可证见 `agents/LICENSE`。相关商标归各自权利人所有。

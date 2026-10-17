# 品牌图标

- `chatgpt.png`：OpenAI 官方桌面应用附带的 `icon-chatgpt.png` 原始素材。
- `codex.png`：OpenAI 官方桌面应用附带的 `icon-codex-light.png` 原始素材。

以上图标仅用于标识连接的产品，相关品牌与素材权利归 OpenAI 所有，不纳入本项目 MIT 授权。

## Agent Remote Control（ARC） 标识与吉祥物

品牌源文件与两套素材位于 `assets/brand/`；`npm run brand -- primary` 重新生成全部平台图标及 UI 标识，参数可换为 `alternate`。

`ui/assets/arc/` 是当前品牌素材。macOS 使用 `desktop/icons/AgentRemoteControl.icon` 的原生深浅外观和 `menubar-18Template(@2x).png` 模板菜单栏图标；Windows 使用生成的 ICO 和彩色托盘图标。

首页中心固定显示 ARC 标识。

## Agent 单色图标

`agents/` 中的内置 Agent 品牌 SVG（包括 Claude、Cursor、Gemini、Grok、GitHub、Kimi、Qwen、Kiro、Devin、Cline、Junie、Hermes、OpenAI、Pi 和 OpenCode）来源于 [Lobe Icons](https://github.com/lobehub/lobe-icons)，按 MIT 授权使用，许可证见 `agents/LICENSE`。相关商标归各自权利人所有。

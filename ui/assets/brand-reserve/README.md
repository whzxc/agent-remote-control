# 备用品牌资源

本目录的部分资源参与当前界面；控制源映射见 `control-sources/index.ts` 和 manifest 的 `controlSourceUsage`。文件保留原始内容，不对单色标志自行染色。

- `mono.svg`：单色符号；`color.svg`：上游提供的彩色符号。
- `wordmark*.svg`：文字标志；`app.png`：已有原始应用图标。
- `favicon.*`：网站图标，与桌面 App Logo 区分。
- 缺少彩色版本表示本目录未收录，不表示品牌不存在彩色设计。
- SVG 的 `currentColor` 适合内联后按主题着色；作为 img 引用时通常显示为黑色。

## 索引

打开 [preview.html](preview.html) 查看图形；精确来源、许可和 SHA-256 见 [manifest.json](manifest.json)。

| 对象 | 已收录 |
| --- | --- |
| control-sources/chatgpt | [app.png](control-sources/chatgpt/app.png), [mono.svg](control-sources/chatgpt/mono.svg), [wordmark.svg](control-sources/chatgpt/wordmark.svg) |
| control-sources/notion | [mono.svg](control-sources/notion/mono.svg), [wordmark.svg](control-sources/notion/wordmark.svg) |
| agents/codex | [app.png](agents/codex/app.png), [color.svg](agents/codex/color.svg), [mono.svg](agents/codex/mono.svg), [wordmark.svg](agents/codex/wordmark.svg) |
| agents/pi | [mono.svg](agents/pi/mono.svg), [wordmark.svg](agents/pi/wordmark.svg) |
| agents/opencode | [mono.svg](agents/opencode/mono.svg), [wordmark.svg](agents/opencode/wordmark.svg) |
| agents/gemini | [color.svg](agents/gemini/color.svg), [mono.svg](agents/gemini/mono.svg), [wordmark.svg](agents/gemini/wordmark.svg) |
| agents/claude | [color.svg](agents/claude/color.svg), [mono.svg](agents/claude/mono.svg), [wordmark.svg](agents/claude/wordmark.svg) |
| agents/cursor | [mono.svg](agents/cursor/mono.svg), [wordmark.svg](agents/cursor/wordmark.svg) |
| agents/grok | [mono.svg](agents/grok/mono.svg), [wordmark.svg](agents/grok/wordmark.svg) |
| agents/copilot | [color.svg](agents/copilot/color.svg), [mono.svg](agents/copilot/mono.svg), [wordmark.svg](agents/copilot/wordmark.svg) |
| agents/kimi | [color.svg](agents/kimi/color.svg), [mono.svg](agents/kimi/mono.svg), [wordmark.svg](agents/kimi/wordmark.svg) |
| agents/qwen | [color.svg](agents/qwen/color.svg), [mono.svg](agents/qwen/mono.svg), [wordmark.svg](agents/qwen/wordmark.svg) |
| agents/kiro | [color.svg](agents/kiro/color.svg), [mono.svg](agents/kiro/mono.svg), [wordmark.svg](agents/kiro/wordmark.svg) |
| agents/devin | [color.svg](agents/devin/color.svg), [mono.svg](agents/devin/mono.svg), [wordmark.svg](agents/devin/wordmark.svg) |
| agents/cline | [mono.svg](agents/cline/mono.svg), [wordmark.svg](agents/cline/wordmark.svg) |
| agents/junie | [color.svg](agents/junie/color.svg), [mono.svg](agents/junie/mono.svg), [wordmark.svg](agents/junie/wordmark.svg) |
| agents/hermes | [favicon.ico](agents/hermes/favicon.ico), [favicon.svg](agents/hermes/favicon.svg), [logo.png](agents/hermes/logo.png), [mono.svg](agents/hermes/mono.svg), [wordmark.svg](agents/hermes/wordmark.svg) |
| control-sources/slack | [color.svg](control-sources/slack/color.svg), [mono.svg](control-sources/slack/mono.svg), [wordmark-color.svg](control-sources/slack/wordmark-color.svg), [wordmark.svg](control-sources/slack/wordmark.svg) |

## 来源与使用边界

多数 SVG 来自 [Lobe Icons](https://github.com/lobehub/lobe-icons)，固定版本 1.95.1；Slack SVG 来自 [Devicon](https://github.com/devicons/devicon)，清单记录固定提交。对应 MIT 许可保存在 licenses/。MIT 图形代码许可不授予品牌商标权。

ChatGPT / Codex PNG 沿用项目已有官方应用资源，仍属 OpenAI，不纳入项目 MIT 许可。ChatGPT 单色文件是 OpenAI 通用标志，Codex 另有专用图形。Hermes 的 logo 与 favicon 来自官方仓库；使用时应核对上游品牌要求。

Slack 品牌要求参见 [官方媒体资料](https://slack.com/media-kit) 与 [品牌条款](https://slack.com/terms-of-service/slack-brand)。Agent Remote Control（ARC） 图标来自当前项目已有应用资源。自定义控制源没有固定品牌，因此未指定品牌 Logo。

本目录未为每个 CLI 虚构桌面 App Logo，也未将字标当作彩色图标。

## 控制源运行时映射

ChatGPT、Notion、Slack 复用各自 control-sources 资源；Claude、Cursor、Microsoft Copilot 分别复用 agents/claude/color.svg、agents/cursor/mono.svg、agents/copilot/color.svg 的原始字节，语义由独立 control-sources/index.ts 管理。注意 agents/copilot 是 Microsoft 的彩色标志，不是 GitHub Copilot。

GitHub Copilot 使用 control-sources/github-copilot/mono.svg，来自同版本 Lobe Icons 1.95.1（MIT，沿用 licenses/lobe-icons-MIT.txt）。Raycast 使用 control-sources/raycast/mono.svg，来自 Simple Icons 固定提交 b86d5c9a0bdd4f3f5c30898a63654dd32f39fd76（CC0-1.0，licenses/simple-icons-CC0.txt）；许可证原文来自该提交的 LICENSE.md。文件来源、SHA-256 见 manifest。商标权均归原权利人，不表示背书。没有复制字体文件。

新增单色图形按主题使用 currentColor；彩色图形保留原色。两种用途共享底层资产，不将 Agent 实例或能力当成 Control Source。

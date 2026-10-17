# Agent Remote Control（ARC）

**在 Claude 里规划，让本机 Codex 执行，自动接回结果，不用自己来回传话。**

[English](README.md) | **简体中文**

![ARC 首页：Claude、ChatGPT 与本机 Agents](docs/images/home-overview.png)

```text
控制源                        你的电脑                       Agents
Claude ── HTTPS + OAuth ──┐                              ┌── Codex
                         ├── ARC ── 实时项目事实 ────────┤
ChatGPT ─ Secure Tunnel ──┘                              └── Pi / ACP

Codex 轮次结束 → ARC → 绑定的 Claude Code 云端会话
```

## Claude + Codex：协作闭环（Loop）

在 Claude 网页、手机或桌面里讨论和规划。Claude 通过 ARC 读取当前文件、Git 改动和 Codex 任务，再把明确的工作派给本机 Codex。一轮结束后，ARC 通知绑定的 Claude Code 云端会话，Claude 就能审查改动并派出下一轮。离开键盘，也能继续推进。

Claude 使用 HTTPS + OAuth 接入。自动回访还需要发起方的 Claude Code 云端会话 ID，以及本机已登录的 Claude Code CLI。[建立闭环](docs/zh-CN/guides/claude.md)。

## ChatGPT Chat + Codex

在 Chat 模式里用 GPT-6 Astra Pro 深度推理和设计方案，再通过 ARC 交给本机 Codex。Chat 的 Pro 选项与 Codex 中可用的普通 Astra 模型不同。使用已开放该选项的 ChatGPT Pro、Business 或 Enterprise 账号，默认通过 OpenAI Secure Tunnel 连接。[接入 ChatGPT](docs/zh-CN/guides/chatgpt.md)。

## 三步开始

1. **安装。** 从 [Releases](https://github.com/whzxc/agent-remote-control/releases/latest) 下载 macOS 应用，移入 Applications，并登录 Codex。[安装说明](docs/zh-CN/installation.md)。
2. **接入 Claude。** 在 ARC 添加 Claude，选择 HTTPS + OAuth，把 MCP URL 添加为 Claude 自定义连接器，再到 ARC 同意授权。
3. **派出首个任务。** 告诉 Claude：“通过 ARC 让 Codex 不读文件、不调用工具，只回复 ARC_LOOP_OK。绑定本 Claude Code 云端会话接收完成通知，再读取结果。”提供云端会话 ID。[逐步上手](docs/zh-CN/getting-started.md)。

也可以把这段话交给本机 Codex：

> 阅读 https://github.com/whzxc/agent-remote-control/blob/main/docs/zh-CN/auto-setup.md ，按 Codex → Claude 流程配置。先读取安装版的 `cli help` 和 `cli guide`，保留现有连接，协助我完成授权与一个无害首任务。

## 文档

- **开始：**[上手](docs/zh-CN/getting-started.md) · [概念](docs/zh-CN/concepts.md) · [自动配置](docs/zh-CN/auto-setup.md)
- **连接：**[Claude](docs/zh-CN/guides/claude.md) · [ChatGPT](docs/zh-CN/guides/chatgpt.md) · [其他客户端](docs/zh-CN/guides/other-clients.md) · [HTTPS 提供商](docs/zh-CN/guides/connections.md)
- **使用：**[常见问题](docs/zh-CN/faq.md) · [安装、更新、卸载](docs/zh-CN/installation.md) · [为什么做 ARC](docs/zh-CN/story.md)
- **参考（英文）：**[工具](docs/reference/tools.md) · [Agents](docs/reference/agents.md) · [CLI](docs/reference/cli.md) · [OAuth](docs/reference/oauth.md) · [订阅用量](docs/reference/subscriptions.md) · [Linux](docs/reference/linux.md)
- **维护：**[开发](docs/dev/development.md) · [架构](docs/dev/architecture.md) · [UI](docs/dev/ui.md) · [发布](docs/dev/release.md)

也支持 Notion、Slack、Cursor、GitHub Copilot、Raycast、Microsoft Copilot、Grok 和自定义 MCP 客户端；Pi、OpenCode 与其他 ACP Agent 可与 Codex 一起使用。

本机 ChatGPT Desktop 面板由独立的 [Usage](https://github.com/whzxc/chatgpt-usage-plugin) 和 [Kanban](https://github.com/whzxc/chatgpt-kanban-plugin) 插件仓库维护。

## 许可证

[MIT](LICENSE)。

# 让本机 Agent 自动配置 ARC

[English](../auto-setup.md) | **简体中文**

在将运行 ARC 的电脑上，把一段提示词交给本机 Codex 或 Claude Code。按提示提供项目，让 Claude Code 云端会话绑定自己的 ID。修改前先读取安装版的 `cli help`、`cli guide`、`cli capabilities` 和 `cli schema <operation>`。可执行文件位置见 [CLI 参考](../reference/cli.md)。

## Codex → Claude

> 帮我在这台电脑配置 Agent Remote Control 接入 Claude。阅读 https://github.com/whzxc/agent-remote-control/blob/main/docs/zh-CN/getting-started.md 和安装版 CLI help/guide。未安装时安装当前官方版本并核对校验和，保留现有连接。添加 Claude HTTPS + OAuth 入口；我未提供固定域名时用 Cloudflare 临时域名。指导我添加 Claude 自定义连接器并在本机同意授权，从 Claude 调用 connector_verify。检查本机 Claude Code CLI，协助发起方的 Claude Code 云端会话读取自身 ID 并设置 notifyClaudeSession；无法读取时再让我粘贴 URL 或 ID。让该会话派出一个不调用工具、不读文件、只回复 ARC_LOOP_OK 的 Codex 任务，设置 notifyClaudeSession，验证通知和最终输出。准确报告未完成步骤。

## Codex → ChatGPT

> 帮我在这台电脑配置 Agent Remote Control 接入 ChatGPT Chat。阅读 https://github.com/whzxc/agent-remote-control/blob/main/docs/zh-CN/guides/chatgpt.md 和安装版 CLI help/guide。未安装时安装官方版本，保留现有连接。使用 OpenAI Secure Tunnel，协助取得官方 Tunnel ID/运行时 key，并在本机输入，不把密钥贴进对话。指导我开启 Developer Mode 并选择 Tunnel。从 ChatGPT 调用 connector_verify，再派出不调用工具、不读文件、只回复 ARC_ONBOARDING_OK 的 Codex 任务。保留 ID，每次等 30 秒直到取得最终输出。分别说明 Chat Pro 选项与 Codex 模型的选择。

## Claude Code → Claude

> 在这台电脑配置 Agent Remote Control，接入我的 Claude 自定义连接器。阅读 https://github.com/whzxc/agent-remote-control/blob/main/docs/zh-CN/guides/claude.md 和安装版 CLI help/guide。按需安装并核验官方版本，保留当前连接。添加 HTTPS + OAuth；我未提供固定域名时用 Cloudflare 临时域名，指导本机授权并从 Claude 验证连接。确认本机 Claude Code CLI 可访问我的云端会话。让云端会话读取并绑定自身 ID，不使用本地会话 ID；手动粘贴 URL 或 ID 仅作备选。协助该云端会话派出带 notifyClaudeSession 的无害 Codex 任务，并验证通知和结果。

## Claude Code → ChatGPT

> 配置 Agent Remote Control 接入 ChatGPT Chat。阅读 https://github.com/whzxc/agent-remote-control/blob/main/docs/zh-CN/guides/chatgpt.md 和安装版 CLI help/guide。按需安装官方版本，保留现有连接。通过本机输入凭据配置 OpenAI Secure Tunnel，指导我开启 ChatGPT Developer Mode 并选择 Tunnel。从 ChatGPT 验证 connector_verify，再派出只回复 ARC_ONBOARDING_OK 的无害 Codex 任务。超时后保留原请求和任务 ID。完成后说明如何用 Chat 中可用的 Pro 模型规划，再交给 Codex 执行。

## 限制

账号登录、工作区权限、Tunnel 身份申请和 OAuth 同意需要相关账号持有者操作。Agent 可以准备配置并说明下一步；本机命令成功后，还需从远程客户端验证。缺少凭据或用户决定时停在对应步骤，准确报告缺项。

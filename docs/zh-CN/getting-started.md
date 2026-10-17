# 完成第一个 Claude + Codex 闭环

[English](../getting-started.md) | **简体中文**

## 1. 在 macOS 安装

从 [Releases](https://github.com/whzxc/agent-remote-control/releases/latest) 下载 Apple Silicon DMG。把 **Agent Remote Control** 拖入 Applications，推出 DMG，再打开应用。安装 Codex Desktop 并登录。要接收自动回访，再安装并登录 Claude Code CLI。

macOS 拦截已核验的下载时，在**系统设置 → 隐私与安全性 → 仍要打开**中处理。若提示“已损坏”，仅移除此应用的隔离标记：

```sh
xattr -rd com.apple.quarantine "/Applications/Agent Remote Control.app"
```

## 2. 接入 Claude

1. 在 ARC 首页点击**添加控制源**，选择 **Claude**。
2. 选择 **HTTPS**、**OAuth** 和隧道提供商。首次可用 Cloudflare 临时域名，长期使用选择固定地址。
3. 保存并连接，复制显示的 MCP URL。
4. 在 Claude 的连接器设置里添加自定义连接器，填入 URL，发起授权。
5. 保持授权页打开，点击**打开 ARC**，在 ARC 核对请求并允许。返回 Claude，在对话中启用连接器。
6. 复制连接的验证提示词，让 Claude 执行；它会通过刚添加的连接调用 `connector_verify`。

## 3. 派任务并接收通知

在 claude.ai 打开 Claude Code 云端会话，发送下面的提示词。Claude 可以从自身环境读取会话 ID，例如 `CLAUDE_CODE_REMOTE_SDK_URL` 中的 `cse_…`：

> 通过 ARC 创建 Codex 任务，不调用工具、不读取文件，只回复 ARC_LOOP_OK。使用新 requestId，把你自己的 Claude Code 云端会话设为 notifyClaudeSession。读取回执，保留 threadId 和 turnId，然后结束本轮。完成通知唤醒本会话后读取结果，确认内容一致。

若 Claude 无法读取自身会话 ID，再手动粘贴云端会话 URL 或 ID。

Codex 轮次完成后，ARC 的状态通知唤醒同一 Claude 会话，让它读取结果；处理真实工作时，它可以审查 diff，再继续同一个任务。[Claude 指南](guides/claude.md)说明任务提示词、审批和下一轮操作。

## 下一步

- 让本机 Agent 配置：[自动配置](auto-setup.md)。
- 理解任务归属与工具权限：[概念](concepts.md)。
- 使用 ChatGPT Chat：[ChatGPT 指南](guides/chatgpt.md)。
- 使用 Windows、Homebrew 或 Linux：[安装说明](installation.md)。

## 限制

电脑需保持唤醒、联网，ARC 需保持运行。自动回访发送到 Claude Code 云端会话，普通 Claude 聊天链接不能接收。离开电脑前，在运行 ARC 的电脑上完成首次 OAuth 同意。连接或通知失败时查看[常见问题](faq.md)。

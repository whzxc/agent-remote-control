# 常见问题与排障

[English](../faq.md) | **简体中文**

## macOS 提示应用已损坏

核对发布校验和，把应用移入 Applications，再按[安装说明](installation.md#macos)处理 Gatekeeper。隔离命令只作用于下载的这个应用。

## 客户端连不上

打开 ARC 对应连接详情，查看错误。核对公开 URL 或 Tunnel ID，再从该客户端执行验证提示词。HTTPS 检查域名，并转发 OAuth 路由；Secure Tunnel 分别检查 Platform Tunnel 权限和 ChatGPT Developer Mode。`cli ingress doctor <id>` 可查看单条连接诊断。

## OAuth 打开了另一台电脑的 ARC

Deep link 打开的是浏览器所在设备的应用。请在承载连接的电脑上同意待处理请求，再返回原授权页。也可以使用已认证的 CLI。详见 [OAuth](../reference/oauth.md)。

## 新工具没有出现

保存连接的工具列表，再在客户端刷新 MCP 工具或重连。重新选择预设可采用当前工具集合；已保存的自定义列表保持精确选择。只有存在已安装、可用且启用的非 Codex Agent 时，额外 Agent 工具才出现。

## Codex 任务在哪里执行？

查看回执或结果中的 `executionOwner`。新任务默认由 Desktop 执行。关闭**自动打开 Codex 任务**只改变之后创建的任务，让它们使用 ARC 后台执行器。继续任务时沿用原 ID。详见[概念](concepts.md)。

## 等待超时，要重新派任务吗？

使用原任务和轮次 ID 再次调用 `codex_wait` / `agent_wait`，将返回的 snapshotHash 作为 expectedHash。派发结果不明时，先读原回执。等待超时不停止任务。

## Claude 没收到回访

检查 notifyClaudeSession 是否为 Claude Code 云端会话、本机 Claude Code CLI 是否已登录、ARC 是否持续运行。读取 `claudeNotification` 和记录。投递只尝试一次；通知失败后直接读取任务。详见 [Claude](guides/claude.md)。

## 可以关窗口或离开电脑吗？

关闭 ARC 窗口后菜单栏或托盘进程继续运行。电脑需保持唤醒和联网；休眠或断网会中断远程访问。最后一个 Core 客户端退出后，其后台 Agents 停止；Codex Desktop 任务遵循 Desktop 生命周期。

## 为什么额度信息缺失或过期？

在 ARC 打开对应 Agent，刷新用量，查看上游错误和原生登录。部分来源只返回套餐而没有额度。缓存读数会标记为过期。详见[订阅参考](../reference/subscriptions.md)。

## 限制

临时隧道 URL 可能变化，首次授权和任务交互可能需要你处理。普通 Chat 需保持等待或再次发消息查询进度；Claude 自动回访使用上述云端会话配置。

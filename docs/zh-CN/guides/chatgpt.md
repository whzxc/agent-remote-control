# ChatGPT Chat + 本机 Codex

[English](../../guides/chatgpt.md) | **简体中文**

在 Chat 模式用 GPT-6 Astra Pro 深度推理，再让本机 Codex 实现方案。ARC 让 Chat 先读取当前项目事实，再决定如何派发工作。

先调用 `guide` 读取当前入口的编排指南、可用 op 和调用示例；`guide({"op":"codex_create"})` 可查看完整参数。所有操作通过 `query({"op":"…","args":{…}})` 或 `act({"op":"…","args":{…}})` 调用；结果中的 `arcVersion` 变化时重新读取 `guide`。

## 选择 Chat 模型

使用已开放 Chat Pro 选项的 ChatGPT Pro、Business 或 Enterprise 账号。在 Chat 的模型或思考档位中选择 GPT-6 Astra Pro（也可能显示为由 Astra 驱动的 GPT-6 Pro）。先确认自己的账号能选择该选项，再将其用于工作流程。

Codex 提供普通 `gpt-6-astra`，其模型列表没有独立的 Astra Pro 选项。Chat 的推理模型和 Codex 的执行模型分别选择。ARC 转发任务模型设置，不会把 Chat 模型加入 Codex。当前 Codex 选择见 OpenAI [模型指南](https://learn.chatgpt.com/docs/models)。

## 使用 OpenAI Secure Tunnel

1. 安装 ARC，并登录 Codex Desktop。
2. 按官方 [Secure MCP Tunnel 流程](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)取得 Tunnel ID 和运行时 API key，直接填入 ARC 的 **ChatGPT** 连接表单。
3. 保存并连接。ARC 会准备和管理官方 Tunnel Client。
4. 在 ChatGPT 开启可用的 **Developer Mode**。打开[插件](https://chatgpt.com/plugins)，创建开发者连接，选择 **Tunnel**，选中同一个 Tunnel。界面名称不同时，按当前[连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)操作。
5. 在 Chat 对话启用 ARC。执行 ARC 显示的验证提示词，通过该入口的 code 调用 `act connector_verify`。

Tunnel 创建和使用权限属于 OpenAI Platform 组织，Developer Mode 属于 ChatGPT 工作区。缺少哪一项，就请对应管理员开放。凭据填在本机表单或受保护的 CLI stdin，不粘贴到对话中。

## Chat 负责推理，Codex 负责执行

> 通过 ARC 阅读这个项目的当前文件、Git 状态和近期 Codex 任务。比较可选方案，给出计划与验收标准。我们确定后，用新 requestId 派给 Codex，保留返回的任务 ID。

新任务使用 `act codex_create`，下一轮使用 `act codex_send`，进度使用 `query codex_wait`。超时后保留 threadId/turnId，并把上次 snapshotHash 作为 expectedHash 继续等待。让 Chat 审查 `query codex_changes` 和最终输出，再决定下一步。

让本机 Agent 协助时，查看[自动配置](../auto-setup.md)。HTTPS + OAuth 替代方案见[连接指南](connections.md)。

Agent 配置默认直接尝试 Tunnel；runtime key 来自 [Platform Runtime API keys](https://platform.openai.com/settings/organization/api-keys)，需具备目标 Tunnel 的 Read + Use 权限，创建 Tunnel 另需 Read + Manage。ARC 观察到控制面认证成功才报告就绪；401/403 会退回凭据步骤。

实际遇到 Tunnel 权限失败时，Agent 配置提供 HTTPS + OAuth 备选，复用 Cloudflare 固定地址或临时地址及 OAuth 步骤，保持 ChatGPT 目标。HTTPS 不能绕过工作区对自定义 MCP 的限制。

## 限制

模型选项和 Developer Mode 取决于账号、工作区策略及客户端开放情况。电脑需保持唤醒，ARC 需保持连接。普通 Chat 不接收 ARC 的 Claude 云端会话通知；可回到对话询问进度，或在当前轮次内继续等待。Secure Tunnel 用于连接私有 MCP，公开插件发布另有分发流程。

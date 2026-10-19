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
3. 保存并连接。ARC 会准备和管理官方 Tunnel Client；优先复用合格缓存，没有合格缓存时直接下载支持的官方版本并校验 SHA256，不依赖匿名 GitHub API。
4. 在 ChatGPT 开启可用的 **Developer Mode**。打开[插件](https://chatgpt.com/plugins)，创建开发者连接，选择 **Tunnel**，选中同一个 Tunnel。界面名称不同时，按当前[连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)操作。
5. 在 Chat 对话启用 ARC。执行 ARC 显示的验证提示词，通过该入口的 code 调用 `act connector_verify`。

Tunnel 创建和使用权限属于 OpenAI Platform 组织，Developer Mode 属于 ChatGPT 工作区。缺少哪一项，就请对应管理员开放。凭据填在本机表单或受保护的 CLI stdin，不粘贴到对话中。

## Chat 负责推理，Codex 负责执行

> 通过 ARC 阅读这个项目的当前文件、Git 状态和近期 Codex 任务。比较可选方案，给出计划与验收标准。我们确定后，用新 requestId 派给 Codex，保留返回的任务 ID。

新任务使用 `act codex_create`，下一轮使用 `act codex_send`，进度使用 `query codex_wait`。超时后保留 threadId/turnId，并把上次 snapshotHash 作为 expectedHash 继续等待。让 Chat 审查 `query codex_changes` 和最终输出，再决定下一步。

让本机 Agent 协助时，查看[自动配置](../auto-setup.md)。HTTPS + OAuth 替代方案见[连接指南](connections.md)。

Agent 配置默认直接尝试 Tunnel；runtime key 来自 [Platform Runtime API keys](https://platform.openai.com/settings/organization/api-keys)，需具备目标 Tunnel 的 Read + Use 权限，创建 Tunnel 另需 Read + Manage。ARC 观察到控制面认证成功才报告就绪；401/403 会退回凭据步骤。

实际遇到 Tunnel 权限失败时，Agent 配置提供 HTTPS + OAuth 备选，复用 Cloudflare 固定地址或临时地址及 OAuth 步骤，保持 ChatGPT 目标。HTTPS 不能绕过工作区对自定义 MCP 的限制。

## 在 Work 中订阅

需要主动唤醒时，使用网页 Work 聊天，或在桌面选择 **Work → Cloud**。重新扫描 ARC 插件，确认工具旁出现 `task.status`；工作区有相关限制时，启用插件事件及事件触发任务。

启用插件事件后，新建 Work Cloud 聊天。让聊天订阅 `task.status`，按派发后的 `threadId` 过滤，收到事件后读取结果并审查，再决定续轮。Desktop 创建任务必须带文本。可能在订阅前完成的短任务，先不带过滤条件订阅，再派发并将监控范围缩小至返回的线程。其他 Agent 使用 `taskId`。不传过滤条件时，订阅覆盖该入口派发的任务。回调地址与签名密钥由聊天提供，不要把凭据粘贴到消息中。让聊天停止监控即可取消订阅。

使用 `query notify_status` 查看订阅与投递。`callback-accepted` 只表示回调已接收；还需确认 Work 聊天自动开启一轮并处理事件。写操作仍受 ChatGPT 确认及既有入口策略限制。

## 限制

模型选项和 Developer Mode 取决于账号、工作区策略及客户端开放情况。电脑需保持唤醒，ARC 需保持连接。普通 Chat 不支持主动唤醒：使用分段等待加收件箱，或回来询问进度。Work 订阅到期需刷新，不回放错过的事件。Secure Tunnel 用于连接私有 MCP，公开插件发布另有分发流程。

回调域名必须解析到真实公网地址。Fake-IP DNS 可能触发 `non_public_address`；应为回调域名配置真实 DNS，不放宽回调地址校验。诊断日志只记录被拒绝的域名及解析地址，不记录回调路径和签名密钥。

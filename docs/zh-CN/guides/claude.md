# Claude + Codex：建立协作闭环

[English](../../guides/claude.md) | **简体中文**

让 Claude 阅读项目、与你确定方案，再交给本机 Codex 实现。ARC 把状态送回发起任务的 Claude Code 云端会话，让 Claude 接着审查和推进。

先调用 `guide` 读取当前入口的编排指南、可用 op 和调用示例；`guide({"op":"codex_create"})` 可查看完整参数。所有操作通过 `query({"op":"…","args":{…}})` 或 `act({"op":"…","args":{…}})` 调用；结果中的 `arcVersion` 变化时重新读取 `guide`。

## 准备

- 在执行电脑安装 ARC，并登录 Codex Desktop。
- 在同一电脑安装并登录 Claude Code CLI；回访通过它的云端消息命令送达。
- Claude 账号或工作区需要能添加自定义连接器。
- 在 claude.ai 打开 Claude Code 云端会话。Claude 可以从自身环境读取会话 ID，例如 `CLAUDE_CODE_REMOTE_SDK_URL` 中的 `cse_…`，将自己绑定为通知目标。

若 Claude 无法读取自身 ID，再手动粘贴云端会话 URL 或 ID。

Claude 网页、手机和桌面均可使用远程连接器。尚未安装 ARC 时，先看[上手](../getting-started.md)。

## 通过 HTTPS 和 OAuth 连接

1. 在 ARC 添加 **Claude**，保留 **HTTPS** 和 **OAuth**。
2. 选择[提供商](connections.md)。首次可用 Cloudflare 临时域名，日常工作使用固定 HTTPS 地址。
3. 保存并连接，复制生成的 `/mcp` URL。
4. 在 Claude 添加自定义连接器，填入 URL，发起 OAuth 授权。
5. 保持网页授权页打开，点击**打开 ARC**，在本机应用核对目标连接和回调地址，再允许请求。回到授权页完成跳转。
6. 在 Claude 启用连接器，执行连接的验证提示词。

浏览器位于另一台设备时，在执行电脑的 ARC 中同意。本机 Agent 也可以通过已认证的 [OAuth CLI](../../reference/oauth.md#local-management)处理。自定义反向代理需同时转发 OAuth 路由和 `/mcp`。

Claude 的[连接器文档](https://claude.com/docs/connectors/building)说明远程 MCP 和客户端注册流程。ARC 提供 OAuth 服务和本机同意，无需授权密码。

## 从实时事实开始

> 通过 ARC 阅读这个项目的文件、Git 状态和近期 Codex 任务。说明当前实现，提出完整满足需求的最小改动，先和我确定验收标准，再派发任务。

提供项目名称或绝对目录。确定方案后，派出一轮明确工作：

> 让 Codex 在该项目实现约定的改动，运行已有检查。使用新 requestId，设置 notify 为 {channel: "claude-session", target: 你自己的 Claude Code 云端会话 ID 或 URL}。保留返回的 threadId 和 turnId。收到通知后读取任务，按验收标准审查改动。

调用 `act`，op 为 `codex_create`；将 `project`、`prompt`、`notify` 放入 args，requestId 放在外层。保留回执和任务 ID。需要立即检查进度时使用 `query codex_wait`；超时后沿用原 ID，把返回的 snapshotHash 作为 expectedHash 继续等待。

## 接收、审查、继续

派发后 Claude 可以直接结束本轮。Codex 完成时，通知会唤醒同一 Claude Code 云端会话，让它审查改动并继续。

绑定的轮次完成、失败、中断或等待审批/输入时，ARC 发送固定状态消息，标明项目、任务和轮次。Claude 随后通过 `query codex_read` / `query codex_items` 读取实际输出，通过 `query codex_changes` 或 `query git` 审查改动。

让 Claude 对照验收标准判断结果，说明剩余问题，再用 `act codex_send` 派出下一轮。每个新轮次都带上 `notify`。向当前轮次追加输入时，省略此字段会保留绑定；传 `null` 可解除绑定。被中断轮次紧接的续轮可以继承绑定，显式绑定或解除优先。

任务结果的 `notification` 显示投递状态。绑定失败会在派发回执中标为 `bind-failed`。投递失败时查看**记录**；ARC 会退避重试，熔断或持续缺令牌时尝试一次系统通知升级。

## 推荐工作方式

先约定范围、已有检查和哪些操作需要你决定。让 Claude 读完仓库再规划，每轮给 Codex 明确任务，审查 diff 后再继续。保留审批和提问，通过原任务的交互入口回答。电脑保持可用时，你可以在手机继续跟进。

通知的健康摘要只提供计数。发现异常先用 `query notify_status` 查看桶、积压、近期批次和线程归属；需要时用 `codex_send` 要求 Agent 合并问题或在既有授权内自行决定。`act notify_control` 可静音线程、改为小时摘要、改绑/解绑或对目标熔断，也可撤销这些控制。详情见[工具参考](../reference/tools.md#control-source-notifications)。

## 限制

自动回访需要 Claude Code 云端会话，以及支持云端消息且已登录的本机 CLI；普通 `claude.ai/chat/…` 链接不能作为目标。待投递事件跨重启保留，不确定发送沿用同一 eventId 重试；重复 ID 跳过。needs-input 通知携带问题、选项或审批详情。使用通知的 respond 参数补入 result 直接回复；参数缺失或过期时再用 codex_pending 刷新该线程；异步问题传 result: {answer: "答案"}。按 canRespond 和 next 行动，不支持的交互需回 Desktop。完成通知携带最后消息原文，截断时附全文查询；完整 diff 按需读取审查；云端会话也需具备继续执行的条件。ARC、连接和电脑需保持运行。

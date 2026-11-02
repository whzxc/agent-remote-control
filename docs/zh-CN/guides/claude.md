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

## 使用多个 Claude 账号

打开**设置 → Claude 账号**，在**登录 Claude**旁选择浏览器，分别授权新增账号。ARC 将每个登录保存在独立目录中，并将设备原有的系统 CLI 登录保留为一份隔离账号。**系统默认**标签表示该账号与当前系统 CLI 登录一致。系统 CLI 切换账号后，点击**导入系统登录**可再保留一份；已保存的通知路由仍使用原来选择的账号。

在目标账号旁选择**通知**，填写接收对话的 `cse_…` 或 `session_…` ID，点击**保存账号路由**。此操作保存手动通知和新增控制源绑定使用的设备路由；已绑定控制源使用各自保存的账号路由。**发送通知**只尝试发送一次，并为尚未配置的目标保存路由；已有其他账号配置时需要显式修改。发送结果不确定时，先检查接收对话，再决定是否重发。

Claude 可以调用 `notify_control({action:"bind",target})` 绑定自己的通知目标。目标尚未分配账号、且只有一个账号被确认能访问该会话时，ARC 会记录该账号。返回 `ACCOUNT_SELECTION_REQUIRED` 时，Claude 可以用 `notify_control({action:"route",target})` 查看账号列表，再通过同一动作传入 `accountId` 完成选择。列表只包含身份信息。选择路由不会登录或切换系统 Claude 账号。修改路由后，需要在接收对话中重新接收验证码并确认。

普通 Claude Chat 已有工作区会话时，也可以接收 CLI 通知。使用它的 `workspace_session_id`，不要使用 `/chat/…` 链接中的 UUID。新建 Chat 可能尚无工作区；使用 Claude 云端代码执行可以初始化工作区，取得并确认 ID 后再配置路由。

## 通过远程链接连接

欢迎页选择**在手机和网页上**，再选 **Claude**。之后可从**远程链接 → 添加控制源**进入。选择连接，或通过**添加连接**完成方式 → 配置 → 就绪，返回时新连接会自动选中。

在配置步骤复制地址，填入 Claude 的**设置 → 连接器 → 添加自定义连接器**并连接。在批准步骤核对四位配对码、客户端和权限，填写账号名称；如提供已有来源，可选择**重新授权**保留其历史。批准后返回 Claude，再完成 ARC 成功页。

本地使用时，在欢迎页选择**在这台电脑上**，再选 **Claude Code** 或 **Claude 桌面版**。选择本地连接，或通过添加连接安装，然后重启客户端；无需配对码批准。

迁移已有来源时，打开来源详情并选择**更换连接**。先在 ARC 选择目标，再在 Claude 删除旧 ARC 连接器，用新地址重新添加；客户端支持编辑 URL 时也可直接修改。回到 ARC 核对配对码和**认领为「账号名称」**并批准。名称、历史和通知设置保留，新授权完成后旧授权才会撤销。

在**远程链接 → 连接**查看地址、使用该连接的来源及移除操作。中继拥有者在**设置胶囊 → 中继托管**（先在**设置 → 关于 → 实验性功能**中启用）管理邀请和设备。连接方式和中继信任边界见[连接指南](connections.md)。

## 从实时事实开始

> 通过 ARC 阅读这个项目的文件、Git 状态和近期 Codex 任务。说明当前实现，提出完整满足需求的最小改动，先和我确定验收标准，再派发任务。

提供项目名称或绝对目录。确定方案后，派出一轮明确工作：

> 让 Codex 在该项目实现约定的改动，运行已有检查。使用新 requestId，设置 notify 为 {channel: "claude-session", target: 你自己的 Claude Code 云端会话 ID 或 URL}。保留返回的 threadId 和 turnId。收到通知后读取任务，按验收标准审查改动。

调用 `act`，op 为 `codex_create`；将 `project`、`prompt`、`notify` 放入 args，requestId 放在外层。保留回执和任务 ID。需要立即检查进度时使用 `query codex_wait`；超时后沿用原 ID，把返回的 snapshotHash 作为 expectedHash 继续等待。

## 接收、审查、继续

绑定新会话后查询 `notify_status({target})`。`unverified` 表示尚未确认收到消息，`failed` 表示投递失败或握手过期。订阅 active、令牌充足都不证明可达。

调用 `notify_control({action:"verify",target})`，ARC 会向该会话发送一次性验证码；Claude 收到后须在五分钟内调用 `notification_ack({target,code})`。只有 `verified` 且投递可用时才可结束回合等待通知。本机 Claude Code 登录须能访问该云端会话。

未验证、失败或未绑定时，使用回执中的等待参数。如果 Claude 能安排稍后回到本会话，就按匹配历史耗时给出的 `next.revisitAfterMinutes` 回访；无样本不建议分钟数。仅短任务在回合内分段等待。Claude 每次等待最多 170000 ms，超时按 `next` 续等。

绑定的轮次完成、失败、中断或等待审批/输入时，ARC 发送固定状态消息，标明项目、任务和轮次。Claude 随后通过 `query codex_read` / `query codex_items` 读取实际输出，通过 `query codex_changes` 或 `query git` 审查改动。

让 Claude 对照验收标准判断结果，说明剩余问题，再用 `act codex_send` 派出下一轮。每个新轮次都带上 `notify`。向当前轮次追加输入时，省略此字段会保留绑定；传 `null` 可解除绑定。失败/中断轮次之后紧接的、可确认的原生 Codex 重试可在十分钟内继承绑定，显式绑定或解除优先。ARC 会补记该重试以供审查。Desktop 新消息和来源无法确认的重试不继承。

任务结果的 `notification` 显示投递状态。绑定失败会在派发回执中标为 `bind-failed`。投递失败时查看**记录**；ARC 会退避重试，熔断或持续缺令牌时尝试一次系统通知升级。

## 推荐工作方式

先约定范围、已有检查和哪些操作需要你决定。让 Claude 读完仓库再规划，每轮给 Codex 明确任务，审查 diff 后再继续。保留审批和提问，通过原任务的交互入口回答。电脑保持可用时，你可以在手机继续跟进。

通知的健康摘要只提供计数。发现异常先用 `query notify_status` 查看桶、积压、近期批次和线程归属；需要时用 `codex_send` 要求 Agent 合并问题或在既有授权内自行决定。`act notify_control` 可静音线程、改为小时摘要、改绑/解绑或对目标熔断，也可撤销这些控制。详情见[工具参考](../../reference/tools.md#control-source-notifications)。

## 限制

- 导入复制的是现有 OAuth 授权；独立存储不会创建新的服务端授权。若服务端撤销或轮换该授权，需要为对应账号重新登录。

自动回访需要云端会话或已有工作区会话的 Claude Chat，以及支持云端消息且已登录的本机 CLI；普通 `claude.ai/chat/…` 链接不能作为目标。待投递事件跨重启保留，不确定发送沿用同一 eventId 重试；重复 ID 跳过。needs-input 通知携带问题、选项或审批详情。使用通知的 respond 参数补入 result 直接回复；参数缺失或过期时再用 codex_pending 刷新该线程；异步问题传 result: {answer: "答案"}。按 canRespond 和 next 行动，不支持的交互需回 Desktop。完成通知携带最后消息原文，截断时附全文查询；完整 diff 按需读取审查；云端会话也需具备继续执行的条件。ARC、连接和电脑需保持运行。

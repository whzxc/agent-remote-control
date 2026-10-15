# 用 Codex 配置 Local Connector

[English](../codex-setup.md) | **简体中文**

本文用于配置**远程入口**。本机 ChatGPT Desktop 插件请使用[插件安装指南](plugin.md)，该路径无需申请 Tunnel 凭据或执行远程入口验证码流程。

在目标电脑使用应用自带 CLI，先读 `cli help`、`cli status`、`cli ingress list`。ChatGPT 默认推荐 OpenAI Secure Tunnel；保留已有入口，新增入口不覆盖默认连接。完整配置任务包含真实控制源入站与无害任务终态验证。

macOS 通常使用 `/Applications/Local Connector.app/Contents/MacOS/local-connector-desktop cli help`；Windows 使用安装目录中的 `local-connector-desktop.exe cli help`。无需 Node/npm。help、guide、capabilities、schema、ingress presets 和 logs --offline 无需运行 Core；`cli app start` 可以启动安装版，本机管理 MCP 也支持离线发现和启动。其他操作按所属 Core/Desktop 报告可用状态。成功输出 `{schemaVersion:1,ok:true,result:...}`，失败输出 `{schemaVersion:1,ok:false,error:{code,message}}`；退出码分别为 0、1。诊断成功不等于每个入口已经 ready。

## CLI 配置与生命周期

- `ingress presets`：离线查看 9 个精选控制源、推荐 transport/auth 与支持边界。
- `ingress list`：每入口脱敏配置、URL、运行状态、日志和验证。
- `ingress add --stdin`：JSON 新建入口。
- `ingress update <id> --stdin`：局部更新，config 按字段合并；先停止目标入口。
- `ingress remove <id>`：停止并删除目标入口，保留任务和其他入口。
- `ingress start <id>` / `ingress stop <id>`：独立启停。
- `ingress start-all` / `ingress stop-all`：批量操作；start 跳过 enabled=false，每个结果独立报告。
- `ingress token rotate <id>`：停止后轮换 bearer；新密钥仅此次 stdout 返回，重置该入口验证。
- `ingress oauth list <id>`：查看待处理请求、授权客户端与密码设置状态。
- `ingress oauth decision <id> --stdin`：Agent 经本机已认证通道确认或拒绝，输入 `{"id":"请求 ID","allow":true}`（拒绝为 false）。先核对客户端、回调和入口；网页自动回读并跳转。
- `ingress oauth request <id> <request-id>`：回读 pending/approved/denied/completed/expired；completed 仅证明客户端完成换码，不代表任务验收。
- `ingress doctor <id>`：查看该入口配置、状态和接入指引。
- `ingress verify <id> --fresh`：只重置该入口验证码；不带 --fresh 回读现有验证。
- `status` / `doctor` / `onboarding`：全局摘要及多入口 JSON。
- `network --stdin`：设置全局 proxyMode/proxyUrl；现有进程需重连生效。
- `configure --stdin`、`connect`、`disconnect`：默认入口的简化操作，不影响其他入口。
- `verify` 读取全部入口；`verify --fresh` 明确重置全部入口。

新增必填 controlSource、transport、auth、config。name 默认预设名称或未知标签，重名自动追加数字，enabled 默认 true，toolPolicy 默认使用默认档 allowlist；id 可省略自动生成，不能修改。id 只允许 ASCII 字母、数字、连字符、下划线。controlSource 是标签，不是已认证用户。

transport 为 `openai-tunnel` 时 auth 为 `openai`；HTTPS 支持 `none`、`bearer` 或 `oauth`。bearerToken 至少 32 个可打印 ASCII 字符，每入口独立，通过 stdin 输入。OAuth 使用本机授权服务、PKCE，并支持动态注册或本机预注册，详见[OAuth 认证](../oauth.md)。toolPolicy 为 `"all"` 或 `{"allowlist":["connector_verify","agents","agent_create","receipt","agent_read","agent_send","agent_wait","control_output"]}`；tools/list 和 tools/call 同时执行限制。允许任务工具即允许访问共享任务，不按来源隔离；也不细分单个工具中的原生方法权限。

完整字段与 provider 选项见 `cli help` 和[英文配置示例](../codex-setup.md#configuration-examples)。凭据只能来自授权的安全本机来源并经 stdin 传递，不放在命令参数、shell 字面量、聊天、日志或截图中。轮换前先准备受保护的本机输出文件，例如设置 `umask 077` 并重定向 stdout，不让模型读取密钥输出。使用客户端支持的安全凭据输入完成交付。不要拿管理 API token、OpenAI key 或 provider token 代替 ingress bearer。

## 订阅与浮窗

- `subscriptions get`：只读内存快照，不触发刷新。
- `subscriptions set --stdin`：**完整替换设置**。先取 `result.settings`，保留需要的 `enabled`、`refreshMinutes`、`providers`、`pinnedWindows` 后提交完整对象，不做部分合并。
- `subscriptions refresh [providerId]`：真实读取已选且有资格的来源；省略 ID 处理所有这些来源。`accepted` 和 revision 不代表新读数成功，之后 get 核对 `observedAt`、`state`、`error`。
- `subscriptions open [providerId]`：打开目标实例的 Agent 详情面板，可定位快照中的合法来源；省略 ID 打开 Agents 列表。
- `panel get`：分别返回保存的 `preferences` 和主线程读取的 `runtime`，不创建或显示浮窗。
- `panel set --stdin`：部分更新 help 所列外观/位置字段，可组合设置。`resetPosition:true` 只恢复位置，在同一更新中优先于 `dock`。

例如将 `CLC_APP` 设为已安装可执行文件后：

```sh
"$CLC_APP" cli subscriptions get
printf '%s' '{"dock":"top","size":"large","ends":"round"}' | "$CLC_APP" cli panel set --stdin
"$CLC_APP" cli panel get
"$CLC_APP" cli subscriptions open codex
```

写回执的 `saved:true` 表示已保存；`application` 为 `saved`（无原生浮窗或平台不支持）、`deferred`（等待当前手势/菜单结束）或 `controller-applied`。这些都不证明像素呈现或动画完成。运行态区分 `not-created`、`hidden`、`visible`、`unsupported`，无窗口时不返回虚构 frame。`expanded` 是控制器目标；`acceptedGeometry.matches` 只表示收到匹配该代的几何。frame 使用左下原点的 AppKit 屏幕逻辑点。后续再 get 观察，不提供渲染屏障或输入模拟。Windows 可保存偏好，但原生运行态为 unsupported。目标离线会失败，不另启核心；桌面写入超时后先回读再决定是否重试。沿用本机鉴权、实例核对及更新安装期间的写入拦截。

## 配置示例

ChatGPT：`controlSource=chatgpt`、`transport=openai-tunnel`、`auth=openai`；config 中填写官方 tunnelId 和 apiKey。保留官方身份申请、工作区关联及客户端接入流程。

Notion：创建独立的 `transport=https`、`auth=bearer`、`httpsProvider=ngrok` 入口。提供 ngrokAuthtoken 和独立 bearerToken；启动后读取 ngrok 返回的可用 MCP URL。ngrok 自动使用独立 loopback 端口。

Cursor：创建独立的 `transport=https`、`auth=bearer`、`httpsProvider=cloudflare`、`cloudflareMode=named` 入口。配置 cloudflareToken、httpsUrl、httpsPort；例如 httpsPort=8788，对应 Cloudflare 服务端路由 `http://127.0.0.1:8788`。每个 Fixed 入口使用不同端口和 Tunnel 身份，不将不同认证上下文用同一身份做负载均衡。

Cloudflare token 模式路由保存在服务端，CLC 不用 token 改写路由。Quick 模式自动分配临时地址，仅用于试用；长期入口优先固定地址加认证。Custom Domain 使用 httpsHost/httpsPort 接收自管 TLS 反向代理请求。不要公开桌面管理端口。

先查看[控制源矩阵](control-sources.md)。Slackbot 不支持静态 Bearer，可使用通过本机应用或已认证 CLI 确认的 OAuth；不要自动降级。Claude 组织静态请求头 Beta 与 Copilot Studio API-key Header 是有条件的 Bearer 路径；OAuth 是独立选项。CLI help、ingress presets（离线）、list 和 onboarding 均提供 preset metadata。不能把本机探针成功报告为官方客户端已接入。

## 完整执行流程

“给 Notion 加一个 ngrok + bearer 入口”：检查现有入口 → 准备安全本机凭据 → stdin 创建 → 启动该 id → doctor 回读 ready 和公网 URL → 在支持的客户端安全配置 URL 与 bearer → 独立验证。账号额度、固定域名权限或 provider 并发限制必须按实际错误说明，不自动覆盖其他入口或悄悄降级为临时地址。

执行 `ingress verify <id> --fresh`，从真实控制源调用 connector_verify，回读同一入口的 challengeVerifiedAt、ingressId、controlSource。普通调用只更新历史 verifiedAt；本机直接调用只能证明本机链路。恢复中断的验证用原验证码，不重置其他入口。

完整验收继续创建无害任务：不使用工具、不读写文件，只回复 CLC_ONBOARDING_OK。每次新操作用唯一 requestId，回读持久回执、taskId/threadId、turnId 和 agent_wait/codex_wait 终态输出。未知状态回读原 requestId，不重复提交。允许的另一入口能读取、续接、等待同一 taskId；停止创建入口不终止 Agent。

用户提供已登录浏览器时，实际使用可见受支持界面配置和验证；未指定浏览器优先 in-app Browser。只在登录、身份授权、验证码、权限或无法可靠操作时交还精确步骤；不提取 Cookie、不调用私有接口。

## 边界

none 允许所有可达调用方调用已授权工具。bearer 只证明持有凭据；task namespace 全局共享，没有用户/组织 RBAC。OAuth 支持 PKCE、DCR 或预注册、本机应用确认或已认证 CLI 确认、刷新与撤销；不实现 Slack Identity、Notion API 或消息编排。listener 不提前截断 300 秒等待；外部代理和服务商限制需另行核对。重复短等待可沿用 taskId，超时不停止任务。

入口失败只影响自身。先读该入口错误与脱敏日志。停止入口只释放其进程、listener 和临时资源；退出 Core 才关闭 AgentHost/Control，Desktop-owned 任务沿用 Desktop 生命周期。UI 仅展示入口数量和每入口一行状态及基本动作，主要配置通过 CLI 完成。

## 监控任务

Codex 在 create/send 后从回执取得原 taskId/threadId、turnId，默认以 30 秒（建议 20–30 秒）一个 slice 调用 agent_wait/codex_wait。收到 timeout 后保留原 ID，将上一轮 snapshotHash 作为 expectedHash 再次 wait，直到 completed/failed/cancelled 或 interaction-required。timeout/取消 wait 只结束当前等待，不终止源任务，不应重新创建任务或重发 prompt；unconfirmed 不代表失败。expectedHash 只控制 changed 比较，不屏蔽终态或交互。

这是 bounded event-driven long poll；每个 slice 内仍由事件唤醒和真实 owner 状态复核驱动，不使用 read/sleep 高频轮询。ChatGPT、Notion、Slack 及其他 MCP Client 可能具有不同的外层工具超时，统一默认 timeoutMs=30000，不引入 per-client 配置。普通 Chat / 通用 MCP Client 不推荐默认阻塞数分钟。codex_wait 的 timeoutMs 上限为 90000，为远程网关留出余量；agent_wait 仍允许在上游支持时显式传 300000。OpenAI Tunnel stdio adapter 保留 330 秒转发预算，HTTPS MCP 没有更短的等待执行限时；CLC 无法延长外部客户端或代理的超时。

## 只读上下文与诊断

`cli context --stdin` 接收与 `agent_context` 相同的 JSON，例如 `{"agent":"pi","taskId":"<existing-task-id>","view":"handoff"}`。它使用经过认证的本机管理通道，保留 CLI JSON envelope，不写文件、不创建或恢复任务。运行中的应用需要包含此实现。

`status`、`doctor`、`ingress doctor <id>` 与 `onboarding` 共享结构化 `diagnostics.findings`，包含稳定代码、目标范围和建议的人工操作。`checks.execution.state=not_checked` 表示缺少执行验收证据；不能只根据旧字段 `executionVerified:false` 判定失败。入口 ready、认证已配置、真实入站已验证、任务执行已验证是不同观察。远端客户端无证据时仍为 unknown。诊断不重启、不旋转凭据、不重放未知写操作；应先回读原 requestId。全局诊断复用现有 Codex 任务回执读取，遇到 unconfirmed 时给出该原请求的读取入口；其他驱动回执未纳入此检查。

## Agent 管理入口

运行 `cli capabilities` 获取共享操作目录，`cli schema <operation>` 查看输入，`cli call <operation> --stdin` 调用；标识符放在对象顶层，参数放在 `body`。UI、CLI 与 `<应用可执行文件> cli mcp` 本机管理 MCP 共用 Core/Desktop 操作。MCP 提供 `connector_capabilities` 与 `connector_call`，管理权限不自动开放给公网入口。

目录覆盖应用启停与重启、更新检查/下载/安装/取消与状态、Agent 配置、审批、订阅、网络、面板、显示偏好、连接草稿和 OAuth。运行中的连接编辑、Token 轮换、重连由后端完整执行。`operations.submit` 使用唯一 requestId 提交长操作，`operations.get` 回读；重复 ID 不重放，中断结果为 unconfirmed，需读取原资源确认。

`logs.query` 支持入口、时间、级别、分页游标和保留范围；`cli logs --follow` 持续输出 JSON，`cli logs --offline` 在 Core 停止时读取磁盘日志，可重定向导出。`state.wait` 与 `cli watch` 等待状态变化或目标状态，超时不终止任务；游标代表当前快照，历史变化读取日志。`ingress.probe` 分别检查 DNS、边缘地址、Provider、公网 TLS/HTTP 和 OAuth 元数据，认证及执行证据独立报告。

完整参数、示例与结果语义见[英文管理说明](../codex-setup.md#agent-administration)。

## Claude 云端会话通知

`codex_create` 和 `codex_send` 支持可选参数 `notifyClaudeSession`，接受 Claude Code 云端会话 ID（`session_…`、`cse_…`）或 `claude.ai/code/<id>` URL。派发任务的 Claude 会话可传自己的 ID；本机 Claude CLI 需已通过 `claude auth login` 登录。

CLC 在派发成功后按真实 threadId + turnId 绑定，后台复用 Codex waiter 观察。通知仅包含项目目录名、线程 ID、轮次 ID，以及完成、失败、中断、等待审批或等待输入状态，不包含输出、错误原文、审批命令或自定义正文。交互通知后继续观察，终态再通知一次。新轮次不会继承旧绑定；引导同一轮次时省略参数会保留已有绑定，显式传入会话才替换目标，保留去重历史。

普通 `codex_read` 的 `turns[].claudeNotification` 返回 `sessionId` 和 `deliveries`（`state`、`status`），未绑定时为 null。`statusOnly` 不返回轮次详情。投递状态为 `sending`、`delivered` 或 `failed`。

绑定与去重记录以私有 JSON 文件保存于 CLC 状态目录下的 `claude-notifications/`，文件名为线程与轮次组合的哈希；`CLC_STATE_DIR` 可覆盖状态目录。Core 启动时恢复观察。CLI 定位复用 Agent 可执行文件搜索，覆盖 PATH、用户本地安装、Homebrew、npm 与版本管理器目录。以参数数组投递，超时 30 秒，仅 `ok:true` 且 session ID 匹配视为成功。失败或结果不明时发 macOS 系统通知，不自动重试。投递中断后重启会标为失败，不重发，因此避免重复优先于保证送达。系统通知受 macOS 权限和通知设置影响；其他平台保留失败状态但没有系统通知兜底。

绑定失败不影响已派发任务成功，回执附带 `claudeNotification: "bind-failed"` 并记录 WARN。记录从创建起保留 7 天，超过期限后删除并停止观察，不论是否已终态。CLI 投递与系统通知均不占用绑定锁。

# 工具与运行语义

返回[项目首页](../README.md)。

## 工具档位

新增连接使用默认档，保存为现有 allowlist；选择“全部”或“自定义”可开启高级工具。显式保存的全部列表随注册表更新，自定义列表保持精确选择。tools/list 和 tools/call 同时执行策略；管理界面显示完整注册表、高级标记及本机可用性。加载时剔除持久列表中已不在注册表的名称，不自动扩展授权；重新选择预设或保存自定义选择会补齐当前依赖。

| 档位 | 工具 |
| --- | --- |
| 默认，23 个 | connector_verify、projects、overview、tree、search、read、git、edit、write、command、logs、control_output、receipt、codex_create、codex_send、codex_read、codex_items、codex_wait、codex_interrupt、codex_tasks、codex_pending、codex_respond、codex_changes |
| 高级，12 个 | git_write、file_search、fs、process、mcp、codex_call、codex_query、codex_schema、codex_events、codex_thread、codex_account、codex_capabilities |
| 条件默认，12 个 | agents、agent_capabilities、agent_tasks、agent_create、agent_read、agent_context、agent_wait、agent_send、agent_interrupt、agent_events、agent_pending、agent_respond |

Codex 统一使用 codex_*。只有发现已安装、可用且启用的非 Codex Agent 时，条件组才出现在 tools/list 并接受调用；agent_* 必须显式提供非 Codex agent ID。发现结果有短期缓存；本机 Agents 刷新会刷新发现信息。完整注册表共 47 个工具；默认实际暴露 23 或 35 个，高级工具需显式开启。

read/tree/search 支持绝对路径；绝对文件或目录可省 project，相对路径必须提供项目 ID、唯一名称或绝对项目目录。read 返回文件元数据，tree 返回目录及条目元数据（类型、大小、只读状态和可用的创建/修改时间）。read 文本按行分页，图片返回 MCP image；tree/search 用 nextOffset。Git revision 读取需指定 project。默认遵循原有访问边界，view=review 仍执行其资源边界。

fs 仅用于原生写入和监听。process 与 mcp 是低频进程控制及 downstream MCP 管理；file_search 是模糊文件查找，日常固定字符串搜索使用 search。codex_query 不包含 fs/* 快捷枚举，需要原生文件读取协议时可用 codex_call。

## 文本写入

```text
edit {"path":"/absolute/project/file.txt","edits":[{"oldText":"before","newText":"after"}],"expectedHash":"<sha256>"}
write {"path":"/absolute/project/new.txt","content":"hello\n"}
```

edit 依次在内存中应用 edits。oldText 不可为空，未找到或匹配多处且未设 replaceAll 时整次失败，不写入任何修改。全部成功后以同目录临时文件原子替换，保留已有文件权限；write 创建父目录并创建或覆盖 UTF-8 文件。expectedHash 校验已有内容，文件缺失或哈希不符时失败。返回新 sha256 与去除共同前后缀后的改动行段摘要。检测到同项目活动 Codex 任务时返回提示，不阻止写入；活动状态无法核实时明确报告。

## 轮次改动

codex_changes 接收 threadId、可选 turnId（默认最近一轮）、limit，以及可选 path/offset/length。Agent Remote Control（ARC） 提交新轮次前记录目录 HEAD 和 dirty，Desktop 与后台提交共用此记录；steer 保留同一轮次起点。返回起点以来可达的新提交（sha、标题）、相对起点 HEAD 的当前 diff 文件及增删行统计，包含未跟踪文件。指定 path 时按 UTF-16 offset/length 分页返回 diff；未指定 path 时 offset/limit 分页提交。文件统计中的 null 增删行表示二进制或不可读取。

没有起点的历史或外部轮次、起点不可读或目录变化时，返回 fallback=true，退化为最近 limit 个提交和当前工作区相对 HEAD 的改动。已有 dirty 修改会包含在比较中，结果不宣称改动只属于该任务。查询反映当前工作区，不冻结终态文件快照。

## Agent Remote Control 日志

logs 读取保留的 Core 日志及已接入的 app-server stderr，按时间倒序。since 使用 RFC3339 时间，level 精确过滤，grep 是固定字符串；limit 控制页长，cursor 续页。日志沿用 7 天、16 MiB 保留策略；cursor 已过期时 gap=true。stderr 沿用现有采样限制。

## 领域 action 与最小示例

下表 action 按原生后缀命名，仅为常用入口省去固定前缀：

| 工具 | action → 原生方法 |
| --- | --- |
| fs | writeFile、createDirectory、remove、copy、watch、unwatch → fs/同名方法 |
| command | exec → command/exec；write、terminate、resize → command/exec/同名方法 |
| process | spawn、writeStdin、kill、resizePty → process/同名方法 |
| mcp | list → mcpServerStatus/list；resource/read、tool/call、oauth/login、event/stream/start、event/stream/stop → mcpServer/同名方法 |
| codex_thread | Schema 保留原生 action 定义；Desktop 任务的扩展操作返回 `DESKTOP_METHOD_UNSUPPORTED`，后台任务转发至其 App Server |
| codex_account | read、usage/read、rateLimits/read、workspaceMessages/read → account/同名方法 |
| file_search | 无 action → fuzzyFileSearch |

以下为 MCP 工具名和 JSON 参数示例；mutation 中的 requestId 每个新操作使用新 UUID：

```text
read {"path":"/absolute/example.txt"}
fs {"action":"writeFile","params":{"path":"/tmp/example.txt","dataBase64":"aGVsbG8K"},"requestId":"<UUID>"}
fs {"action":"watch","params":{"path":"/tmp/example.txt","watchId":"example-watch"},"requestId":"<UUID>"}
fs {"action":"unwatch","params":{"watchId":"example-watch"},"requestId":"<UUID>"}
file_search {"query":"connector","roots":["/absolute/project"]}
command {"action":"exec","params":{"command":["pwd"],"cwd":"/tmp","timeoutMs":10000},"requestId":"<UUID>"}
process {"action":"spawn","params":{"command":["cat"],"cwd":"/tmp","processHandle":"example-cat","streamStdin":true,"streamStdoutStderr":true},"requestId":"<UUID>"}
process {"action":"writeStdin","params":{"processHandle":"example-cat","deltaBase64":"aGVsbG8K","closeStdin":true},"requestId":"<UUID>"}
mcp {"action":"list","params":{}}
mcp {"action":"resource/read","params":{"server":"local","uri":"example://resource"}}
mcp {"action":"tool/call","params":{"server":"local","threadId":"<已有线程 ID>","tool":"inspect","arguments":{}},"requestId":"<UUID>"}
codex_account {"action":"read"}
codex_account {"action":"usage/read","params":{"threadId":"<线程 ID>"}}
codex_account {"action":"rateLimits/read"}
codex_account {"action":"workspaceMessages/read"}
```

fs 操作主机文件系统，不解析项目别名、不使用 tree/search 的 Git 文件列表；文件内容使用 base64。
remove 的 recursive/force、createDirectory 的 recursive 等默认值完全由原生决定。
watchId、processId、processHandle、MCP subscriptionId 属于当前 App Server 连接；重启后不重建。

command/exec 不创建 Codex thread/turn，使用 Codex sandboxPolicy 或 permissionProfile；省略时继承原生设置。
简单形态 `command {"cmd":"npm test","cwd":"/absolute/project","timeoutMs":60000}` 使用用户默认 shell（Unix 登录 shell；Windows COMSPEC），同步等待进程结果，返回 stdout、stderr、exitCode 和 durationMs。输出过长时 truncated=true，output.outputId 可通过 control_output 从 offset=0 续读完整 JSON。简单形态与 action/params 互斥。原生 action 形态保持默认 25 秒回执等待窗口，超时用 receipt 查询；简单命令默认执行超时 60 秒。
PTY 使用 tty:true 和 size:{rows,cols}；PTY、streamStdin、streamStdoutStderr 和后续控制都需要 processId。
command 的 disableTimeout 与 timeoutMs 互斥，disableOutputCap 与 outputBytesCap 互斥。

process/spawn 在 App Server 主机上运行，**不使用 Codex sandbox**，也不创建线程；它注册 processHandle 后即返回。
退出状态位于 process/exited，spawn 回执 completed 只表示启动 RPC 完成。cwd 必须为绝对路径；
timeoutMs/outputBytesCap 显式 null 禁用对应限制，省略时使用原生默认值。
两类执行的 env 都支持 null 删除继承变量，stdin 使用 deltaBase64；权限和参数冲突由上游判定。
领域工具顶层 timeoutMs 是 RPC 等待超时（写操作默认 24 小时、读操作默认 30 秒），与 params.timeoutMs 独立。

fs/changed、command/exec/outputDelta、process/outputDelta/exited、MCP 订阅通知共用 codex_events 游标缓冲，
无需另一个事件服务。流式字节按原生 base64 返回；流式输出不会自动补进原生最终结果。
此缓冲不是持久输出存储，超过 2000 条或 8 MiB，或连接重启会报告 gap/reset，无法从缓冲恢复已丢失的字节。

mcp 的 list 可携带 threadId 读取线程上下文中的目录；tool/call 与 event/stream/start 的 threadId 是原生必填，
使用已有线程，不隐式创建或续接线程。服务名、工具名、arguments、_meta 完整透传；下游不可用或不支持时返回原生错误。
oauth/login 返回原生登录结果，认证仍由原生完成；订阅启动/停止的 mutation 使用现有 requestId 回执。

当前支持的任务操作为创建、读取、续接、追加输入和中断。Desktop 任务的其他 `thread/`、`turn/` 扩展操作由连接器明确拒绝，需在 Desktop 中完成；原生 Schema 中存在某方法不代表 Agent Remote Control 支持调用。账号结果直接来自 App Server。

## 参数与默认行为

`codex_create` 的 project 接受 Codex 原生项目 ID、唯一名称或本机绝对目录；多目录项目需指定具体目录，也可以省略。
`thread` 透传 ThreadStartParams，`turn` 透传 TurnStartParams；`codex_send` 的 `resume` 仅对 Agent Remote Control 后台任务透传；Desktop 任务忽略该字段。`codex_call thread/resume` 对 Desktop 任务返回 resumed=false 与 desktop-resume-ignored，不在 Agent Remote Control app-server 加载任务。输入使用 `prompt` 或完整原生 `input` 数组；两者同时提供时 input 优先。
thread/turn 中的原生参数优先于便利字段；任务 ID 与 input 由顶层字段统一确定。

省略参数时使用原生宿主或已有任务设置。MCP 不强制 approvalPolicy=never、网络关闭、
限定写入根、恢复必须声明 mode，也不注入额外 developerInstructions。
model、effort、serviceTier、provider、permissions、sandboxPolicy、approvalPolicy、
collaborationMode、outputSchema、runtimeWorkspaceRoots、附件和其他原生参数由上游解释与校验。
模型目录仅用于发现，不由 MCP 额外阻止未列出的模型或档位。Desktop 新任务继承原生创建结果的模型；开轮前从 owner 获取设置，命中 4 秒内快照或 follow/wait 获取新快照。未显式提供 collaborationMode 时，显式 model/effort 同步到继承的协作模式设置；通过 owner 更新线程默认配置后再启动轮次，首轮与后续新轮次使用相同路径。无法读取 owner 设置时明确报错，不静默使用 Desktop 默认值。线程配置优先读取原生 latestThreadSettings，实际轮次配置读取持久化 turn context。

便利字段 mode 支持 read-only、workspace-write、danger-full-access。
显式使用前两种 mode 而省略 networkAccess 时，此便利预设关闭网络；完全省略 mode 时不覆盖
宿主权限。要精确控制权限，直接传 turn.sandboxPolicy 或 turn.permissions。
只有 networkAccess 而没有 mode/sandboxPolicy 不能形成完整原生权限对象，会明确返回参数错误。
活动轮次的原生 steer 只支持输入，配置新轮次可使用 turn/start。

```json
{"project":"/absolute/directory","title":"分析任务","prompt":"检查当前目录并汇报发现。","requestId":"<新 UUID>","thread":{"permissions":"read-only"}}
```

```json
{"method":"command/exec","params":{"command":["git","status","--short"],"cwd":"/absolute/directory"},"requestId":"<新 UUID>"}
```

原始 method 请求不会擅自补参数、改写方法、切换 owner 或创建替代任务。
`resolved` 标注 thread/start 响应，不能代替轮次实际配置；read 中的 effectiveConfiguration
从该任务已落盘 turn_context 读取，缺失时为 unknown。

## 文件和输出

项目列表唯一来源为当前设备 Core 的 `project/list`，完整读取分页并保留原生 ID、名称和全部 roots；不维护登记文件、别名或一分钟缓存，读取失败不回退旧数据。
仍支持直接指定本机绝对目录、非 Git 目录、隐藏文件、Git 忽略文件、任意扩展名以及符号链接和硬链接。
相对路径按 project 解析，绝对路径按宿主文件系统解析。不自动删改或脱敏返回内容。
访问范围由服务进程的系统权限决定；连接拥有者应按实际需要发起读取，不把凭据贴入对话。

tree/search 默认按 Git 工作文件列出以减少噪声，includeIgnored=true 包含忽略文件。
read 可直接读取被忽略文件；Git 内部数据或完整目录枚举可使用 fs/readDirectory。
Git revision 支持分支、标签、SHA 和表达式；diff 可省略 path 查询整个工作区。
文件事实附来源、时间与哈希，Git 状态不代表服务健康或已发布。

行读取使用 UTF-8 文本，单文件预算 16 MiB；二进制使用原生 fs/readFile 的 base64。
文本搜索按页扫描，nextOffset 非空时继续，skipped 报告无法读取的文件数量。
原生工具数据通过 codex_items 或原生 thread/items/list 读取，不固定省略工具输出。
MCP 单次请求帧预算 16 MiB；结果超过 64 KiB 自动保存并返回 outputId。
control_output 每页最多 12000 个 UTF-16 code units，拼接所有 text 后解析 JSON。
本机 outputs 目录中的大结果 JSON 快照保留 1 小时，共享 64 MiB 配额；启动和写入新快照时清理过期快照，并按最旧优先腾出空间。过期读取返回 OUTPUT_EXPIRED，已淘汰结果不可再读；单个快照超过配额或无法腾出空间返回 OUTPUT_STORAGE_LIMIT。读取采用有界内存解码，继续使用 UTF-16 偏移。
分页与帧预算用于传输和资源管理，不是业务权限。长输入也可以先 fs/writeFile 再引用原生输入路径。

## 交互、回执与生命周期

原生服务器请求通过显式回调交互处理。codex_pending 返回 id、method、params 和 backendSession；
先查看对应 server Schema，再通过 codex_respond 提交 result 或 JSON-RPC error（二选一）。
原生 result/error 透传上游校验。
服务不自动批准命令、不替用户填写决定，也不伪造认证令牌或 attestation。
如果某类回调需要调用方不具备的能力，应显式返回 error；不能把“有回传入口”理解为自动完成所有回调。
响应回执只证明已发出，是否接受须跟进原生事件和轮次。重启或已解决请求不能继续作答。

写工具的 requestId 可选；省略时服务端生成 UUID 并带回，需要安全重试时显式传入。参数按递归稳定排序摘要。同一 ID 重试只回读原回执；不同参数拒绝。领域 action 与等价 codex_call 共享同一原生回执。
原生 JSON-RPC 错误的 code/message/data 保留在 error.rpcError，写入失败时位于回执 result.error.rpcError；
未生成 RPC 错误的连接/超时失败仍使用现有控制错误。null、数组等原生结果不强制转换为对象。
磁盘回执保留执行记录。MCP 写调用和 receipt 查询只返回 requestId、state、operation、任务/轮次 ID、必要结果和错误；不回显 arguments、prompt、input、digest、origin、backendSession 或 resolved。交互响应需要的 backendSession 由 pending/wait 返回。pending 表示执行中或等待结果，只有 awaiting-approval 等待审批。
写操作默认同步等待 25000ms，waitMs 可设为 0–120000；超时返回 pending，随后用 receipt 回读。completed 表示操作完成；上游明确拒绝为 rejected，本地或其他已知失败为 failed，只有提交后连接中断/超时且结果未知为 unconfirmed。waitMs 不参与 requestId 的参数摘要。
写入原生 RPC 默认超时 24 小时，可通过 timeoutMs 指定；超时不等于操作取消，不自动重放。
completed 是控制操作完成，任务完成需要检查对应轮次终态。

桌面任务执行归 Desktop 所有，Agent Remote Control 通过本机版本化协调 IPC 管理，不接管其 app-server。
关闭「自动打开 Codex 任务」后，新任务归 Agent Remote Control 的 App Server 后台执行，读取、续接和中断按持久化的任务归属路由。后台任务不保证可在 Desktop 中操作。没有执行方实时状态时 runtimeStatus 为 unknown，不表示空闲。
桌面快照自接收起保留 4 秒，过期后重新发现 owner 并 follow/wait；owner 变化、断连及重连不会沿用旧缓存。Desktop send 先调用轻量 read(thread, false)，从返回快照中查找 inProgress 轮次并选择 steer/start；读取失败才回退为空状态。新 turn/start 在提交前用已知目录记录 Git 起点，steer 沿用已有轮次；不为基线加载完整历史。Agent Remote Control 后台任务 active 时额外查询最新一轮（降序 limit=1），inProgress 则 steer；turn/start 仅在 notLoaded 时自动 resume。

桌面 Thread/Turn 查询是 owner 快照的明确投影；显示层 steeringUserMessage 等 item 可能不同于公开 App Server union。
兼容性边界和支持的任务写操作见 [桌面说明](desktop.md)，未支持的方法明确拒绝；不使用受签名保护的 app-tools 管道、不绕过账号和系统权限。
跨设备不是自动路由能力；可通过原生命令在用户已有 SSH 环境中执行明确的远端操作。

停止入口只停止该入口的 Tunnel 和转发；退出 Core 才停止 App Server 和 Agent Remote Control 后台任务；界面保持可用，Desktop 自行管理其任务生命周期。
重启后旧提交中回执标记 unconfirmed，不自动重放；尚未提交的待审批请求继续保留。
事件缓冲最多保留最近 2000 条或 8 MiB，gap/reset 明确报告缺口；完整已落盘结果应从原生任务/回执读取。
Chat 页面不会因任务完成自动被唤醒，交互请求也需要调用方主动查询。


## 连接与持久输出

stdio 仅为传输代理，使用父进程传入的本机端口与随机凭据连接应用内的 Rust 核心。stdio 退出不会销毁应用内核心。工具调用产生本机活动日志，来源缺失时不推测 Chat ID。

`codex_events` 只提供当前连接的有界内存事件窗口，不创建磁盘归档；返回 `retention: memory-window`。任务历史通过 `codex_read` / `codex_items` 从原生 Codex 读取。请求回执与任务关联独立持久化；Agent Remote Control 自己管理的 Pi/ACP 输出通过 `agent_events.persistedOutput.outputId` 和 `control_output` 读取归档。

原生进程、文件监听和订阅句柄属于当前 App Server 连接；断线后不自动重建。旧会话的审批响应会被拒绝，未确认的写操作不自动重放。

## 可选任务审批与记录

Agent Remote Control 设置页的任务审批模式只决定新任务管理请求是否默认等待确认，不是权限门槛。用户意图优先：创建、续接、中断以及等价的 `codex_call` 任务请求可传 `approval: "approved"` 表示已确认，或 `approval: "bypass"` 声明直接执行；省略或 `default` 遵循本机设置。其他文件、命令等工具不受此任务审批模式影响，Codex 原生执行权限与回调审批保持独立。

等待时立即返回 `state: "awaiting-approval"` 和原 requestId，尚不提交任务。云端可按用户意图调用：

```text
receipt {"requestId":"<原请求 UUID>","action":"approve"}
receipt {"requestId":"<原请求 UUID>","action":"bypass"}
receipt {"requestId":"<原请求 UUID>","action":"reject"}
```

本机任务页也可批准或拒绝。批准、绕过后 Agent Remote Control 自动提交已保存的原请求，不需要重新创建。重复决定仅回读当前回执；已提交、已拒绝或结果未确认的请求不会重放。`receipt` 省略 action 或传 `read` 只查询结果。初次请求的 approval 属于参数摘要；推进已等待的请求使用上述 action，不修改原参数后重发。

模式可在连接期间切换，仅影响之后的新请求，已等待的请求保留。待审批请求跨应用重启保留；提交中断且结果不明的请求标记 unconfirmed，需检查原生状态。

任务页展示此 Agent Remote Control 记录的请求，按原生任务 ID 汇总创建、续接和中断，按创建时间倒序排列内容自适应高度的瀑布流文档卡片，展示标题、项目、模型、推理等级、创建时间、当前状态及 Prompt 预览；点击卡片平滑放大到窗口中央，查看完整 Prompt 和请求记录。关闭按钮、Esc 或点击背景可缩回卡片；未归档任务的详情中也可打开 Codex，已归档任务显示归档状态并隐藏打开按钮。Prompt、请求模型、推理等级和项目来自持久化请求；未提供的配置不显示，不冒充实际执行配置。原生覆盖参数与 input 优先级反映在详情中。任务列表读取全部已持久化的任务回执，不限定当前连接或轮次；已有回执也纳入列表，未保存的 Prompt、配置和未知运行状态不显示，不扫描会话 JSONL 补造内容。

运行状态通过原生任务快照刷新并保存最后一次基本信息，不解析会话 JSONL；关闭页面、应用重启或无法刷新时，仍保留任务记录和最后一次状态及时间。卡片只显示 Codex 原生运行状态，不将 Agent Remote Control 回执状态映射为任务状态；原生 idle 显示“空闲”，不代表用户工作目标已完成。任务正文保存在权限受限的本机状态目录，不写入连接日志或系统通知。

## 任务等待

非 Codex Agent 使用 `agent_wait(agent, taskId, turnId?, timeoutMs?, until?, expectedHash?)`；Codex 使用 codex_wait(threadId)。Pi/ACP 状态和权限差异见[本地 Agents 等待语义](agents.md#等待语义)。

创建或发送任务后，先从原请求回执取得 threadId / turnId，再优先调用 `codex_wait`。不要重复创建任务，也无需用 `codex_read` 配合 sleep 高频轮询。`codex_read`、`codex_events`、`receipt` 的用途和参数保持不变。

```json
{"threadId":"<thread-id>","turnId":"<turn-id>","timeoutMs":30000,"until":"terminal-or-interaction"}
```

这是带 `snapshotHash` 的 bounded event-driven long poll：长任务推荐每次 20–30 秒的 wait slice，默认 30 秒。每个 slice 内仍由事件唤醒与真实 owner 状态复核驱动，不是 `read → sleep → read` 高频轮询。

```text
create / send → 取得原 taskId/threadId、turnId → wait(timeoutMs=30000)
  → completed / failed / cancelled / interaction-required：处理结果或交互
  → timeout + snapshotHash=A：沿用原 ID，wait(timeoutMs=30000, expectedHash=A)
  → timeout + snapshotHash=B：沿用原 ID，wait(timeoutMs=30000, expectedHash=B)
  → terminal / interaction
```

timeout 或取消 wait 只释放本次等待，不终止、中断或重建源任务，也不应重新 create/send。续接时保留已返回的 turnId，以固定同一轮次；`expectedHash` 仅比较快照，不要求状态变化后才返回。`unconfirmed` 不代表任务失败，应先核实原任务和回执。

ChatGPT、Notion、Slack 及其他 MCP Client 的外层 Tool Call timeout 可能不同，因此统一使用有界 slice，不提供 per-client timeout 配置。普通 Chat / 通用 MCP Client 不推荐默认阻塞数分钟。`codex_wait` 的 `timeoutMs` 最大为 90000，为远程网关留出余量；`agent_wait` 上限仍为 300000。OpenAI Tunnel stdio adapter 对两个 wait 工具的内部转发预算为 330 秒；HTTPS MCP 的请求头/请求体读取限时不限制等待执行时间。这些 Agent Remote Control 预算无法延长外部客户端或代理的超时。

输入是禁止额外属性的 object：

| 字段 | 类型与含义 |
| --- | --- |
| threadId | 必填、非空 string |
| turnId | 可选、非空 string；省略时固定首个观察到的当前活跃轮次，否则最近一轮；不会跳到后续轮次 |
| timeoutMs | integer，1–90000，默认 30000；包括建立读取连接和原生读取时间 |
| until | terminal / interaction-required / terminal-or-interaction（默认）；声明期望目标 |
| expectedHash | 可选 string，上次返回的 snapshotHash，用于 changed 比较 |

终态与需要交互都是退出条件：即使 until=terminal，遇到交互也会退出，避免等待一个需要用户推进的任务；until=interaction-required 遇到终态也退出。`conditionMet` 表示返回状态是否符合 until。expectedHash 不屏蔽已经存在的终态或交互；未提供时 changed 比较本次第一次成功读取的快照。观察时间不参与哈希。

返回示例（位于 MCP structuredContent.result）：

```json
{
  "state":"completed",
  "reason":"native-turn-terminal",
  "threadId":"<thread-id>",
  "turnId":"<turn-id>",
  "recordedStatus":"completed",
  "runtimeStatus":"idle",
  "runtimeSource":"connector-app-server",
  "finalResponse":{"itemId":"<item-id>","type":"agentMessage","text":"完成","textTruncated":false,"nextOffset":null},
  "interaction":[],
  "conditionMet":true,
  "changed":true,
  "snapshotHash":"<hash>",
  "observedAt":"<last-native-observation-time>",
  "returnedAt":"<return-time>",
  "elapsedMs":1234
}
```

`finalResponse` 是选中轮次最近一条 assistant 输出，并不把 running 输出认定为最终交付；沿用条目的 textHash、UTF-16 offset/nextOffset，文本最多 6000 个 UTF-16 单位。余下内容通过 `codex_items` 读取，大结果沿用 `control_output` 分页。

- completed / failed / cancelled 来自所选原生轮次；原生 interrupted 映射为 cancelled，recordedStatus 保留原值。
- interaction-required 返回当前 Agent Remote Control 原生 pending 的 id、responseId、method、params、backendSession；`codex_respond.id` 使用 responseId（保留原生数值/字符串 ID 的 JSON 编码）。不自动 approve。Desktop 通过 activeFlags 报告等待审批/输入时会立即退出，但其 IPC 不提供原生回调 ID；此时 interactionAction 指向 Desktop 处理，不伪造 ID。
- timeout / deadline 仅代表这一次等待用尽时间；保留最后观察到的任务状态，不中断、不重发。继续等可再次调用 wait。
- unconfirmed 表示本次无法确认，reason 区分 connection-closed、connector-shutdown、native-read-timeout、native-connect-timeout、runtime-owner-changed 等。运行状态 notLoaded/unknown、目标轮次不存在、状态矛盾也不会被当作成功或停止。单次原生读取或快照超时会在等待期限内继续重试；到期仍无法确认时返回 unconfirmed 和最近的读取超时原因，而不是用旧快照断言当前状态。断连、owner 变化及其他读取错误立即返回。observedAt 保留最后成功读取的时间，没有成功读取则为 null。

等待固定使用实际运行连接，不在断线后重新启动/恢复任务。事件驱动唤醒并合并 250ms 内的流式通知，空闲每两秒回读原生状态；Desktop 重复的相同 revision 快照不会唤醒等待者，避免多个读取者互相触发回读；不依赖有限事件缓冲的连续 cursor。每个 wait 独立等待，不持有共享锁跨越网络读操作或等待。

MCP notifications/cancelled 可取消对应 wait，返回 unconfirmed / wait-cancelled（若客户端仍接受响应），不会发送 turn/interrupt。当前无会话 MCP 入口要求并发等待使用唯一 JSON-RPC request ID，重复活跃 ID 会被拒绝。本地 HTTP 的 MCP 和 plugin/call 等待在读完请求体后显式监听 socket EOF/错误，断开即丢弃等待 future 并释放该 ingress 的 wait ID；stdio 关闭会断开转发连接。此行为不依赖 Hyper 自动丢弃 service future，不会中断源任务；Agent Remote Control shutdown 通知等待者退出。连接已经关闭时无法向原调用方交付响应，调用方应把结果视为未知并重新读取任务。客户端、Tunnel 或反向代理可能有更短的请求期限；本机 stdio 转发支持五分钟等待，但不能保证外部入口接受同样时长。

这是有界同步等待，不是持久化监控订阅、定时任务或后台推送。普通 Chat 结束当前回复后不会继续执行等待。

所有内置 ACP 与 Custom ACP 自动进入相同的 `agent_*` 和 `agent_wait` 路径，不提供品牌化工具。`agents` 返回 displayName、integration、installed、available、status、version、discoveryError 和 descriptor；静态 `agent_capabilities` 不承诺会话能力，传 taskId 才读取 initialize 及 session 协商快照。完整启动和支持边界见[内置 ACP 矩阵](agents.md#内置-acp-支持矩阵)。

## Review 事实视图与完整性

`overview/tree/search/read/git` 默认按宿主权限读取。显式传入 `view: "review"` 时，以真实工作区路径为边界，排除越界路径及 Agent Remote Control 自身运行状态目录；不按文件名或内容猜测敏感性，不隐藏提交消息。正常 root 内符号链接仍可读取，Git diff 核对重命名两侧是否位于读取边界内。

includeSource=true 时，`data.coverage` 说明分页、筛选和跳过原因；`read.nextLine` 非空代表尚未读完，即使 `truncated` 为 false。搜索的 `matchesComplete` 表示单文件片段完整性，超出 5 处命中或 500 字符片段时用 `read` 继续读取。tree/search 续页可携带上一页 `listingHash` 作为 `expectedHash`；read 使用 `sha256`。哈希变化时重新分页。列表哈希只验证列表，不能验证搜索期间各文件内容。

默认不采集 source/statusHash/coverage。includeSource=true 时仅采集一次 Git 观测，返回 source；采集失败只记录 source.error，不阻断文件读取。不做读前/读后 Git 状态比较；expectedHash 只比较正文或列表哈希。project/list 在项目 ID/名称解析时缓存 30 秒，projects 工具仍读取上游当前列表。

```json
{"project":"<workspace>","path":"src/main.rs","view":"review","startLine":1,"lineCount":80}
```

Review 不改变原生 fs/command/process 权限，不是用户隔离或完整 DLP。调用方收到的内容会进入其服务；文件名筛选不能保证普通源码不含秘密。

## 任务上下文

```json
{"agent":"pi","taskId":"<existing-task-id>","view":"handoff"}
```

`agent_context` 仅为非 Codex 任务提供 review/handoff 视图，必须提供 agent 和 taskId，可选 turnId/project。仅读取已有任务记录和当前工作区，声明不是验证结果，缺失信息标为 partial。任务 cwd 与显式项目不一致返回 TASK_WORKSPACE_MISMATCH。入口策略通过 agent_read 和 git 控制读取，readNext 仅推荐允许的工具。Codex 的轮次改动使用 codex_changes，状态与原始条目使用 codex_read/codex_items。

## Git 写操作

`git` 保持原有只读名称、参数及 status/log/show/diff 语义。独立的 `git_write` 接受 project、operation 和可选 UUID requestId：

- `add` / `unstage`：提供非空 `paths`（项目内相对字面路径），或 `all: true`，二选一。all 作用于项目目录；unstage 只修改索引，初始提交前也可使用。
- `commit`：必填 `message`，支持多行，提交当前索引。不支持 amend。
- `branch`：必填 `branch`，从 HEAD 创建本地分支；`switch` 切换已有本地 branch，`create: true` 创建并切换。不会猜测远程分支或强制丢弃修改。
- `stash_push`：保存仓库已跟踪文件修改，可选 message，不包含未跟踪文件；`stash_pop` 应用最新 stash，冲突时 Git 保留 stash 和冲突现场。

分支、提交和 stash 作用于整个仓库。无 fetch/pull/push、删除分支、历史改写、reset --hard 或 clean。写入沿用主机权限，不经过任务执行沙箱或任务创建审批；工具列表负责入口授权。`git_write` 仅在“全部”或明确选择的“自定义”中启用；默认档省略此低频工具，只读始终排除此工具。选择它会保留 receipt 和 control_output。

回执复用 receipt：同一 requestId 和参数重试不重复执行，不同参数拒绝。Git 失败或冲突返回 failed，保留原因；读取回执和 git 状态后再决定后续操作。该工具没有单独的审批队列；现有 approve/bypass/reject 仅对处于 awaiting-approval 的请求生效。

提交及 stash push 的身份从 Git 仓库与用户全局配置读取 user.name/user.email（包含用户配置的 include/includeIf，仓库值优先），缺失时报错，不硬编码身份、不使用进程中的 GIT_AUTHOR/GIT_COMMITTER 覆盖。仅身份值传入写命令，其他全局配置与系统配置不加载。写命令保留环境清理、--no-optional-locks、字面路径、12 秒超时与每路 16 MiB 输出上限；必需的索引锁仍由 Git 管理。禁用 hooks、fsmonitor、外部 diff、配置的 clean/smudge/process 过滤器、签名、自动维护及递归子模块操作；依赖过滤器（例如 LFS）的文件不会自动转换。stash pop 禁用 rerere，并在仓库配置了外部 merge driver 时拒绝执行，以免触发自定义命令。

```text
git_write {"project":"/absolute/project","operation":"add","paths":["src/main.rs"],"requestId":"<UUID>"}
git_write {"project":"/absolute/project","operation":"commit","message":"fix: correct behavior\n\nDetails","requestId":"<新 UUID>"}
receipt {"requestId":"<提交 UUID>"}
```

### Image content

`read` detects PNG, JPEG, WebP and GIF by file signature before using the extension.
It returns native MCP image content plus the path, original and returned pixel
sizes, byte counts, both SHA-256 hashes, and `reencoded`.
`maxEdge` defaults to 1568 (1–4096); `quality` defaults to 80 (1–100).
Images already within both the pixel and 1 MiB encoded-byte limits are returned
unchanged, including their original MIME type. `quality` only applies when
re-encoding is necessary. If resizing increases the byte count, an original
within the byte cap may be retained when its longest edge exceeds `maxEdge` by
less than 10%. Larger images still obey `maxEdge`; the byte cap is always enforced.
Re-encoded JPEG and opaque WebP use JPEG; other formats use PNG. Re-encoding an
animated image returns its first frame; original passthrough preserves the file.
Input files retain the 16 MiB read limit. Other binary files report the guessed
type and byte count.

`codex_read` and `codex_items` accept `includeImages` (default `false`) and
`maxImages` (default 4, range 1–8). The newest images in the returned items are
appended after the existing text result, each preceded by its item and source.
Text truncation and pagination are unchanged. Images share the 1568-pixel target,
less-than-10% fallback tolerance, original passthrough and 1 MiB limit described
above. Local Markdown references must resolve inside the thread's project root
or its own `CODEX_HOME/visualizations/YYYY/MM/DD/threadId/` directory. Symlinks
cannot escape these boundaries. Embedded tool screenshots with base64 data URLs
are supported. Unavailable, invalid or disallowed images produce a short
per-image explanation without discarding the text result.

`codex_items` defaults to the original oldest-first order across the thread.
Set `latest: true` to select the most recent turn and read its items newest first;
`includeImages: true` then includes images from that page. An explicit `turnId`
selects that turn instead. The result includes the selected `turnId`. To continue,
pass that same `turnId`, `nextCursor` as `cursor`, and `latest: true`; a new turn
will not change the selected scope. A cursor with `latest: true` but no `turnId`
is rejected rather than silently reselecting a turn. Without the new parameter,
existing cursor, ordering, offset and length semantics are unchanged.

The MCP `tools/list` response comes from the same embedded catalog used to
validate calls; it is not a separate tool registration. HTTP responses use
`Cache-Control: no-store`. If a client still displays an older description or
schema, refresh or reconnect its MCP connection and check the server's actual
`tools/list` result rather than relying on the client's cached tool descriptions.

大于 64 KiB 的结果内联约 48 KiB JSON 文本，并返回 outputId、nextOffset。control_output 每页最多 65536 个 UTF-16 code units；JSON 缓存最多保留 1 小时，共享 64 MiB 容量。


## macOS 界面观察与操作：screen

`screen` 直接由 Core 启动随 App 打包的 Swift helper `clc-screen`，不经 Codex app-server。仅 macOS 可用；其他平台返回 `SCREEN_UNSUPPORTED`。安装版需要在系统设置中向 **ARC** 授予屏幕录制和辅助功能权限。调用需要的权限尚未授予时，helper 主动请求对应的系统授权提示；尚未获得授权则返回明确错误，授权后重新调用即可。提示是否再次显示由 macOS 决定，已拒绝时可手动前往系统设置开启；若系统要求重新打开 App，请按提示操作。直接从终端运行 helper 时，macOS 的权限归属取决于启动它的宿主，不代表安装版已授权。

除 `windows` 外，指定 `app`（名称包含匹配）、`bundleId`（精确匹配）、`title`（标题包含匹配）或 `windowId`；组合指定时同时匹配。同 App 多窗口优先选择主窗口。跨 App 存在歧义时，优先当前活动 App，否则要求更精确的目标。

| action | 行为 |
| --- | --- |
| `windows` | 列出窗口 ID、App、bundle ID、PID、标题、frame、onScreen、frontmost 和 appActive；可按目标字段过滤。 |
| `capture` | 返回窗口截图的 MCP image 及元数据；`maxEdge` / `quality` 与 `read` 相同。 |
| `tree` | 启用网页辅助功能后返回元素 `ref`、role、label、frame；`text: true` 包含静态文字。默认最多 300 项，`limit` 上限 1000；节点、深度或时间预算耗尽时 `truncated: true`。 |
| `press` | 按 `ref` 或 `label` 包含匹配（`nth` 从 0 开始）执行 AXPress，失败时在允许前台操作且元素可见时点击中心。 |
| `show` | 对定位元素执行 AXScrollToVisible，不模拟滚轮。 |
| `raise` | 显式提起目标窗口并激活 App。 |
| `key` | 发送 `Escape`、`Return`、`Tab`、方向键、字母数字或 `cmd+k`；组合键支持 cmd、shift、option/alt、control/ctrl，字母数字使用 macOS ANSI 键位。 |

`ref` 是带窗口 ID 的结构路径，同一结构下稳定；界面结构变化后应重新读取 `tree`。它不是跨界面版本的元素句柄。

`capture` 和需要激活目标的输入操作支持 `front`：

- `auto`（默认）：目标不在前台且最近 60 秒无输入时，暂存前台 App/窗口，激活目标，操作后恢复。用户正在操作时不抢前台；截图标记 `possiblyStale: true`，需要前台的按键或点击回退返回 `FOREGROUND_REQUIRED`。
- `never`：不抢前台。后台窗口截图可能是未重绘的旧 WebView 画面。
- `always`：激活目标并保留前台。`raise` 本身就是显式前台操作，不受此参数限制。

`press`、`show`、`raise`、`key` 可带 `after: {waitMs: 200, capture: true}`，或 `capture: {front: "never", maxEdge: 1568, quality: 80}`。等待最长 10000 毫秒；操作、等待、截图在同一把 Core 锁内串行执行，调用端断线不会提前释放锁。动作已执行而后置截图失败时返回 `performed: true` 和 `captureError`，不要因此重复执行动作。`performed` 只确认 AX/输入事件提交，业务效果仍需用树或截图核对。

helper 的输入为 stdin 单个 JSON 对象，stdout 为 `{ok, result}` 或 `{ok: false, error}`。直接调用时截图以 `imageBase64` 返回，Core 用共享 `images::prepare` 转为有尺寸/体积限制的 MCP image。截图临时文件在调用结束时删除。

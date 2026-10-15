# 本地 Agents

CLC 支持 Codex Native、Pi RPC 和 OpenCode ACP。Agents 面板自动发现可执行文件、版本和连接方式，不保存或要求重复填写 provider/token。Codex 初始排序在首位，可关闭并调整排序；Codex 使用 codex_*，非 Codex 任务显式选择 agent_* 的 `agent`，不接受 codex。

Agents 面板用卡片展示图标、名称和已安装版本，未安装项显示“未安装”。每张卡片的图标、标题与开关同排展示，不显示拖拽标识；拖拽卡片可排序，也可聚焦卡片后用方向键调整。顺序保存在本机，首页只显示已安装且启用的 Agent，默认最多 4 个；Agents 设置的“外观”组可调整为 4、6、8、10 个。展示名称按品牌归类，例如 Cursor、Antigravity、Grok；底层执行标识与协议保持独立。标题栏的“刷新”按钮更新本机发现结果，标题旁的设置按钮打开外观、额度和用量设置；这与 Agent 管理开关是两个入口。非 Codex Agent 的开关控制 CLC 是否接受该 Agent 的任务请求；关闭后新的 `agent_*` 调用返回 `AGENT_DISABLED`，不会卸载 Agent、修改其配置或终止已执行的任务。Codex 专用 `codex_*` 入口保持独立。开关保存在本机，重启后仍生效；本机管理接口 `PUT /api/agents` 接收 `{ "agent": "codex", "enabled": false }`。

| Agent | 连接方式 | 配置与执行归属 | 能力边界 |
| --- | --- | --- | --- |
| Codex | App Server + Desktop IPC | 继承 Codex；按现有设置由 Desktop 或 Connector 执行 | 使用 `codex_*` 入口，高级能力通过全部/自定义工具列表开启 |
| Pi | 官方 `pi --mode rpc` JSONL | 继承 Pi 配置、provider、model、扩展；CLC 管理子进程 | 使用 `agent_settled` 确认最终完成，需要提供该事件的 Pi 版本（本版适配 0.85.1）；交互通过 extension UI，非统一工具权限沙箱 |
| OpenCode | 官方 `opencode acp`，ACP v1 JSON-RPC stdio | 继承 OpenCode 配置和登录；CLC 管理子进程 | 支持文本 prompt、流式更新、取消与权限响应；恢复要求 `loadSession` 能力 |

`installed` 表示发现了可执行入口；`available` 表示版本探测及描述中的启动条件检查通过。`status=installed` 表示可尝试启动，`ready` 表示有已初始化的活动 CLC 会话，`unavailable` 表示未安装、版本探测失败或入口不兼容。失败原因见 `discoveryError`；旧 CLI 可以同时是 installed=true、available=false。以上状态均不保证认证、额度或模型服务可用。

Agents 管理面板加载期间先显示 Codex 占位，读取完成后直接展示完整的有序 Agent 列表，包括未安装项。卡片展示名称和已安装版本；未安装项不显示启用开关。只有已安装且启用的 Agent 参与拖拽或键盘排序，保存后的顺序同时用于首页展示。协议、类型和发现状态仍可通过 `agents` 接口读取。CLC 自身不依赖 Node；外部 CLI 使用各自安装所要求的运行时。CLC 不下载或升级 Agent 主程序、不存储其 provider token，也不主动登录；需要项目内置适配器的 Agent 可以按下文说明由 CLC 单独准备适配组件。

## 内置 ACP 支持矩阵

所有项都使用 `acp-v1`、JSON-RPC stdio 和同一个 Generic ACP Driver。下表的能力说明来自官方接口资料；不是未握手时的能力承诺。官方文档未给出最早支持版本时，不编造最低版本号；要求当前安装的 CLI 暴露表中的入口并通过实际握手。`builtins.json` 保留每项来源、运行时及启动条件。

| Agent / id | 启动命令 | 类型 | 认证归属与主要限制 | 实机覆盖 |
| --- | --- | --- | --- | --- |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) / gemini | `gemini --acp` | native | Gemini CLI/provider；旧 `--experimental-acp` 已弃用；个人 Code Assist 登录不再服务 Gemini CLI | 0.53.1 启动与认证拒绝路径；无成功 prompt |
| [Claude Code](https://github.com/agentclientprotocol/claude-agent-acp) / claude | `claude` + Connector 管理的 ACP 适配器 | adapter | ACP 项目维护的 `@agentclientprotocol/claude-agent-acp` 使用官方 Claude Agent SDK；独立 `claude` 不提供原生 ACP | adapter 0.79.0 握手、建会话与缺少认证失败路径；无成功 prompt |
| [Cursor Agent](https://cursor.com/docs/cli/acp) / cursor | `agent acp`，同参数别名 `cursor-agent` | native | Cursor 登录/API token；同名 agent 必须通过 Cursor 身份检查；旧版没有 acp 时不可用 | 旧版本和同名非 Cursor 程序的发现拒绝；未做 prompt |
| [Grok Build / Grok CLI](https://docs.x.ai/build/cli/reference) / grok | `grok agent stdio` | native | 官方 Grok 登录/XAI provider；不适用于同名社区 CLI | 1.0.25 创建、wait、最终输出、send、跨进程 load、cancel；无害命令未触发权限请求 |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) / copilot | `copilot --acp --stdio` | native | Copilot 登录或 BYOK；ACP 仍是 public preview；不是 Copilot language server | 静态与未安装状态 |
| [Kimi Code CLI](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp) / kimi | `kimi acp` | native | Kimi 登录/provider/model；需要自身 Python 环境 | 静态与未安装状态 |
| [Qwen Code](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/architecture.md) / qwen | `qwen --acp` | native | Qwen 登录/provider/model；不是 `qwen serve` HTTP 服务 | 静态与未安装状态 |
| [Kiro CLI](https://kiro.dev/docs/cli/acp/) / kiro | `kiro-cli acp` | native | Kiro CLI 登录与 agent 设置；使用公开 CLI 入口 | 静态与未安装状态 |
| [Devin CLI](https://docs.devin.ai/desktop/acp) / devin | `devin acp` | native | Devin CLI 登录；不要假设普通 CLI 的 mode/model 参数在 ACP 中生效 | 静态与未安装状态 |
| [Cline CLI](https://docs.cline.bot/usage/acp) / cline | `cline --acp` | native | `cline auth` 或 provider 环境；依赖客户端 fs/terminal 的工具在 CLC 中不可用 | 静态与未安装状态 |
| [Junie CLI](https://junie.jetbrains.com/docs/junie-cli-acp.html) / junie | `junie --acp true` | native | Junie 账号/API/BYOK；不同 license flavor 的认证方式有差异 | 静态与未安装状态 |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp) / hermes | `hermes acp` | adapter（项目内置） | Hermes 配置/provider；需安装 Python `[acp]` extra；可选浏览器依赖不由 CLC 安装 | 静态与未安装状态 |
| [OpenCode](https://opencode.ai/docs/acp/) / opencode | `opencode acp` | native | OpenCode 登录/provider；复用现有支持 | 沿用现有覆盖 |

“静态”仅表示描述解析、官方入口核对和发现行为验证，不表示该 Agent 已成功运行。Gemini 的 [官方迁移公告](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)规定个人免费、Pro/Ultra 路径已停止服务；受支持的企业与付费 API 路径仍可使用，CLC 不自动切换 provider。

### 发现与启动要求

每项首先搜索 PATH，再搜索 `~/.local/bin`、`~/.bun/bin`、`~/.opencode/bin`、Homebrew/`/usr/local/bin`，Windows 还搜索用户 npm 目录。描述的 `searchDirs` 可增加路径，例如 Grok 的 `~/.grok/bin`、Junie 的 `~/.junie/bin` 和 Hermes 虚拟环境。`~/` 按当前用户展开；不通过 shell 展开命令。Unix 必须有执行位；Windows 支持 `.exe`、`.cmd`、`.bat`。Windows shell 特殊字符参数会被现有受限启动器拒绝。

版本探测默认 `--version`；Grok 使用 `version`，Hermes 使用 `acp --version`。这些参数都来自描述。可用性还可检查 `helpArgs`/`helpContains`；Cursor 增加 `identityContains` 避免把其他产品的 `agent` 当成 Cursor。探测有超时、不读取 stdin，也不启动登录。不同 Agent 的探测并行执行。

Gemini/Qwen/Cline 的 npm 安装需要各自版本要求的 Node；Kimi/Hermes 使用自身 Python 环境；Grok、Cursor、Kiro、Devin 和 Junie 使用官方安装提供的运行环境。Copilot 可以使用独立二进制或 npm 安装。CLC 不把发现 npx/node/bun 当成发现 Agent。

Claude Code 使用 Connector 管理的 ACP 适配器。用户安装并登录 Claude Code 后，在 Agents 中启用 Claude；首次启用会后台下载固定版本的适配器及私有 Bun 运行时，使用 SHA-512 校验，并在启动探测通过后原子激活。无需全局 Node、npm 或 `claude-agent-acp`，也不重复下载 SDK 的 Claude 原生程序。适配器通过 `CLAUDE_CODE_EXECUTABLE` 复用已发现的 Claude，认证和 provider 配置仍归 Claude 管理。

组件保存在 CLC 数据目录的 `dependencies/claude-acp/<version>`，按 Connector 内置清单随版本更新；支持 macOS / Windows 的 ARM64、x64。下载使用应用的网络代理配置，不执行 npm 安装脚本。普通发现和刷新不会下载；启用后显示准备状态，失败后重新启用可重试，未完成的安装不会被任务使用。关闭开关会取消当前准备，不卸载已完成组件；退出应用也取消未完成准备。升级后组件清单变化时需要再次启用以准备新版本，既有版本保留供正在运行的会话使用；下次 Core 启动、尚未创建 Agent 进程时删除已完成安装的旧版本。

Claude 的 `installed`、`path`、`version` 描述本机 Claude Code；`available` 还要求适配器就绪，`adapter.state` 区分 missing、preparing、ready、failed。适配器就绪只表示可以尝试建立会话，不保证 Claude 已登录、额度或模型服务可用。

### Session 能力边界

| Agent | 官方能力说明 / 需要协商的边界 |
| --- | --- |
| Gemini | 当前 CLI 提供 ACP 会话与权限流程；能否创建会话先受账号/provider 限制，恢复与 model/mode 以当前会话响应为准 |
| Claude adapter | 上游实现 load/resume、取消、权限和 model/mode；高级扩展需要双方显式协商，CLC 只使用通用子集 |
| Cursor | 文档明确 new/load、cancel、权限及 agent/plan/ask；阻塞扩展 `cursor/ask_question`、`cursor/create_plan` 在 CLC 返回 method-not-found |
| Grok | 实际 initialize 提供 loadSession、模型与模式信息，prompt/cancel 使用标准 ACP；上游扩展不成为新 MCP 工具 |
| Copilot | public preview；不将普通 CLI 的 resume/model/mode 功能直接映射成 ACP 能力，使用实际 initialize/session 响应 |
| Kimi | 官方列出 load/resume、cancel、permission、set_mode、set_config_option 和 model 扩展；不支持的客户端能力由上游降级 |
| Qwen | 官方实现包括 session 恢复、cancel、mode 与 model 扩展；通用 CLC 不暴露其 HTTP daemon 或私有模型接口 |
| Kiro | 官方列出 session/new、load、prompt、cancel、set_mode 与权限；`_kiro.dev/*` 私有接口不暴露 |
| Devin | 官方确认 stdio ACP 入口；引用页面未承诺完整逐方法能力表，load/cancel/permission/model/mode 不做静态保证 |
| Cline | 官方明确持久 session load、Plan/Act、模型/provider 选择和权限请求；cancel 及具体客户端依赖以安装版本协议为准 |
| Junie | 官方确认 `--acp true`；引用页面未给完整逐方法能力表，load/cancel/permission/model/mode 不做静态保证 |
| Hermes | 官方描述取消事件、权限、模型目录及会话持久化；较旧版本恢复语义不同，跨进程恢复必须实际验证 |

未提供 taskId 的 `agent_capabilities` 返回 `negotiated=false`、`capabilities=null` 和静态 descriptor，不声明 create/cancel 等已支持。提供 taskId 时返回真实 initialize 响应，并在 `session` 字段保留 new/load 响应（含上游实际提供的 models/modes/configOptions）。这些是协商快照，后续更新还可从 events/metadata 观察。CLC 目前没有通用模型/模式切换、session/resume、fork/list 或任意 ACP RPC 透传入口；跨进程恢复仍只用已协商的 session/load。

## 通用工具

| 工具 | 用途 |
| --- | --- |
| `agents` | 发现安装、版本、协议与默认 Agent |
| `agent_capabilities` | 公共能力；提供 `taskId` 读取该进程实际协商结果 |
| `agent_tasks` | 列出任务；Pi/ACP 限于 CLC 创建的任务，使用 offset/limit 分页 |
| `agent_create` | `agent`、绝对 `cwd`、可选 UUID `requestId` 和文本 `prompt` |
| `agent_wait` | `agent`、`taskId` 必填；可选 turnId、timeoutMs、until、expectedHash；优先用于等待最终结果或交互 |
| `agent_read` | `agent`、`taskId`，读取状态、最近输出和协议元数据 |
| `agent_send` | `agent`、`taskId`、`prompt`、新 `requestId`；必要时恢复已确认停止的会话 |
| `agent_interrupt` | 请求取消 |
| `agent_events` | 按 after/limit 读取原生流式事件；backendSession 用于识别进程重启 |
| `agent_pending` | 等待中的 ACP 权限请求、Pi 扩展交互 |
| `agent_respond` | 用 `interactionId` 响应；ACP 提供 `optionId` 或 `cancelled`；Pi 提供 `value`、`confirmed` 或 `cancelled` |
| `receipt` | 回读幂等回执；可 approve/bypass/reject 待确认操作 |

本机没有可用且启用的非 Codex Agent 时，agents 和 agent_* 整组不暴露。先用 `agent_create` 创建会话并取得 taskId；处理回执中的审批或不确定状态后，用 `agent_wait` 等待：

```json
{"agent":"opencode","cwd":"/absolute/project","requestId":"新生成的 UUID","prompt":"不要使用工具或修改文件，只回复 OK"}
```

写操作先保存回执再提交。省略 requestId 时服务端生成 UUID；安全重试必须保持返回的 requestId 和全部参数不变。回执对外只返回状态、标识、必要结果与错误，不回显输入和内部字段。`receipt.state=completed` 表示该写操作已结束，不等于任务成功：Pi 的 prompt 回执在接受输入后返回，而 ACP prompt 的响应在本轮结束后返回。两者均优先使用 `agent_wait` 确认最终状态与输出，不需要高频轮询 `agent_read` / `agent_events`。ACP prompt 回执在等待期间仍可为 pending；无需等回执 completed 才调用 agent_wait。启用任务审批时，create/send/interrupt 先进入 `awaiting-approval`，可通过 `receipt` 决定；`approval=approved/bypass` 沿用现有确认语义。Pi/ACP 的确认目前通过 MCP 操作，现有桌面任务页仍展示 Codex 任务。

`taskId` 是 CLC UUID，`agent` 区分驱动，`runtimeSource` 保留执行来源，`sessionId` 是上游会话 ID。Pi/ACP 的 `turnId` 是 CLC 单次 prompt 标识，不伪装成上游轮次 ID。协议原始数据位于 metadata、lastMessage 和事件中。Codex 状态、历史和回调通过专用 codex_* 查询。

Pi/ACP 状态包含 starting、idle、running、waiting-permission、cancelling、completed、cancelled、failed、unknown。权限响应不是自动批准：必须选择上游给出的选项。Pi 扩展的 confirm/select/input/editor 被转发，但不提供 ACP 式统一工具权限控制；工具与文件权限仍由 Pi、扩展和运行环境决定。CLC 不宣称额外的文件系统沙箱。

写操作默认同步等待 25 秒，可用 waitMs 调整为 0–120000ms；超时返回 pending。已提交后连接中断或超时且结果未知才返回 `unconfirmed` 回执，不自动重放；参数、本地校验或上游明确拒绝返回 failed/rejected。存在未确认操作时不能通过新 prompt 自动恢复。停止后的已完成会话可由 agent_send 恢复：Pi 使用原 session 文件，ACP 使用协商后的 session/load。未发送 prompt 的 Pi 空会话可能尚未持久化，不能保证跨进程恢复。

Codex 事件只保留最近 2000 条或 8 MiB 的内存窗口，缺口与重启通过 gap/reset 表示；会话历史按需从原生 Codex 读取，不持久化镜像。Pi/ACP 事件有同样的有界内存窗口，完整 JSONL 以活跃尾文件和经过校验的 gzip 分段保存在 CLC 私有 outputs 目录，`control_output` 按原始内容和 UTF-16 偏移读取。活跃尾文件达到 8 MiB 后轮转，唯一事件历史不按时间删除；`cli storage compact` 可无损压缩现有归档。ACP 最近文本输出超过 256 KiB 时仅保留末尾并标记 outputTruncated；完整输出在事件归档中。进程停止后的任务快照仍可读，实时 events/pending 需要存活进程。停止入口不关闭 Agent 进程；退出 CLC 才关闭其拥有的 Pi/ACP 子进程；Desktop 拥有的 Codex 任务继续沿用原生命周期。


## 等待语义

codex_wait 和 Pi/ACP 的 agent_wait 采用[可续接的 bounded event-driven long poll](tools.md#任务等待)：默认 30 秒，长任务推荐每次 20–30 秒。timeout 后沿用原 taskId 和 turnId，将上一轮 snapshotHash 传为 expectedHash 继续 wait，直到终态或交互；不重新创建任务，也不重发 prompt。每个 slice 内仍由事件和真实状态复核驱动。codex_wait 上限为 90 秒，为远程网关留出余量；Pi/ACP agent_wait 上限仍为 300 秒，需确认上游支持。普通 Chat / 通用 MCP Client 不推荐默认一次阻塞数分钟。

```json
{"agent":"opencode","taskId":"创建回执中的 taskId","timeoutMs":30000,"until":"terminal-or-interaction"}
```

`timeoutMs` 为 1–300000，默认 30000；`until` 为 `terminal`、`interaction-required`、`terminal-or-interaction`（默认）。`turnId` 可固定轮次，否则固定首次观察到的当前/最近轮次；Pi/ACP 不保存历史轮次等待视图，轮次被替换返回 unconfirmed。`expectedHash` 可传上次的 snapshotHash，只影响 changed，不屏蔽已存在的终态或交互。

- `completed` / `failed` / `cancelled`：原生轮次已确认终止，finalResponse 返回最终输出。Codex 保留原生消息对象，Pi/ACP 返回文本，并保留 outputTruncated、stopReason、error。
- `interaction-required`：即使 until=terminal 也立即退出等待；interaction 带 interactionId、backendSession 及原始选项，可用 agent_pending 回读、agent_respond 回答。codex_wait 的 Desktop 交互若没有回调 ID，按 interactionAction 在 Desktop 处理。
- `timeout`：只结束本次等待，继续用同一 taskId/sessionId 等待；不取消、重建或发送 prompt。
- `unconfirmed`：进程退出、连接/所有权不明、状态不一致、原生读取失败、等待被取消或没有可等待轮次。runtimeStatus 为 unknown 时不代表任务失败；先检查原回执/任务，不换 requestId 重放。

终态和交互始终是退出条件，`conditionMet` 单独说明是否满足 until。`snapshotHash` / `changed` 比较状态、输出和交互；elapsedMs / observedAt / returnedAt 区分观察与返回时间。等待通过事件唤醒，流式事件最多每 250ms 合并复核一次，并每 2 秒兜底读取。Pi 复核官方 get_state，以 agent_settled 为完成依据；ACP 没有标准 session/status 方法，使用 CLC 拥有的存活进程、session/update 和 session/prompt 最终响应，不伪造远端状态查询。

多个等待独立运行；MCP notifications/cancelled 或调用连接断开只释放对应等待。等待不恢复已停止的进程；旧快照可用 agent_read 查看。Custom ACP manifest 自动复用 ACP 等待路径，无需修改 Host。普通 Chat 回复结束后不会在后台继续等待或主动推送。

## ACP 能力协商与扩展

CLC 支持 ACP v1 的 initialize、session/new、session/load、session/prompt、session/update、session/cancel、session/request_permission。初始化时不声明客户端文件系统、terminal 或交互式登录能力；Agent 可使用自己的本地工具。未声明的客户端方法返回 method-not-found。provider 登录使用 Agent 自己的 CLI。图片、模型切换、会话 fork/list/import 及 ACP v2 尚未通过通用工具暴露，即使上游公布相应能力。

在 CLC 私有状态目录的 `agents/manifests.json` 中可增加 ACP 定义，重启应用后读取：

```json
[
  {"id":"custom-agent","command":"/absolute/path/to/agent","args":["acp"]}
]
```

manifest 与内置项使用相同的严格解析和启动逻辑。最小配置仍是 `id`、`command`、`args`，可选 `displayName`、`protocol`（只接受 `acp-v1`）、`integration`（native/adapter/custom）、`aliases`、`searchDirs`、`versionArgs` 和 `compatibility`。compatibility 可包含 helpArgs、helpContains、identityContains、versionRequirement、runtime、authentication、caveats、sources；未知字段拒绝，启动条件以可执行探测与握手为准，versionRequirement 仅为说明。

ID 必须非空且仅包含 ASCII 字母、数字、下划线或连字符；与任何内置 ID 或另一自定义 ID 冲突均拒绝。不同 ID 可以指向同一个 ACP 可执行文件，无需覆盖内置项。空 command、无效协议及缺少 helpArgs 的 help/identity 条件均拒绝。没有版本参数的 Custom launcher 可显式设置 `versionArgs: []` 跳过版本探测（version=null），仍须实际 ACP 握手；所有内置项均有版本探测。CLC 不通过 MCP 接收 manifest 修改；这是本地受信任启动配置。

新增符合 ACP v1 的 Agent 优先增加 manifest/compatibility metadata，不增加品牌工具或 Rust Driver。内置和 Custom ACP 都自动复用现有 agent_wait，没有单独等待逻辑或品牌协议 shim。

协议参考：[ACP v1](https://agentclientprotocol.com/protocol/v1/initialization)、[OpenCode ACP](https://opencode.ai/docs/acp/)、[Pi 官方 RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)。

## 只读审查与交接

`agent_context({agent, taskId, turnId?, project?, view?: "review" | "handoff"})` 为已有任务生成有界、可追溯的材料，详见[工具语义](tools.md#任务上下文)。它不续接、不迁移任务、不执行验证。该工具仅读取非 Codex 已有任务记录，缺失的命令证据与实时状态明确表示未知。交接材料不是新授权，继续前应重读任务、原回执和当前代码。

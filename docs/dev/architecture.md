# 架构与生命周期

[开发](development.md) · [工具参考](../reference/tools.md) · [Agent 参考](../reference/agents.md)

## 进程与职责

```text
React / Tauri Desktop ── 本机认证管理 API ── Core
                                              ├─ Ingress A ─ HTTPS / OAuth
CLI / 管理 MCP ──────── 本机认证管理 API ───────┤─ Ingress B ─ OpenAI Tunnel
                                              └─ Execution
                                                  ├─ Control → Codex owner
                                                  └─ AgentHost → Pi / ACP
```

React 在系统 WebView 中渲染。Desktop 管理主窗口、托盘、原生面板、权限与更新。runtime 为每个状态目录维护一个文件锁保护的 Core；Desktop、CLI 等本机入口持有租约。不同构建不能共享同一个活动 owner。最后一个租约释放后 Core 退出；daemon 模式可独立常驻。

service::Service 拥有唯一的 Control、AgentHost、execution::Execution 和入口集合。Execution 负责业务组合；kernel 保存与提供商无关的来源、工具策略、回执、结果和事件存储。传输层处理请求与结果封装，egress 统一投影错误和输出。

## 入口与认证

每条 Ingress 独立拥有生命周期锁、监听器、提供商进程、临时目录、URL、验证挑战、日志和错误。停止或故障只影响当前入口。Core 关闭时先停止入口，再关闭自身 AgentHost/Control。所有入口共享项目和任务空间，入口名称不是认证用户。

OpenAI Tunnel 使用官方身份和客户端，其 stdio adapter 携带 ARC_NATIVE_PORT、ARC_NATIVE_TOKEN、ARC_INGRESS_ID 转发到本机管理端点。HTTPS 在每条入口自己的监听器暴露 MCP 与 OAuth 路由，TLS 由隧道或反向代理终结。监听器创建时固定入口，请求不能通过参数或头选择别的入口。

管理 API 绑定随机 loopback 端口，校验 Host、Origin 和私有令牌；认证信息存于受保护状态目录。远程 HTTPS 不暴露管理 API。OAuth、Bearer、None 与 OpenAI 认证按入口配置，协议细节只在 [OAuth](../reference/oauth.md)维护。

工具 allowlist 同时约束发现与调用。注册表拥有分组、预设、依赖与高级标记；本机管理目录保留完整工具集合。来源上下文记录 ingressId、controlSource、authType，随回执和后台操作传递，不改变原任务 owner。

## 任务归属与执行

默认新 Codex 任务由 Desktop 执行。关闭自动打开后，新任务交给 ARC App Server；切换设置不迁移历史任务。Linux 始终使用后台 App Server。Desktop resume 不把任务加载到 ARC 的 App Server。后台发送仅在 notLoaded 时恢复，在活跃轮次上追加输入。

Control 共享 Desktop IPC 连接，使用 macOS Unix socket 或 Windows named pipe，并检查用户、owner 和响应来源。断线后按需重连，owner 变化或断线清空快照。快照最长复用四秒；发送先轻量读取，选择 steer/start 并复用实际任务配置。Windows 从当前用户的 Store Codex 安装发现 CLI，按内容哈希缓存运行所需文件。

Pi/ACP 每个任务拥有独立进程，AgentHost 保存 ARC taskId 与上游 sessionId。通用驱动按 descriptor 发现、启动和协商，Codex 不走 agent_* 协议适配。上游恢复能力决定 session/load 是否可用；不重放结果不明的写入。

## 回执、观察与通知

写入先按 UUID 保留幂等回执，再派发。重复 ID 与相同参数回读原操作，冲突参数拒绝。请求等待超时返回 pending，提交后失联返回 unconfirmed；两者都保留原标识供回读。

waiter 通过事件唤醒和真实状态复核判断轮次，默认 30 秒切片，取消等待只释放等待，不取消任务。Codex 保持原 owner，Pi/ACP 使用其存活进程状态。等待不持有全局锁，也不恢复已停止的执行进程。

claude_notify 按 thread/turn 绑定 Claude Code 云端会话，持久化固定状态投递记录。完成、失败、中断、等待输入或审批触发通知。发送期间释放记录锁，返回后合并；每条只尝试一次，重启后未确认的 sending 记录转为失败。成功要求 Claude CLI JSON 的 ok=true 与同一 session_id。macOS 系统通知作为失败回退。行为与调用参数见[工具参考](../reference/tools.md#claude-follow-ups)。

## 数据与观察

项目来自原生 project/list，ID/名称解析缓存 30 秒。路径按工作区与文件系统规则解析，Review 视图执行资源边界。Git 基线记录提交前的 HEAD 和 dirty；轮次比较反映当前工作区，已有修改仍在比较范围内。

大结果由 kernel::results 保存不可变快照，按 UTF-16 分页。Pi/ACP 原生事件使用活跃 JSONL 尾和校验过的 gzip 分段；Codex 历史保持上游所有权。用户日志与事件档案分离。具体预算与保留期见[工具参考](../reference/tools.md#output-events-and-logs)，不在多处复制。


## Desktop 生命周期

- 连接：启动选中入口及提供商；Agent 执行连接按需初始化。
- 断开：停止入口进程和转发，后台任务保持原生命周期。
- 关窗口：隐藏主窗口，菜单栏/托盘和连接继续运行。
- 退出：保存运行连接集合并释放 Desktop 租约；其他租约可维持 Core。
- 再打开：恢复之前运行的连接；原本断开的保持断开。
- 更新：验签后要求其他入口退出，排空请求，暂停自动启动，等待 Core 文件锁释放再安装。失败时恢复客户端与连接。

托盘左键打开主窗口，右键打开原生菜单；不额外创建托盘 WebView。屏幕捕获和原生窗口由平台实现管理，Linux 返回明确 unsupported。

## 状态与构建边界

状态目录名统一 agent-remote-control；开发使用 -dev，隔离预览显式使用 -preview。身份、环境变量和 deep link 不保留旧名 alias 或自动迁移。应用包只包含原生程序与静态资源，Node/npm 属于构建工具。CLI guide 与工具目录在构建时嵌入，改动后需要重新构建才能进入新产物。

## 权限与就绪

Core 汇总只读 permissions 状态，CLI doctor 与现有 overview 复用该结果。辅助功能及屏幕录制由 arc-screen 的 status 检测，工具只 preflight，缺失返回结构化 PERMISSION_REQUIRED。显式请求仅从 Desktop 权限页进入 helper request。Core 打开受 FDA 保护的 TCC 数据库做启发式探测，不读取内容；command 通过 Codex app-server 的 command/exec 单独执行零字节读取。未知状态不作已授权处理。

通知由 Desktop 查询 UserNotifications，主动授权仅由用户点击触发。Core 闭环兜底通过已有认证本地 Desktop 通道请求 permissions/notify；Desktop 不在线或缺授权时仅记日志，不调用 osascript。登录启动检查 LaunchAgent 与 launchctl print-disabled。入口验证复用 diagnostics，Claude 复用 CLI 定位并查询 auth status，Codex 登录复用 account/read。

权限页监听窗口焦点并支持手动刷新，系统设置跳转固定在本地 Desktop，不暴露新的 MCP 工具。

打包 Desktop 的启动链中，完全磁盘访问授权对象为 ARC App：Core 及其启动的 Codex app-server 子进程继承该应用身份。终端单独启动 Core 可能继承终端身份，不能用它的探测结果证明 App 已就绪。

Core 的 SubscriptionService 统一调度各 provider 额度，保存启用、刷新间隔、来源选择与固定窗口。原生凭据读取和上游响应归各 provider；成功读数缓存到 subscriptions/readings，恢复后标记 stale，失败退避，过期窗口隐藏。桌面 subscriptions:changed 与浏览器 /api/subscriptions/events 共用快照。旧缓存里的 history 字段读取时移除，不再采集本地用量、汇总 Token 或读取价格。

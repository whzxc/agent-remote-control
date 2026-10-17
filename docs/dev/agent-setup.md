# Agent 驱动的安装与配置（设计）

状态：P0 已完成；P1 macOS bootstrap 已实现 · 版本线：0.9.x patch

## 目标

从安装到第一次闭环，用户不需要理解公网地址、tunnel、OAuth、OpenAI Platform 等概念。本机 Agent（Codex / Claude Code）负责执行和解释，用户只做两件事：**做选择**、**完成授权**。

分工原则：**流程归 ARC，执行归 Agent，决策和授权归用户。**

- 流程知识放在 ARC 里（CLI 输出），不放在 prompt 和文档里，避免版本漂移。
- Agent 不需要读 GitHub 文档拼路径，只需循环调用 `setup`。
- 用户步骤必须有 ARC 可观测的完成信号，Agent 等信号而不是问"你弄好了吗"。

## 约束（实现时必须遵守）

- `setup` 是 onboarding / diagnostics 之上的薄层，**不是通用工作流引擎**。不做 DSL、不做插件化 step 注册、不做回滚框架。
- 状态尽量**从现有数据推导**（ingress 列表、onboarding stage/findings、verification、OAuth grants、permissions、codex login、任务记录）。只有无法推导的少量信息（当前 goal、用户在 decide 步骤的选择、用于判断新验证的 startedAt、派发回执与 Codex 线程链接）才落盘，放在 state dir 的一个小 JSON 里。
- Step 类型只有五种，不新增。
- 不新增防御性校验层：输入校验沿用 ingress add/update 已有逻辑。
- 秘钥永远不经过聊天和命令行参数。

## Goal

| goal | 含义 | 默认推荐 |
| --- | --- | --- |
| `claude-loop` | Claude（custom connector, HTTPS + OAuth）+ Codex，含 Claude Code 云端会话完成通知 | 是 |
| `chatgpt-chat` | ChatGPT Chat（OpenAI Secure Tunnel）+ Codex | 否；需要 OpenAI Platform 组织权限和 ChatGPT 开发者模式 |

`setup next` 未指定 goal 且尚未选择时，返回一个 `decide` 步骤让用户选 goal，`explain` 由 `setup.option.<goal>.explain` 两条共享文案组合，说明两条路的差异和门槛；App 只显示当前选中目标的说明。

## Step 模型

```json
{
  "schemaVersion": 1,
  "goal": "claude-loop",
  "progress": {"done": 3, "total": 8},
  "complete": false,
  "step": {
    "id": "choose-address",
    "kind": "decide",
    "title": "选择连接地址",
    "explain": "Claude 需要一个公网地址才能连到这台电脑。临时地址零配置，但 ARC 重启后会变，需要在 Claude 里重新添加连接器；固定地址一次配好长期可用。",
    "options": [
      {"id": "cf-quick", "label": "先用临时地址试试", "recommended": true},
      {"id": "fixed", "label": "使用固定地址（需要 provider 账号）"}
    ],
    "apply": "setup apply choose-address --stdin  {\"option\":\"cf-quick\"}",
    "openUrl": null,
    "doneWhen": "已保存地址方式",
    "playbook": "choose-address"
  }
}
```

字段说明：

- `steps: [{id, title, kind, done}]`：当前目标的完整推导序列，供 App 展示进度；未选择目标时为空。
- `cliPath`、`stateDir`：当前实例的 CLI 绝对路径和状态目录，供复制提示词；`dispatch`：已保存的派发回执及线程链接，未派发时为空。
- `explain`、`title`、`label` 按 ARC 当前语言（zh-CN / en）输出，供 Agent 原样转述，保证不同 Agent 的解释一致。
- `apply`：需要 Agent 执行的命令（auto / decide 用）。
- `openUrl`：需要打开的页面（authorize / remote-ui / secret 用），可以是 https 链接或 `agent-remote-control://` deep link。
- `doneWhen`：完成信号的人类可读描述。
- `playbook`：skill 中对应章节的 id，同时可用 `cli setup playbook <id>` 打印。

五种 kind：

| kind | 谁做 | Agent 行为 |
| --- | --- | --- |
| `auto` | Agent | 直接执行 `apply`，再 `setup next` |
| `decide` | 用户选 | 原样转述 `explain` + `options`，标出推荐项，拿到选择后执行 `apply` |
| `authorize` | 用户点 | 打开 `openUrl`，告诉用户点哪里，然后 `setup wait` |
| `secret` | 用户粘贴到 ARC | 打开 `openUrl`（ARC 内的输入位置）和取 token 的页面，`setup wait`；**绝不**让用户把秘钥发到聊天 |
| `remote-ui` | Agent 驱动浏览器，否则指引用户 | 按 playbook 用浏览器 / computer use 操作远端页面；登录、授权按钮停下交给用户；然后 `setup wait` |

## CLI

```text
arc cli setup [next] [--goal claude-loop|chatgpt-chat]   # 只读，返回当前 step
arc cli setup apply <stepId> --stdin                     # 提交选择或执行 auto 步骤
arc cli setup wait [--timeout <sec>]                     # 阻塞到当前 step 完成或超时（默认 60s），返回新的 next
arc cli setup playbook <id>                              # 打印对应 playbook markdown
arc cli setup reset                                      # 清除 goal 和选择（不动 ingress）
arc cli skill install --target codex|claude-code         # 安装 arc-setup skill
```

- 同时注册 catalog operation：`setup.next`、`setup.apply`、`setup.wait`、`setup.dispatch`，`cli mcp` 自然暴露。
- 输出沿用现有 JSON envelope。
- `next --goal` 只预览指定目标；`setup apply choose-goal --stdin` 的 `{"option":"claude-loop"}` / `{"option":"chatgpt-chat"}` 才保存目标和首次选择的 `startedAt`。重复选择同一目标不更新时间，切换目标清除旧选择。
- 地址选择及 ChatGPT 权限确认时先复用或创建未启动的 ingress，供后续 secret 表单编辑；`create-ingress` 负责启动及 probe。固定地址默认 Cloudflare named，可在现有表单选择其他 provider。
- readiness 步骤的跳过也作为选择保存。跳过 Claude Code 后，loop-test 只检查任务完成和 `ARC_ONBOARDING_OK` 回复，并返回通知不可用 finding。
- `verification.firstOAuthRequestAt` 记录此入口成功接受的 DCR/authorize 请求；`firstMcpRequestAt` 记录认证后到达 MCP 分发层的请求；`lastProbe` 记录 probe 的时间、URL 和是否通过。它们随现有 verification 绑定重置，不形成事件历史。
- deep link 契约：`agent-remote-control://ingress?id=<ingressId>&field=<credentialField>` 打开指定连接的编辑弹窗；并聚焦指定字段。权限入口为 `agent-remote-control://settings?section=permissions`。
- `setup wait` 超时不是错误，返回当前 step 原样，Agent 继续 wait。
- `apply` 幂等：同一 step 重复 apply 不重复创建 ingress（已存在则复用）。

## Step 序列

### claude-loop

| id | kind | 完成信号（从现有数据推导） |
| --- | --- | --- |
| `codex-ready` | auto / authorize | `codex.login.status` 已登录；未登录时变为 authorize，`apply` = `codex.login.open` |
| `claude-code-ready` | auto | 本机 Claude Code CLI 可用且已登录（沿用 doctor 中已有检测）；缺失时给 explain，允许跳过但闭环通知不可用 |
| `permissions` | authorize | doctor `permissions.items` 中 full-disk-access 和适用时的 command-full-disk-access 为 granted；辅助功能、屏幕录制、通知可选；`openUrl` 指向 ARC Settings → Permissions & readiness；允许跳过 |
| `choose-address` | decide | 选择已保存 |
| `address-secret` | secret | 仅选 fixed 时出现；对应 ingress 的 `hasXxxToken` 为真 |
| `create-ingress` | auto | ingress 存在、运行、probe 通过 |
| `add-connector` | remote-ui | 该 ingress 收到 DCR 或 authorize 请求（OAuth pending request 出现） |
| `consent` | authorize | 该 ingress 存在有效 OAuth grant |
| `verify-connector` | remote-ui | `verification.challengeVerifiedAt` 晚于本次 setup 开始 |
| `loop-test` | remote-ui | 出现带 `notifyClaudeSession` 的任务完成并且通知已送达（或任务完成、通知失败时给出 finding） |

### chatgpt-chat

| id | kind | 完成信号 |
| --- | --- | --- |
| `codex-ready` | auto / authorize | 同上 |
| `permissions` | authorize | 同上 |
| `chatgpt-prereq` | decide | 用户确认具备 Platform 组织权限和开发者模式；`explain` 说明门槛，选项包含"没有权限，改用 Claude" |
| `tunnel-credentials` | remote-ui + secret | Agent 引导到 Platform 创建 Tunnel；Tunnel ID 不是秘钥，可由 Agent 读取填入；runtime key 走 secret；完成信号为 ingress 存在 `tunnelId` 与 `hasApiKey` |
| `create-ingress` | auto | ingress 运行 |
| `enable-in-chatgpt` | remote-ui | 收到来自该 ingress 的任意 MCP 请求 |
| `verify-connector` | remote-ui | 同上 |
| `loop-test` | remote-ui | 任务回复 `ARC_ONBOARDING_OK` 并完成 |

缺失的完成信号（例如"收到 DCR/authorize 请求""收到任意 MCP 请求"若尚无可查询字段），只补最小的可观测字段，不新建事件系统。

## secret 输入（P0 做法）

P0 复用现有连接表单：`openUrl` 为打开该 ingress 编辑弹窗并聚焦对应凭据字段的 deep link（若现有 deep link 不支持则补一个最小路由）。P1 再考虑独立的轻量输入面板。

## arc-setup skill

- 源文件：`skills/arc-setup/SKILL.md`（英文），随 App 打包到 Resources；`cli skill install` 复制到 `~/.codex/skills/arc-setup/` 或 `~/.claude/skills/arc-setup/`。
- skill 只写三类内容：
  1. 循环协议：`setup next` → 按 kind 行动 → `setup next`，直到 `complete`。
  2. 规则：秘钥不进聊天；登录 / 授权 / 同意类按钮交给用户；完成与否以 `setup wait` 为准，不靠截图判断；decide 步骤原样转述 explain，不自行发挥。
  3. remote-ui playbook：按工具分三档——有浏览器工具（Claude in Chrome / Codex 浏览器 / IAB）则直接操作；只有 computer use / ARC screen 则截图导航；都没有则给链接和一句话指引。
- 流程本身不写进 skill（以 `setup next` 为准）；playbook 文本与 `cli setup playbook` 共用同一份源文件。

安装资源布局：macOS 为 `Contents/Resources/skills/arc-setup/`，Windows 为安装目录下的 `skills/arc-setup/`，Linux tarball 与已安装的 Core 旁为 `skills/arc-setup/`。开发构建在没有安装资源时从仓库读取。安装会替换目标 skill 目录，清除旧版本文件。

通知 delivery 的 `taskState` 保存原始任务状态（如 `completed`），setup 不匹配本地化的显示文案。旧记录缺少该字段时不作为新的完成证据。permissions 只要求磁盘访问；其他权限由用户选择。闭环测试由用户在远端会话发起，本机 Agent 只准备 prompt 和等待信号。

## App：默认"交给 Agent"

- 添加控制源第一屏：选择 Claude / ChatGPT（Claude 标推荐）。
- 主按钮（默认）：**发送给 Codex**。由 Core 直接创建一个 Codex 任务，prompt 为下方生成的短 prompt；工作目录使用 ARC state dir 下的 `setup-workspace/`（自动创建）；模型和推理强度不硬编码，沿用 Codex 默认配置。
- 次按钮：**复制给其他 Agent**（Claude Code 等）。
- 次按钮复制的提示词额外包含 `cli skill install --target claude-code`，用于 Claude Code；所有提示词都指定当前 `ARC_STATE_DIR`，保持实例隔离。
- 文字链接：**手动配置** → 现有表单。
- 发送后切换到进度视图：轮询 `setup.next`，展示步骤列表、当前步骤和"正在等你"的提示；authorize 步骤直接放操作按钮（例如打开 OAuth 批准、打开权限页）；提供"打开 Codex 任务"入口。决策在 Agent 对话里做，App 不重复展示选项。
- Codex 已安装但未登录时，主按钮为“登录 Codex”，复用 `codex.login.open`；次按钮仍为“复制给其他 Agent”。未安装时只保留一个主按钮“复制配置提示词”，提示中提供官方下载入口。
- 进度可见时每 2 秒读取 `setup.next`，页面隐藏时暂停；decide / remote-ui 只提示在 Agent 对话继续，secret 打开并聚焦现有凭据字段。完成态提供“返回首页”按钮。
- 步骤列表单列竖排；添加 Claude 连接器时直接展示连接地址和复制按钮。步骤的用户文案不暴露内部字段名、命令或 JSON 键。
- 全新状态目录不再预建默认 ChatGPT 入口。App 启动时，无入口且无 `setup.json` 自动打开配置入口；有 `setup.json` 且尚未完成时直接显示进度。`setup.next.hasState` 提供文件是否存在的事实；同一窗口关闭面板后不反复自动打开。
- 有未完成目标时，首页提供“继续配置”；已派发任务提供“打开 Codex 任务”。
- `setup.dispatch` 输入 goal：保存目标、安装 Codex skill、创建 `setup-workspace/`，复用现有 Codex create 和持久回执。显式发送表示该任务已获用户批准；模型、推理强度及执行所有者沿用已有默认设置。`setup.json` 中保存 `dispatch.requestId/threadId/desktopUrl`，重复派发读取同一回执，不重复创建线程。创建未确认或失败时保留回执并返回错误。

生成的短 prompt（按 App 语言，示例为中文）：

```text
帮我配置 Agent Remote Control，目标：claude-loop。
ARC CLI：<绝对路径>。执行命令时将 ARC_STATE_DIR 设为 <当前状态目录>。先运行 `"<cli>" cli setup playbook protocol` 了解协议，然后循环 `"<cli>" cli setup next` 推进。
我只负责做选择和授权：decide 步骤把 explain 和选项转述给我；需要我操作的步骤告诉我点哪里，再用 `setup wait` 等待；不要让我把任何秘钥发到对话里。
```

## 文档

- README / README.zh-CN 顶部提供安装后的“发送给 Codex”入口，以及指向公开 `skills/arc-setup/SKILL.md` 的一句本机 Agent 提示词。
- `docs/auto-setup.md`（及 zh-CN）：一段通用提示词、App 一键入口，以及选择、登录授权、ARC 内填写凭据、远端会话测试四类用户参与步骤。
- `docs/reference/cli.md`：维护 setup / skill 命令及 `setup.dispatch` 契约（英文）。
- getting-started 保留手动路径，但把 Agent 路径放在前面。

## P0 实现与原设计的差异

- 权限必需项收窄为完全磁盘访问及适用时的命令磁盘访问；辅助功能、屏幕录制和通知为可选，避免与基本连接无关的权限阻塞配置。
- `setup.next` 增加完整推导序列 `steps`，供 App 直接展示进度，不另存工作流状态；`cliPath/stateDir` 用于生成指向当前实例的提示词。
- 新增 `setup.dispatch`，复用现有 Codex 任务创建和持久回执；小型状态文件同时保存派发标识与线程链接，用于重复点击复用和重入。
- 本机 Agent 负责配置和生成测试提示词，闭环验证由用户在 Claude Code 云端会话或 ChatGPT 对话中发起，避免把本机任务误认为远端闭环。
- 未登录和未安装采用不同入口；完成态保留“返回首页”按钮，供用户确认结果后回到拓扑。

## 分期

- **P0（本次）**：`cli setup next/apply/wait/playbook/reset` 与 catalog operation；arc-setup skill 与 `cli skill install`；App 默认"发送给 Codex"入口与进度视图；文档调整。
- **P1**：macOS bootstrap 已实现；独立 secret 输入面板待实现。
- **P2**：临时地址变化后的自愈（Agent 自动更新连接器 URL 并重新授权）；固定地址路径自动化；Windows / Linux bootstrap。

## P1：新机器 bootstrap

唯一的 Agent 入口指向仓库的 `skills/arc-setup/SKILL.md`。skill 先检测本机 App / CLI，缺失时下载并运行稳定 release 地址的 `install-agent-remote-control.sh`；随后给当前 Codex 或 Claude Code 安装 skill，并进入 `cli setup`。不另维护一套安装 prompt，不挂载 DMG。

同一脚本覆盖 macOS 与 Linux：

- macOS 通过 `releases/latest` 重定向确定版本，或使用 `ARC_VERSION` 指定 tag；不依赖 jq。下载 `agent-remote-control_<版本>_<架构>.app.tar.gz`，用系统 `shasum` 对照 `SHA256SUMS.txt` 校验。缺少 Intel Mac 资产时明确报错。
- 默认安装到 `/Applications/Agent Remote Control.app`；`ARC_INSTALL_DIR` 指定父目录。相同版本跳过下载和替换，其他版本先退出目标 App 再替换，移除 quarantine 并打开 App。`ARC_STATE_DIR` 指向本次实例，CLI 与 App 使用同一目录。
- 新的 Agent 安装会预建只有空选择的 `setup.json`，不替用户决定目标；App 因此进入进度视图，等待 Agent 继续。已有配置不覆盖。
- 等到 App 可通过 Core 查询后，最后一行输出 `{"version":"<版本>","cliPath":"<绝对路径>","stateDir":"<绝对路径>"}`。后续命令沿用这些路径。
- Linux 保持现有 headless tarball、checksum 与用户目录安装流程。完整 bootstrap 依赖 release 同时包含更新后的安装脚本、setup CLI、skill 资源和首次启动界面。

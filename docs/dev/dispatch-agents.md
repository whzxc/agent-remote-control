# 多 Agent 派发策略

[现有派发策略](dispatch-policy.md) · [Agent 契约](../reference/agents.md) · [订阅额度](../reference/subscriptions.md)

本文定义多 Agent 扩展的实施边界。Codex 已有派发、验收和汇总行为见现有派发策略；下文标为“目标”的字段和操作须完成对应阶段后才可调用，当前契约以 guide 为准。

## 能力来源与证据

模型属于 Agent 当前启动配置和提供商，不能仅凭 Agent 名称推断。模型目录、原生配置确认、单轮实际执行是三个不同层次。目录列出的选项不等于账号有权执行；配置 RPC 成功也不能证明服务端实际使用该模型。

能力矩阵中的“握手”指实际启动相应版本、读取 initialize/session/new；未发送推理请求，不代表模型切换或推理验收通过。“源码”指原生安装包或 magpie 实现。具体机器的安装、认证、额度和会话信息由查询返回，不固定进文档。

| Agent | 模型来源 | 可选维度 | 设置粒度与可用证据 | 额度来源 | 依据与未验证部分 |
| --- | --- | --- | --- | --- | --- |
| Codex | app-server `model/list` | 模型原生 efforts、serviceTiers | 线程默认及单轮覆盖；持久化 turn_context；tier 证据限制见现有文档 | ARC `codex-account` / `account/rateLimits/read` | ARC 当前实现；跨 Agent 扩展需跑现有回归 |
| Claude Code | ACP `configOptions` 的 model | effort、fast、mode；effort 随模型改变 | 会话设置，在新轮之前应用；set_config_option 返回全量配置，实际模型仍需轮次证据 | 现有 `claude-code` provider，原生 OAuth usage | adapter 0.79.0 / CLI 2.1.304 握手；切换和实际推理待验 |
| Cursor | 原生登录后 ACP model options | mode；effort/context/fast 等编码在 modelId 中，不自行拆分枚举 | 会话配置；先 authenticate(cursor_login) 复用原生登录；返回配置可确认会话选择 | 现有 Cursor DashboardService / usage-summary | 2026.09.18 握手及 authenticate 成功；ARC driver 尚未接 authenticate；切换/推理待验 |
| Grok | ACP models/configOptions；原生 settings 模型目录 | reasoning_effort；Fast 是独立模型；contextWindows 元数据暂不作为可写字段 | 会话配置；set_config_option / 原生更新可确认选择 | 现有 grok provider：credits 与 CLI settings | 1.0.62 握手；切换/推理待验；magpie `agent/grok.go` 读取原生目录 |
| DeepSeek Harness | ACP profile 的分组 model options | reasoning_effort；官方模型示例 off/low/high/max，以切换后返回值为准 | 会话设置；model 是原样保留的 JSON 数组编码字符串；Desktop 默认不代表 ACP 默认 | 尚无 ARC provider；DeepSeek API balance 只证明 API 余额，不能冒充账号订阅额度 | 0.2.1-rc.2 握手；magpie `agent/dsh.go` 的 profile/default-model；切换/推理待验 |
| Pi | 原生 RPC get_available_models，安装包 registry 与用户 providers | get_available_thinking_levels；原生模型支持的 thinkingLevel | 会话内 set_model、set_thinking_level；get_state 确认，assistant message 的 model/provider 可补轮次证据 | 按 provider；不把 Codex/Claude 的其他登录额度直接挂到 Pi | Pi 1.3.0 RPC 类型及 magpie `agent/pi.go`、`nativemodels.go`；未实测推理 |
| OpenCode | 原生 providers/model 配置及 ACP 会话目录 | 仅接握手公开的模式/配置，不把配置文件字段当作 ACP 参数 | 会话配置；必须取得对应版本握手和设置响应 | 现有 opencode-go provider 只覆盖 Go，不代表其他 provider 或 Zen 的余额 | magpie `provider/opencode_client.go`、`opencode_endpoints.go`；未实测 ACP 选择 |
| Gemini | 原生 model.name / ACP 会话目录 | 仅接原生会话公开维度 | magpie 配置只证明启动选择；ACP 待验 | magpie Google 登录额度；不能用 Antigravity 额度替代 | magpie `agent/gemini.go`、`provider/google.go`；未实测 |
| Kimi | config.toml 的 models/providers、default_model | Kimi Code support_efforts/default_effort 与 kimi-cli 的 thinking 开关有区别 | magpie 修改新会话默认；ACP 待验 | ARC kimi-code 当前接受显式保存的 key，`coding/v1/usages`；不能推断本机登录已被复用 | magpie `agent/kimi.go`；未实测 |
| Qwen | modelProviders 与 model.name/baseUrl | 仅接原生会话公开维度 | 启动默认或原生 /model；ACP 待验 | 未接入，待确认原生登录额度源 | magpie `agent/qwen.go`；未实测 |
| Oh My Pi | 自身 pi-catalog、用户 models 配置 | 原生 thinking，角色模型与默认 thinking 是不同配置 | 原生配置在启动读取；ACP 待验，不能套用 Pi RPC | 按 provider，未接入 | magpie `agent/omp.go`、`nativemodels.go`；未实测 |
| Copilot | ACP 会话目录待验 | 未确认 | ACP 设置与轮次证据待验 | magpie `provider/copilot_accounts.go`、`subscription_usage.go`；ARC 未接入 | 额度源码可参考，模型设置无实测 |
| Kiro | ACP 会话目录待验 | 未确认 | ACP 待验 | magpie `provider/kiro.go`、`kiro_accounts.go`；ARC 未接入 | 未实测 |
| Droid | 原生模型目录、ACP 待验 | 不从其他 Agent 推断 effort | ACP 待验 | magpie `provider/factory_usage.go`、`factory.go`；ARC 未接入 | 源码参考，未实测 |
| Devin | 原生 provider 目录、ACP 待验 | 未确认 | ACP 待验 | magpie `provider/devin.go`；ARC 未接入 | 未实测 |
| Cline | 原生 provider 配置、ACP 待验 | 未确认 | ACP 待验 | magpie `provider/cline_usage.go`；ARC 未接入 | 未实测 |
| CodeBuddy | 原生配置、ACP 待验 | 未确认 | ACP 待验 | 不等同 WorkBuddy；未确认 | magpie `agent/codebuddy.go`；未实测 |
| Goose | 原生 provider 配置、ACP 待验 | 未确认 | ACP 待验 | 按 provider，未接入 | magpie `agent/goose.go`；未实测 |
| Hermes | 原生 provider 配置、ACP 待验 | 未确认 | ACP 待验 | 按 provider，未接入 | magpie `agent/hermes.go`；未实测 |
| Junie / 自定义 ACP | 对应进程握手 | 只接受实际公开字段 | 未提供目录或设置契约时保持原生默认 | 未确认 | 不为缺少可靠来源的维度添加支持 |

ACP 优先使用 [configOptions](https://agentclientprotocol.com/protocol/v1/session-config-options)，保留 option ID、原生 value、分组和 category。旧版仅提供 models/modes 时使用其对应会话操作；不是 ARC 旧工具兼容层。按模型切换后的返回结果更新维度，不能缓存一套通用 effort 等级。

magpie 参考版本为 [`2374ffe1`](https://github.com/yetone/magpie/tree/2374ffe1)。`internal/usage` / `usageapi` 汇总历史调用，`provider` 读取上游订阅窗口、计划额度与余额，`catalog` 提供目录；`budget` 是 magpie 自身网关 key 的预算与在途预留。ARC 只吸收与原生读取有关的逻辑，不移植网关、账号轮换、估算预留或自动路由。移植实质代码时保留 MIT 的 `Copyright (c) 2026 yetone` 和完整许可证，并纳入随包声明。

## 查询目标

保持 MCP 外层 guide/query/act 原样。`dispatch_policy` op 增加可选 `agent`，只返回指定 Agent；缺省列出全部登记 Agent，包含未安装和禁用状态。可选 `taskId` 必须与非 Codex agent 一起使用，查询具体会话的配置事实。

按 Agent 返回以下信息：

- availability：installed、available、enabled；authentication 单独描述来源与时间。成功 quota 读取只证明额度入口认证，不等价于 ACP 或某个模型的推理认证。
- models/options：原生 ID、名称、当前值、来源和观察时间。没有会话目录时明确 unavailable/needs-session；查询不偷偷创建或恢复会话。初始化可用现有的空 prompt `agent_create`，再按 taskId 查询。
- quota：复用 SubscriptionService 的同一份窗口快照、provider ID、observedAt、stale/error 状态。不另起额度轮询器、不复制凭据；未接入不写成零。同一 Agent 使用多个 provider 时只展示已知关联的额度，不能宣称额度一定适用于当前模型。
- policy/history：明确哪些已生效。目录较大时全量查询只给有界预览和 omitted 数量，单 Agent 查询给完整目录。禁用 Agent 不启动进程。

查询返回 `observedAt` 与 `agents` 数组，每个元素带 agent。Codex 的 models、policy、quota、history 位于其元素内，额度与 history 语义保持不变；非 Codex 的会话事实位于 capabilities。非 Codex 尚未接入策略与历史时分别标记 native-default 和 unavailable，selectionSupported 为 false，不能将空历史伪装成已经统计。

## 策略文件目标

继续使用顶层按 Agent ID 分节，加一个顶层 `criteria` 字符串即可，不增加规则引擎或配置版本迁移框架。全局 criteria 描述任务与 Agent 的匹配；每节 criteria 描述该 Agent 的模型/档位选择，均由控制源理解，ARC 不自动解释。

```json
{
  "criteria": "",
  "codex": {
    "model": null,
    "effort": null,
    "serviceTier": null,
    "serviceTiers": {},
    "allowModels": [],
    "denyModels": [],
    "allowEfforts": [],
    "denyEfforts": [],
    "criteria": ""
  },
  "claude": {
    "model": null,
    "options": {},
    "allowModels": [],
    "denyModels": [],
    "allowOptions": {},
    "denyOptions": {},
    "criteria": ""
  }
}
```

此例是目标出厂配置，不覆盖已有文件。已有 codex 节、criteria 和模型 tier 覆盖表原样保留；缺失 Agent 节等价于空策略，不为所有 Agent 写空对象。null/缺省表示不写原生配置，新会话跟随原生默认，续轮继承会话当前值。已有 Codex 非空默认继续生效。

非 Codex 的 model 使用原生不透明 ID；options 按原生 config ID 保存字符串值，Pi 使用 thinkingLevel。模型不在 options 中重复声明。选择优先级是显式参数、Agent 策略默认、原生当前值。禁止列表优先，空允许列表不限；检查最终选择，包括已知原生默认。有限制但无法确认最终值时明确报错，不静默绕过。格式错误不回退。模式可能改变 Agent 权限行为，保留原生含义，不把 mode 统一解释为推理等级。

## 派发、记录与验收目标

`agent_create/agent_send` 增加 model、options、reason、purpose；Codex 的 model/effort/serviceTier 参数保持现状。只处理有契约的维度；未知或不支持的显式选择在 prompt 前报错。空 prompt 创建用于取得会话目录，不算一次派发。

在已有请求幂等判定之后解析策略，持有同一任务派发锁，检查 idle/终态，依次设置 model、读取更新后的 options、设置其余选项、确认结果，然后提交 prompt。运行中不切换配置。多个设置 RPC 不具备原子性：部分成功后失败要返回已确认配置且不发送 prompt；下次读取真实状态再决策，不伪造回滚。

Pi 用 set_model + set_thinking_level，再用 get_state 回读；ACP 用会话配置操作及响应/更新。配置选择默认只影响 ARC 会话，不改写原生用户配置文件。Cursor 仅用其声明的 cursor_login 方法复用已有登录；需要交互式登录时返回原生失败，不自动启动登录或换账号。

记录复用现有 dispatches 存储和互斥，新增 agent/taskId/options，旧 Codex 无 agent 记录按 codex 解释。区分 submitted configuration、native session confirmation、native turn evidence；保存作用域与时间，不用最新会话值回填旧轮次。Pi/ACP turnId 仍为 ARC prompt UUID。进程退出、超时或未知提交不能标成成功派发/终态，也不能自动重发。

保留 codex_review，增加 agent_review（agent、taskId、可选 turnId、verdict、note）。两种 op 共用记录更新、返工关联和汇总逻辑，原生终态获取仍由各 driver 负责。比统一 op 更少改动，也避免改变 Codex threadId 的契约。验收只针对已有终态派发；省略 turnId 选择最近可确认终态，running 不可验收。

历史按 agent + model + 原生选项分组，保留 Codex effort/serviceTier；self-test 不参与真实汇总。原生重试继承仅保留 Codex 已有规则，不能凭 Pi/ACP 的新消息推断一次新派发。未能可靠归属的 provider/单轮 token/费用保持未知。

Loop guide 在派发阶段交付后简写为：派发前查 dispatch_policy，选择 Agent 和其原生档位并写一句 reason；失败按准则在同任务续轮；审查终态后用 codex_review 或 agent_review 提交 pass/rework。动态模型和额度不塞进 guide。

## 分阶段边界

1. 能力矩阵与设计：区分握手、源码推断与未支持维度；不改本机策略。
2. 只读事实查询：Agent 筛选、安装/启用状态、同源额度、会话模型和选项；Codex 查询不回退。
3. 派发闭环：原生默认策略、默认值/约束、配置确认、记录、agent_review、返工、汇总和 Loop guide 一起交付。先覆盖可验证的 Pi/ACP 标准能力。
4. 其他 provider：逐个将有可靠来源的读取逻辑放入 subscriptions/providers，补充认证、额度和模型归属证据。未安装或无可靠来源的 Agent 不宣称支持额外维度。

实现阶段运行全部既有检查，不新增测试用例。构建并替换本机应用后，用 purpose:self-test、无 notify 的临时任务验证默认值、显式选择、禁用、幂等、记录/验收/返工和汇总排除；配置确认与推理证据分别报告。自测结束关闭进程、删除自己创建的任务及原生会话；不支持删除的原生端按精确 ID 清理。保留原 Codex 策略字节内容并复核。

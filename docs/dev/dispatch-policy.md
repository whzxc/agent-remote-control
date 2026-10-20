# 派发策略

[控制循环](control-loop.md) · [架构](architecture.md)

## 定位

决策放在控制源，事实与约束放在 ARC。控制源持有任务上下文，按用户准则选择模型和推理等级；ARC 提供设备原生模型目录、额度摘要、策略默认值及派发记录。额度只供决策参考，不自动降级或拒绝任务。

任务少、耗时长、单次价值高，降级代价通常高于升级代价。本期不引入路由模型或高速决策模型。先积累档位、耗时和验收结果；只有这些数据足以比较质量、成本和路由收益时，再评估独立路由模型。

## 配置与查询

状态目录下的 `dispatch-policy.json` 首次使用时生成，两空格缩进并以换行结束；备份恢复也保留格式化 JSON。手工编辑后下一次读取生效。按 Agent 保存策略，目前只支持 Codex：

```json
{
  "codex": {
    "model": "gpt-6-astra",
    "effort": "medium",
    "serviceTier": null,
    "serviceTiers": {},
    "allowModels": [],
    "denyModels": [],
    "allowEfforts": [],
    "denyEfforts": [],
    "criteria": "机械性改动、发布用 medium；根因不明的调试、跨模块重构、架构设计用 high；验收不过或同一问题失败一次后，在同一线程升到 xhigh 续轮。"
  }
}
```

`serviceTier` 是可空的全局默认值，`serviceTiers` 是模型 ID 到 tier 的覆盖表。出厂为 null / 空表，不表达速度偏好，交给原生继承；例如 `"serviceTiers":{"some-model":"priority"}`。Fast 使用原生目录 ID `priority`，标准速度使用 `default`；`additionalSpeedTiers` 中的 `fast` 是速度标签，不作为派发参数。官方说明直接保留，不推算用量倍率。

显式 tier 优先于模型覆盖，再取全局默认；按最终选定模型查表，每次新轮重新选择，包括同线程换模型。原生 turn.serviceTierForTurn 优先于 turn.serviceTier、顶层 serviceTier 和 thread.serviceTier；单轮覆盖不修改线程默认。字段来源为 explicit / policy-default / native-default（未填充）。

允许列表为空表示不限；禁用列表优先。约束作用于最终选择，包括策略默认值。模型与推理等级是否受原生端支持由上游校验，不复制原生校验规则。配置格式错误明确报错，不静默回退到桌面默认值。

`query({op:"dispatch_policy",args:{}})` 返回模型 ID、支持的推理等级及 serviceTiers 的原生 ID、名称、说明和 defaultServiceTier、上述策略，以及 `codex_account` 同源的额度池与窗口摘要和近 30 天的 `history`。省略账号身份、无关模型说明和完整原生配置；各事实读取失败时标记不可用，保留其余结果，不把未知额度当作零。

Loop guide 引导所有控制源派发前查询此 op，再显式传 `model`、`effort` 和一句 `reason`。动态目录与额度不内嵌到每次 guide，避免重复大段输出。使用旧显式 allowlist 的入口需启用 dispatch_policy；默认预设包含此只读 op。

## 派发与记录

`codex_create`、`codex_send` 增加可选 `reason`，MCP 的 `guide/query/act` 外层不变。新轮次缺省的 model、effort 分别取 ARC 策略默认值，单独传 effort 可用于同线程升级。原生 `turn`、协作模式及创建线程参数中的显式选择同样受约束；实际发送给线程与轮次的配置保持一致。

请求先按原始参数做幂等判定，再固定选择；相同 requestId 回读原回执，不因策略修改再次派发。队列在实际执行时选择默认值；自动容量重试沿用原轮次已选配置。运行中的 steer 不改变当前轮次配置；显式要求不同档位时返回错误，提示等待终态或排队续轮。

每次成功派发按线程保存 requestId、turnId、model、effort、serviceTier、reason、各字段来源（explicit / policy-default；steer 为 active-turn）、派发方式与时间，并关联到任务回执。`codex_tasks` 的 full 视图展示派发历史；完成、失败及中断通知附带本轮记录。原生持久化轮次配置可用时补充实际配置证据；不可用时仅说明 ARC 提交的配置。

原生 turn_context 缺少 service_tier 时，effectiveConfiguration.serviceTier 保持 unknown。threadServiceTier 单独展示持久化 thread_settings_applied 在该轮 task_started 前的最后值，仅证明线程配置，不能证明单轮 serviceTierForTurn 覆盖；不使用轮次结束后的最新设置回填旧轮。统计优先使用轮次原生 tier，否则用提交值，均缺失时归 unknown。

终态记录派发至首次观察到终态的耗时，明确这是观察耗时，包含调度与观察延迟。

## 验收与返工

`act({op:"codex_review",args:{threadId,turnId?,verdict:"pass"|"rework",note?},requestId?})` 写入控制源的验收结论。省略 turnId 时，读取原生线程最近一个终态轮次（可越过仍运行的最新轮次）；目标必须有 ARC 派发记录。非终态或没有派发记录时明确报错，不替其他轮次作判断。

每轮的 `review` 保存 verdict、note、reviewedAt 和 requestId。同轮改判覆盖旧结论，统计以最后一次为准；安全重试沿用 requestId，改判使用新 requestId。验收写入与派发共用线程锁，完成观察补写元数据不会覆盖验收结论。

rework 后同线程的下一次新轮派发保存 `reworkOf:<原轮次 ID>`，steer 不消耗返工关联；多次改判以派发当时最新的有效 rework 为准。关联创建后保留，不因对旧轮次的后续改判重写历史。队列在实际派发时建立关联。`codex_tasks view:full` 的 dispatches 可回读最新结论和返工关系；已产生的完成通知仍是产生时的快照。

## 历史汇总与用量边界

`dispatch_policy.history` 按 submittedAt 统计最近 30 天的新轮次，按 model + effort + serviceTier 分组；优先采用原生有效配置，不可用时采用 ARC 提交配置。同轮重复记录去重，steer 不另算一轮。每组包含 dispatches、pass、rework、failed、interrupted、unreviewed；失败与中断优先单独计数，不计入验收或未评定。未评定包含尚在运行及成功终态未评定的轮次。只有成功终态的轮次参与 medianObservedDurationMs，并以 durationSamples 标明样本数。

`purpose:"self-test"` 不进入真实统计，续轮省略 purpose 时沿用该线程最近派发标记，显式 purpose 可覆盖。验收结论不能改变此标记。无数据组不输出；最多显示派发次数最多的 12 组，其余以 omittedGroups 披露，保持响应在几 KB 量级。查询实时读取记录，改判立即反映在汇总中。

当前 app-server 的 Turn / turn/completed / thread/turns/list 不提供单轮 token 总量。thread/tokenUsage/updated 虽含 turnId，其 last 对应最近一次模型响应，total 对应线程累计用量；account/usage/read 的 threadUsage 是线程级估算。它们都不满足可靠单轮总量的要求，因此目前不保存单轮 token，也不输出平均单轮 token；不差分、不估算，不将缺省写成零。原生提供可直接关联终态轮次的完整用量后再接入。字段语义参见[原生协议](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)。

## 分期与限制

- P0：配置文件、紧凑查询、guide 引导、默认值与约束、同线程升级、逐次记录及通知。无策略编辑 UI，无自动质量判断。
- P1：控制源验收结论、同线程返工关联、近 30 天档位汇总及自测排除。单轮 token 受上述原生契约限制保持缺省。
- 后续：原生单轮用量可用后再补平均值；有足够验收样本后评估选择准则与路由收益。策略 UI 按实际需求增加。

策略约束覆盖上述派发 op，不是底层原生 API 或用户直接操作 Codex 的安全边界。ARC 不替控制源判断任务复杂度、自动提档或宣称验收通过。

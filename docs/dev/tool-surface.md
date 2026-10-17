# 固定工具面与渐进式披露

状态：已实现 · 版本线：0.9.x patch

## 背景

控制源客户端会缓存工具定义：

- Claude 会话内已加载的工具定义不会随刷新更新，只会补充新出现的工具。0.9.15 去掉 `notifyClaudeSession` 后，进行中的 Claude 会话既传不了旧参数（服务端拒绝），也传不了新参数（客户端缓存的 schema 拒绝），通知能力悄悄失效。
- connector 的权限按工具记录，每新增一个工具，“总是允许”就会变回 Custom，需要用户重新授权（`guide` 上线时已复现）。
- 四五十个工具定义常驻控制源上下文，token 开销大，工具选择也更容易出错；分散在各工具 description 里的“天然文档”也不如集中维护的 guide 可靠。

## 决策

把面向控制源的 MCP 工具面收敛为**少量、冻结的工具**，能力变化全部通过服务端实时维护的 **op 目录** 与 **guide** 渐进披露。

用户倾向（已确认）：

- 不在意权限粒度，倾向于尽量授权给 AI。读写拆成两个入口不是为了权限控制，而是为了让客户端按只读处理查询类调用（例如 ChatGPT 对写操作的逐次确认、安全审查对只读操作的放行）。
- 模型对“转发入口”不如原生工具熟练的问题，用 guide 中的现成调用示例解决。
- 分类器对新形态的观感后续实测，不预先设计。

## 工具面（冻结）

| 工具 | annotations | 作用 |
| --- | --- | --- |
| `guide` | readOnly | 编排指南（loop / notify / review / approvals，按控制源区分）、op 索引、常用 op 的调用示例；`op` 参数返回指定 op 的完整 inputSchema 与示例 |
| `query` | readOnly | 执行只读 op：`{op, args}` |
| `act` | 写 | 执行写 op：`{op, args, requestId?}` |

- `query.args` / `act.args` 的 schema 是宽松对象，真正的校验在服务端按 op 的 schema 进行。`act.requestId` 透传到现有 op 参数并优先于 args.requestId；仅用于支持该字段的 op（包括读取原操作的 receipt），其他 op 省略。
- guide 参数冻结为 `{topic?, op?}`，op 优先于 topic；query 为 `{op,args}`，act 为 `{op,args,requestId?}`。调用错误入口返回 WRONG_TOOL 与正确入口及示例。
- **op 名沿用现有工具名**（`codex_create`、`codex_wait`、`read`、`git` 等），现有知识、guide 文案和回执里的 `next.tool` 直接复用，只是外层变成 `query` / `act`。`next` 改为 `{hint, via: "query"|"act", op, args}`；无建议调用时只返回 hint。readNext 与通知事件的后续调用采用相同 via/op/args。
- 每个 op 归属 query 或 act，依据现有 annotations 的 readOnlyHint；混合读写操作（如 receipt、screen、mcp、codex_thread）整体归 act，不按 action 再拆入口；connector_verify 修正为写操作。`codex_call`、`codex_schema` 等原生协议透传也作为 op 保留。
- `connector_verify` 并入 `act` 的 op；setup 生成的验证提示词改为写明完整调用。
- 现有的工具档位（默认 / 只读 / 全部 / 自定义列表）语义保留，作用对象从 MCP 工具变为 op：未启用或本机不可用的 op 不出现在 guide 索引中，查询其 schema 或调用时都返回 OP_UNAVAILABLE。三个 MCP 工具不受档位影响；只读档保留 connector_verify 维护例外，仍通过 act 调用。现有 allowlist 保持原 op 名，启动时移除不再属于 op 的 guide。
- 这三个工具的名称与参数结构**冻结**：今后发版不得改名、删除或修改其参数结构。能力变化只能通过 op 与 guide 发生。把这条写进 AGENTS.md，作为“不保留兼容层”规则旁边的工具面约束。

## 自愈与版本提示

- **参数错误**：复用现有 jsonschema validator；op 校验失败时，错误结果附带该 op 当前的 inputSchema 与一个最小示例，控制源一次即可纠正。
- **未知 op**：返回最接近的候选已启用 op 名（最多三个），并提示调用 `guide` 查看索引。op 改名不需要兼容层，靠这条自愈。
- **版本提示**：所有工具结果附带 `arcVersion`（嵌入 catalog（包含 guide、op schema、示例与档位元数据）的 SHA-256 前 12 位）。guide 告诉控制源：发现 `arcVersion` 与自己读 guide 时不同，就重读 guide。与 `arcInbox` 同样以捎带方式实现，不新增工具。对象结果直接加字段；数组、标量、null 始终包装成 `{value, arcVersion}`，存在未读事件时再附带 arcInbox。此版本标识内容版本，不是应用版本；本地档位与可用性变化直接重读 guide，不改变内容哈希。

## guide 内容调整

- 首次调用 `guide`（默认 topic=loop）返回：当前控制源的 loop、通用要点、常用 op 的现成调用示例（`act codex_create`（Claude 示例含 notify；ChatGPT 与其他控制源按当前能力使用等待与收件箱）、`act codex_send`、`query codex_wait`、`query codex_read` / `codex_changes`、`query read` / `search`），以及其余 op 的一行索引。
- `guide({op: "<name>"})` 返回单个 op 的完整 schema、说明与示例。
- 内容保持短小；索引只展示说明首句，单个 op 返回现有 description 全文，不重写语义。每个 op 的最小参数示例与 schema 一起维护在现有 catalog；不生成猜测性的 schema 示例。
- MCP `instructions` 改为：先调用 `guide`；所有能力通过 `query` / `act` 调用。

## 需要同步的地方

- control-loop 设计文档 §6 与 guide 文案中的工具调用写法。
- `docs/reference/tools.md` 改为 op 参考；用户文档（guides、getting-started、FAQ）中的工具调用示例。
- setup 流程与 skills 中引用工具名的地方（例如验证提示词、loop-test）。
- transport 中对 `codex_wait` / `agent_wait` 的超时特殊处理，改为按 op 识别。
- `arcInbox`、`next`、已读判定等按 op 名识别的逻辑。
- ARC 设置页中的工具列表与权限状态展示。

## 约束

- 一次性迁移，不保留旧工具别名（工具面冻结之后不再需要）。
- 不新增防御性校验层；op 校验沿用现有 schema 校验。
- 不新增测试文件或用例；迁移已有测试，运行已有检查与真实验收。
- 这是最后一次需要用户刷新工具并重新授权的变更，发版说明需写明。

## 验收

- `tools/list` 只返回 `guide`、`query`、`act`；op 目录与现有工具能力一一对应，档位设置作用于 op。
- 在新的 Claude 会话中：调用 `guide` 获得 loop 与示例 → 用 `act codex_create` 带 `notify` 派发 → 收到 `[ARC]` 通知 → 用 `query` 审查。
- 故意传错参数与未知 op 时，错误结果足以让控制源一次纠正。
- 修改 guide 内容后，`arcVersion` 变化并出现在任意工具结果中。
- 运行已有检查与测试通过。

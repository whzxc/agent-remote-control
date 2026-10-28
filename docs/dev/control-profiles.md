# Control-source capability profiles

MUST means a requirement.
SHOULD means the default unless a concrete task-specific reason justifies an exception.
MAY means an option.

## Boundaries

Profiles specialize discovery without changing execution authorization.
Existing sources remain Legacy until explicitly changed through local management.
Local management exposes profile recommendations without changing the ingress policy.
The frozen boundaries are described in [Tool surface](tool-surface.md), [Tools](../reference/tools.md), and [CLI](../reference/cli.md).
`operations.rs` retains ownership of durable management receipts and unconfirmed-write handling.

## Dimensions and derivation

| Dimension | Values | Authority |
| --- | --- | --- |
| Host access | `host`, `none`, `unknown` | Built-in local authority or the saved source preference. |
| Wait mode | `background-cli`, `push`, `poll` | Explicit source preference. |
| Transport | `cli`, `mcp` | Actual request entry point. |

| View | Host access | Wait mode | Transport |
| --- | --- | --- | --- |
| Legacy | No profile opt-in | Existing behavior | CLI or MCP |
| Local Code | `host` | `background-cli` | Built-in CLI only |
| Remote push | `none` or `unknown` | `push` | MCP |
| Remote polling | `none` or `unknown` | `poll` | MCP |

Local Code MUST require the authenticated built-in authority identified by `ingressId:local-cli` and `credential.type:local` through `arc cli control`.
A product name, loopback address, local MCP connection, or OAuth client name MUST NOT establish Local Code authority.
The `claude` OAuth source can be shared by Code, Chat and Cowork.
An MCP request from that source MUST remain Legacy, Remote push, or Remote polling.
Host access refers to the ARC execution host rather than a remote controller's sandbox.
Background session re-invocation is provided by the controller's command facility rather than ARC.
Local CLI callers share one setting because they share one built-in authority.

`capabilityProfile` stores `{hostAccess,waitMode}` on the stable source record.
An absent or null setting means Legacy.
Local authority accepts only `host` with `background-cli`.
MCP sources accept only `none` or `unknown` with `push` or `poll`.
The effective guide profile reports its name, host access, wait mode, observed transport, and provenance.
Profile overrides MUST remain attached to the stable source ID across connection switches.
Account merges MUST NOT copy settings to sibling sources.
Built-in local authority MUST remain excluded from ordinary source/account lists and protected from revocation.

Use `cli source update <id> --stdin` to save a setting through authenticated local management.
Use the `sourceId` returned by `cli control guide` to update built-in local authority.
New sources expose `capabilityProfileOffer` in local source readback until explicitly selected.
The offer recommends Remote push for ChatGPT and Claude and Remote polling for other products.
Unknown products receive an `unknown` host-access recommendation.
Profile selection in this version is available through authenticated local management and the CLI.

## Projection

Profiles filter initial discovery only.
Per-op schema reads, full discovery, and execution MUST use the existing effective op policy and runtime availability.
An omitted initial-guide op remains callable when its policy permits it.
Users requiring execution restrictions MUST use the existing op allowlist.
This preserves recoverable discovery at the cost of not automatically minimizing execution capabilities.
`toolExposure.tools[op].presets` owns profile and topic membership.
Existing groups, default/advanced tiers, conditional availability, required ops, and dependency normalization remain authoritative.
Selecting a profile MUST NOT rewrite saved allowlists or expand dependencies.
The existing common/readOnly/all/custom policy meanings remain unchanged.
Mixed operations MUST retain their existing `act` classification.
SRC entries have explicit advanced exposure metadata without being added to existing policy presets.

`1` means an initial-guide candidate within the character budget.
`D` means on-demand discovery.
`C` means disclosure through the relevant topic or explicit op request.
Every cell is intersected with policy and runtime availability.

| Current operations | Local Code | Remote push | Remote polling | Legacy |
| --- | --- | --- | --- | --- |
| `guide`, `dispatch_policy`, `codex_create`, `codex_wait`, `codex_read`, `codex_review`, `receipt` | 1 | 1 | 1 | Current |
| `connector_verify` | D | C | C | Current |
| `agents`, `agent_create`, `agent_wait`, `agent_read`, `agent_review` | 1 | 1 | 1 | Current |
| `codex_send`, `codex_resume`, `codex_interrupt`, `codex_pending`, `codex_respond`, `codex_interactions` | D | D | D | Current |
| `agent_send`, `agent_archive`, `agent_interrupt`, `agent_pending`, `agent_respond`, `agent_capabilities`, `agent_tasks`, `agent_context`, `agent_events` | D | D | D | Current |
| `codex_tasks`, `codex_items`, `codex_changes`, `codex_queue`, `codex_queue_control`, `codex_owner`, `codex_release`, `codex_archive` | D | D | D | Current |
| `projects`, `command` | D | 1 | 1 | Current |
| `overview`, `tree`, `search`, `read`, `git`, `edit`, `write` | D | D | D | Current |
| `git_write`, `fs`, `process`, `file_search` | D | D | D | Current |
| `mcp`, `codex_thread`, `codex_account`, `codex_capabilities`, `codex_schema`, `codex_query`, `codex_call`, `codex_events` | D | D | D | Current |
| `control_output`, `events`, `logs`, `screen` | D | D | D | Current |
| `notify_control`, `notify_status`, `notification_ack`, `inbox_wait`, `request_route` | D | C | D | Current |
| `whoami`, `accounts` | D | D | D | Current |
| `account_update`, `account_merge`, `account_add`, `account_login`, `account_reauth`, `account_remove`, `account_browsers`, `account_notify` | D | D | D | Current |
| `context_resolve`, `context_search`, `context_read`, `context_check`, `context_amend` | C | C | C | Current |
| `board`, `coordination_session`, `notice_post`, `notice_update`, `notice_close`, `blocker_open`, `blocker_clear`, `messages`, `message_send`, `message_route` | C | C | C | Current |
| `task_timeline`, `task_reviews`, `task_review_undo`, `task_bubble`, `task_mark_read`, `task_panel`, `task_panel_control`, `task_open`, `task_resource` | D | D | D | Current |
| `src_conversations`, `src_chrome_profiles`, `src_conversation_open`, `src_login_import`, `src_conversation_bind`, `src_login_clear` | C | C | C | Current |
| `update_status`, `update_request`, `app_env`, `acceptance_fault` | D | D | D | Current |
| `ax_issue_draft`, `ax_report`, `ax_list`, `ax_candidate`, `ax_triage` | C | C | C | Current |


Chat profiles lead with `command` for host shell, Git, and edits.
Local Code SHOULD use its own host tools and ARC for Agent dispatch, quota-aware selection, and review.
The shared `dispatch_policy` decision view supplies current selection criteria across every profile.
It omits unsolicited inbox attachments and fields unrelated to Agent, account, model, effort or tier selection.
Model IDs with identical choices share a row.
A single legend defines terse history rows; groups with fewer than 10 dispatches merge into `other` using their original duration samples.
The Codex decision response targets at most 2,000 serialized characters with unchanged criteria and 4,500 with compact local criteria.
Controllers SHOULD retain `criteriaHash` on the first session read and pass `knownCriteriaHash` on subsequent reads.
`view:"full"` retains detailed facts and every history group.

## Guide layers

Layer 1 is `guide()` or `query({op:"guide",args:{}})`.
Local Code targets at most 2,500 Unicode characters in the complete serialized result.
The budget includes profile metadata, operation index, CLI path, source ID, guide hash, and catalog version.
Optional index entries are removed when necessary to preserve the workflow within that budget.
Local Code guide responses do not attach inbox reminders.
Layer 2 is `guide({op})` or `query({op:"guide",args:{op}})` with a complete schema and retry contract.
Layer 3 is `query({op:"guide",args:{view:"full"}})` with every enabled available op.
The frozen `guide` tool MUST NOT gain a profile or view parameter.
The query guide op additionally supports `coordination`, `src`, and `context` topics.
Notification prose appears automatically only for Remote push.
Coordination, SRC, and context workflow prose appears only on an explicit related topic request.
Maintainer guidance retains the existing Maintainer-mode gate.
Full views retain unrelated op discoverability without expanding unrelated workflow prose.
`guideHash` covers the final projection rather than just catalog text.
An effective profile change invalidates cached guide content.
`knownGuideHash` retains its unchanged-response contract.
Published guide and schema changes continue to change `arcVersion`.
Minimal MCP text remains a separate opt-in setting.

## CLI outcomes and review

The bundled [arc-local-code skill](../../skills/arc-local-code/SKILL.md) teaches the local discovery, dispatch, wait, and review flow.
`cli skill install --target claude-code` installs it alongside `arc-setup`.
Normal local work MUST explicitly set `purpose:"task"` and `notify:null` because dispatch defaults remain unchanged.
The controller SHOULD read live operation schemas and `dispatch_policy` before dispatch.
The controller SHOULD run `cli wait --control --op codex_wait` through its background-command facility with `view:"summary"` and the returned task/turn identifiers.
A shell background operator alone does not arrange session re-invocation.
A matched wait MUST NOT be treated as proof of task success.
The controller MUST inspect task status and handle pending interactions before recording review.
Cross-model review requires a separate Agent task rather than merely calling a review-recording operation.
Timeout recovery MUST continue observing the original task rather than submit it again.

`codex_wait`, `codex_read`, `agent_wait`, and `agent_read` accept opt-in `view:"summary"`.
Codex reads accept `turnId` for pinned recovery, including review and full views.
Summaries retain task identifiers, status, wait condition, snapshot hash, errors, and actionable `next`.
Final-message excerpts are limited to 800 Unicode characters.
Changed paths are limited to 50 entries.
Diffstat covers the complete attributed file list and records unknown line counts.
`completeEvidence` provides a schema-valid operation for the full result.
Truncation indicators MUST remain explicit.
Summary file evidence comes from the selected turn's native file-change records.
A shell-only change or unsupported Agent attribution returns null files and diffstat with an unavailable reason.
Workspace Git correlation remains accessible through the existing full review/change operations rather than being presented as directly attributed summary evidence.
Summary responses MUST omit `arcInbox`, conversation bindings, dispatch history, unrelated inputs, and other cross-thread data.
The final response projection uses a field allowlist and skips inbox retrieval entirely.
Omitting `view` preserves existing complete terminal replies and current read defaults.

## Frozen surfaces

MCP tools remain `guide({topic?,op?})`, `query({op,args})`, and `act({op,args,requestId?})`.
Profile configuration belongs to local source management.
Summary selection belongs inside operation arguments.
The `notification` event retains subscription parameters `{op,args}`.
Discovery preferences MUST NOT acknowledge events, revoke subscriptions, or establish notification reachability.
CLI envelopes retain `schemaVersion:1`, `ok`, and the existing result/error/next structure.
Wait summaries appear inside `result.lastResult` or `error.lastResult` on `WAIT_TIMEOUT`.
Task failure and successful CLI observation remain distinct states.

## Metrics

`cli stats control --since <duration>` reports content-free control-call accounting.
Rows record bounded effective-profile, transport, guide-layer, and dispatch-outcome metadata.
Dispatch outcomes distinguish submitted, pending, failed, and unconfirmed observations.
Successful submission requires a completed receipt with task and turn identifiers.
`profileSequences` groups source activity by profile, transport, and a 300-second inactivity gap.
A sequence is a session proxy rather than an authenticated conversation identity.
Concurrent conversations sharing one source and all local CLI callers share that attribution limitation.

| Measure | Report evidence |
| --- | --- |
| Guide cost | Per-sequence guide response, text, and structured-content bytes with cohort median/p95. |
| Cold-start calls | Calls before first confirmed dispatch with cohort median/p95 and sequences without successful dispatch. |
| Argument correction | INVALID_ARGUMENTS counts, same-op retries within five minutes, and retries per 100 dispatch attempts. |
| Repeated discovery | Existing unchangedReads, uncachedUnchangedReads, and cache-request counts. |
| Completion cost | Existing task calls/bytes through recorded review and dispatch error counts. |

Comparisons SHOULD use equivalent task cohorts and distinguish cached guide requests.
Bytes MUST NOT be reported as token counts or confirmed client context consumption.
Reduced guide cost MUST NOT justify increased failed dispatches or missing recovery paths.

## Scope and verification

Phase 1 includes profile selection, guide layering, summary outcomes, metrics, and the Claude Code skill.
Multi-device relay targeting and cross-source project context remain later work.
Host access for later devices MUST be evaluated against the selected execution device.
The relevant behavior contracts live in `tests/control-mcp.test.ts` and `tests/cli-failures.test.ts`.
They cover frozen tool schemas, legacy defaults, profile isolation, allowlist enforcement, guide caching and budget, task summaries, pinned turns, metrics, and CLI failure recovery.
`tests/contract/` and `tooling/test-policy-allowlist.json` remain protected by the existing ownership rules.

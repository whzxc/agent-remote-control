# Dispatch policy

[Control loop](control-loop.md) · [Architecture](architecture.md) · [Terminology](terminology.md)

[Multi-Agent dispatch](dispatch-agents.md) describes capability sources and Agent boundaries. This document describes the integrated Codex path and shared decision view.

## Responsibility

The control source owns decisions. ARC owns facts and constraints. The control source uses task context and user criteria to choose models and effort. ARC provides native catalogs, quota summaries, defaults, and dispatch records. Quota is advisory and never automatically downgrades or rejects work.

Selection balances task quality, duration, and cost without preset task-count, value, or upgrade/downgrade preferences. ARC adds no routing model. Effort, duration, and review outcomes support comparison.

## Configuration and queries

On first use, state-directory dispatch-policy.json is created with two-space indentation and a final newline. Backups MUST preserve formatted JSON. Manual edits apply on the next read. Top-level criteria guides Agent selection. Each Agent section owns its criteria. The factory Codex section is:

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
  }
}
```

serviceTier is a nullable global default. serviceTiers maps model IDs to overrides. Factory null/empty values express no speed preference and defer to native inheritance. Example: `"serviceTiers":{"some-model":"priority"}`. Fast uses native priority and standard speed uses default. additionalSpeedTiers.fast is a label, not a dispatch parameter. Native descriptions are preserved without inferred usage multipliers.

Explicit tier precedes the final model's override, then the global default. Selection repeats for every new turn, including model changes in one thread. Native turn.serviceTierForTurn precedes turn.serviceTier, top-level serviceTier, and thread.serviceTier. A one-turn override does not change thread defaults. Sources are explicit, policy-default, or native-default when unfilled.

Empty allowlists are unrestricted. Denylists win. Constraints apply to final values, including policy defaults. Upstream validates native model/effort support. ARC does not duplicate that validation. Malformed policy fails explicitly without falling back to desktop defaults.

`query({op:"dispatch_policy",args:{}})` returns the decision view. By default, only installed and enabled Agents appear. all:true includes uninstalled and disabled Agents without changing view. agent filters by ID. A non-Codex agent plus taskId selects an existing session. Reads never start or resume sessions.

Decision rows include availability, used-quota summaries, policy defaults, criteria, compact native model choices, and 30-day history. Missing defaults inherit native configuration. criteriaHash accompanies every scope, including empty criteria. knownCriteriaHash accepts a prior digest string or a map of Agent IDs to hashes, with global for top-level criteria. Matching text is omitted with criteriaUnchanged:true. The same mechanism applies to view:full, where Agent criteria remain under policy. A string omits every criteria block matching that digest. Hashes cover the exact UTF-8 criteria text.

`dispatch_policy` returns the active absolute `policyPath` in both views. Use this path for manual editing instead of searching for policy files or backup copies.

`act({op:"dispatch_policy_update",args:{scope,criteria,expectedCriteriaHash}})` replaces only the complete criteria text. scope is `global` or a registered Agent ID, including disabled or uninstalled Agents. criteria may be empty to clear that scope. expectedCriteriaHash is required and must match the exact current UTF-8 criteria hash returned by `dispatch_policy`. Global hashes are top-level; Agent hashes are on decision rows or under policy in full view. Empty criteria also have a hash. Defaults, constraints, and other scopes are preserved. Defaults updates are not supported by this op.

ARC serializes the hash check and write with other policy operations in Core. A mismatch makes no policy or backup write and returns `DISPATCH_POLICY_CONFLICT`, scope, currentCriteriaHash, and a `next` query. Read the current criteria, review concurrent changes, then retry the full replacement with that scope's current hash. Missing required fields and unknown scopes return `INVALID_ARGUMENTS` with a guide correction. Malformed existing policy fails without overwriting it.

A successful update returns scope, criteriaHash, policyPath, and backupPath. Both the atomic policy replacement and the previous-policy backup use two-space indentation and a final newline. The sibling `dispatch-policy.json.bak` retains the previous policy and is replaced by the next successful update's backup. Backup failure prevents policy replacement. External manual editors do not share Core's lock; coordinate manual writes separately. After an uncertain result, read the policy before attempting another replacement.

The op uses the same ingress allowlist authorization as other management writes. Default write presets include it; read-only presets do not. Existing explicit allowlists must enable it. Local Code and authenticated local CLI callers can use:

```sh
arc cli control guide dispatch_policy_update
printf '%s' '{"scope":"codex","criteria":"Use current task evidence.","expectedCriteriaHash":"<current criteriaHash>"}' | arc cli control dispatch_policy_update --stdin
```

Stdin is the args object. The frozen guide/query/act tool schemas and notification surface are unchanged.

Model entries retain native IDs and supported effort ranges; identical choices share one row. Decision accounts retain selection IDs, aliases, defaults, health, saved used-quota windows and reset times. Decision responses omit unsolicited inbox attachments for every profile. A range abbreviates only contiguous known effort levels. Fast labels retain native tier IDs. Policy allow/deny constraints remain visible. Agents with neither criteria nor history collapse to an availability/no-policy row with their quota reference. Shared provider/pool quotas are shown once and referenced from subsequent Agents. Quota percentages are used percentages, never remaining percentages.

view:full retains native capability details, quota pools/windows, policy, and individual history groups. Nulls, empty strings/arrays/objects, and unknown values are omitted from both views. observedAt is omitted for fresh data. Stale provider readings and persisted catalog snapshots retain observation timestamps. Missing facts are omitted rather than converted to zero. Read failures remain explicit.

Codex models and quotas come from model/list and the same account/rateLimits/read API used by codex_account. Other Agents use SubscriptionService and native/session catalog snapshots. General queries preview at most eight non-Codex models with omittedModels. Filtering by agent returns the full catalog. Session facts retain scope and source in full view. Without a snapshot, needs-session explains how to create a session without a prompt. Disabled Pi never receives RPC. A snapshot without an observation time cannot supply one.

Installation or quota access does not prove inference authentication. Provider integration and model-to-quota association remain separate facts. Full view retains known authentication evidence. See [Multi-Agent dispatch](dispatch-agents.md) for non-Codex selection, records, and reviews.

All control-source loop guides require this query before dispatch and a reason for Agent/model/effort selection. Dynamic catalogs and quota are not embedded in guide. Existing explicit ingress allowlists must enable dispatch_policy. Default policy includes it.

## Dispatch and records

codex_create/codex_send accept optional reason without changing guide/query/act envelopes. Omitted model/effort use policy defaults. Null/unconfigured defaults inherit native current values. Existing policy files are not rewritten. Effort alone can increase effort for a new turn in the same thread. Explicit native turn, collaborationMode, and thread creation settings also obey constraints. Thread/turn configuration stays consistent.

Idempotency checks original arguments before fixing selection. The same requestId reads the original receipt despite policy edits. Queues resolve defaults at execution. Automatic capacity retry reuses the original selection. Steering cannot change the active turn's configuration. A different explicit setting returns an error directing the caller to terminal waiting or a queued new turn.

Each successful dispatch records requestId, turnId, model, effort, serviceTier, reason, sources, dispatch mode, and time by thread and links the receipt. Sources are explicit/policy-default or active-turn for steer. codex_tasks view:full exposes dispatch history. Completion/failure/interruption notifications include the turn record. Persisted native configuration adds effective evidence when available. Otherwise records describe only ARC's submitted configuration.

A directly following turn satisfying [native retry rules](control-loop.md#72-native-retry) records dispatchSource:native-retry, dispatchMode:new-turn, retryOf, and nativeTrigger. Configuration comes directly from native turn_context without applying current policy defaults. Field sources and configurationEvidence are native-persisted-turn-context. submittedAt is native start time. observedAt is ingestion time. purpose inherits the predecessor. Native turnId is the stable idempotent record requestId without a fabricated ARC submission receipt. It is not a replayable write ID. Retry turns share completion, codex_review, and history paths. New user content, uncertain retries, and turns outside ten minutes are excluded.

Without native service_tier, effectiveConfiguration.serviceTier remains unknown in records. threadServiceTier separately reports the last persisted thread_settings_applied value before task_started. It proves thread configuration, not serviceTierForTurn. Later settings never backfill an earlier turn. History prefers native tier, then submitted tier, otherwise unknown internally.

Terminal records measure submission to first terminal observation. This observed duration includes scheduling and observation delay.

## Review and rework

`act({op:"codex_review",args:{threadId,turnId?,verdict:"pass"|"rework",note?},requestId?})` records the control source's review. Omitted turnId chooses the latest native terminal turn, even if a newer turn runs. The target MUST exist in a readable thread and be terminal. Turns started directly in a native app are reviewable. Unknown or nonterminal targets fail explicitly without judging another turn.

review stores verdict, note, reviewedAt, requestId, reviewer, dispatchOrigin, and dispatchRequestId. reviewer records the authenticated sourceId and controlSource, plus sessionId and target when available (otherwise null). dispatchOrigin is arc when an ARC dispatch record exists, with its dispatchRequestId, or external with a null dispatchRequestId. External reviews also snapshot model, effort, and serviceTier from native persisted turn context, turn metadata, then thread metadata; unavailable fields remain null. External reviews are stored separately from dispatch records and appear in reviews on full task/read results. The latest verdict replaces previous judgments. Safe retries reuse requestId. Changed verdicts use a new ID. Review and dispatch share the thread lock. Completion metadata cannot overwrite reviews.

After rework, the next new-turn dispatch records reworkOf. Steering does not consume the association. Dispatch uses the latest effective rework verdict. Once created, the link persists despite later verdict changes. Queues link at execution. codex_tasks view:full returns current reviews and links. Existing completion notifications remain creation-time snapshots.

## History and usage boundaries

History uses submittedAt for the last 30 days of new turns, grouped by Agent, model, and native options, including Codex effort/serviceTier. Native effective configuration takes precedence over submitted values. Same-turn duplicates are deduplicated. Steering is not another dispatch. Counts include dispatches, pass, rework, failed, interrupted, and unreviewed. Failure/interruption counts take precedence over verdicts. Unreviewed includes active turns and successful terminal turns without review. Only successful terminal durations contribute to the median and durationSamples.

External reviews enter history only with known model and effort. They use the same Agent/model/options/effort/serviceTier grouping and a 30-day window based on reviewedAt. Each turn contributes its latest verdict once. Each group's external object reports reviews, pass, and rework separately; ARC dispatches, outcome counts, and duration samples retain their existing meaning. External failed/interrupted turns retain their review verdict in external counts. No external duration is inferred. Missing configuration excludes the review from history without preventing review or rework linking.

The decision view merges every group with fewer than 10 ARC dispatches into other before calculating its median from original duration samples. A single legend defines terse rows: n=dispatches, med=successful observed minutes, unrev=unreviewed, fail=failed, int=interrupted, ext=external reviews with separate pass/rework counts. Outside other, omitted tiers mean default; ? means unknown. Full view keeps individual groups and millisecond medians. Groups are ordered by ARC dispatches plus eligible external reviews. Decision history retains the 12-group limit and omittedGroups when needed; full history retains every group. Exact-configuration revisit estimates continue using unmerged history.

purpose:"self-test" is excluded. A send without purpose inherits the previous dispatch's purpose. Explicit purpose overrides it. Reviews cannot change it. Empty groups are omitted. Reads use fresh records, so changed verdicts appear immediately.

Current app-server Turn, turn/completed, and thread/turns/list lack reliable per-turn token totals. thread/tokenUsage/updated has turnId, but last is the latest model response and total is cumulative thread usage. account/usage/read threadUsage is a thread estimate. ARC therefore stores no per-turn token totals or averages. It does not difference, estimate, or replace missing usage with zero. Add usage only when upstream provides complete terminal-turn-associated data. See [native protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs).

## Scope and limits

Configuration, queries, guide, defaults/constraints, same-thread effort changes, records, notifications, reviews, rework links, and 30-day summaries are integrated. There is no policy editor or automatic quality judgment. Reliable native per-turn usage remains unavailable. Future routing evaluation requires adequate review samples. Add policy UI only for actual requirements.

Constraints cover these dispatch ops. They are not a security boundary around raw native APIs or direct Codex use. ARC never judges task complexity, automatically raises effort, or claims review passed.

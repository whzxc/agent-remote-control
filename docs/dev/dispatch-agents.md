# Multi-Agent dispatch policy

[Dispatch policy](dispatch-policy.md) · [Agent contracts](../reference/agents.md) · [Subscriptions](../reference/subscriptions.md)

This document defines multi-Agent boundaries. Queries, policy sections, configuration confirmation, and review are integrated. guide is the current contract. Codex behavior is documented in dispatch-policy.

## Capability sources and evidence

Models belong to an Agent's launch configuration and provider. Agent names alone do not identify models. Catalog availability, native configuration confirmation, and actual turn execution are separate evidence levels. A listed option does not prove account entitlement. A successful configuration RPC does not prove the server used that model.

Session catalogs come from initialize/session/new and do not prove model switching or inference. Source references mean native packages or magpie implementation. Machine-specific installation, authentication, quotas, and sessions come from queries rather than this document.

| Agent | Model source and dimensions | Selection and evidence | Quota source and limits |
| --- | --- | --- | --- |
| Codex | app-server model/list, native efforts/serviceTiers | Thread defaults and turn overrides. Persisted turn_context. Tier limits are in dispatch-policy. Run existing regressions for extensions. | ARC codex-account/account/rateLimits/read. |
| Claude Code | ACP configOptions model, effort, fast, mode. Effort varies by model. | Session settings before new turns. set_config_option returns full configuration. Actual model needs turn evidence. Fast confirmation does not prove turn speed. | claude-code native OAuth usage. |
| Cursor | Parameterized ACP model after native login. mode and independent context/reasoning_effort options. | Initialize parameterizedModelPicker and authenticate(cursor_login), preserving native defaults. Model/parameter values are assertions only because setters persist user defaults. mode may change. | Cursor DashboardService/usage-summary. Catalog uses native parameterized IDs. |
| Grok | ACP models/configOptions and native settings catalog. reasoning_effort. Fast is a separate model. contextWindows is not writable. | Session set_config_option/native updates confirm selection. magpie agent/grok.go reads native catalogs. | grok credits and CLI settings. |
| DeepSeek Harness | Grouped model options in ACP profiles. reasoning_effort, with official examples off/low/high/max subject to post-switch response. | Session settings. Preserve model as an opaque JSON-array-encoded string. Desktop defaults are not ACP defaults. magpie agent/dsh.go profile/default-model. Re-read after model switches. | No dedicated ARC provider. API balance does not prove subscription quota. |
| Pi | RPC get_available_models, package registry, user providers. get_available_thinking_levels and model-supported thinkingLevel. | set_model/set_thinking_level with get_state confirmation. Assistant model/provider may add turn evidence. Pi 1.3.0 RPC types and magpie agent/pi.go/nativemodels.go. Inference not tested here. | Per provider. Do not attach unrelated Codex/Claude login quotas. |
| OpenCode | Native provider/model configuration and ACP catalog. Only handshake-exposed modes/configuration. | Require version-specific handshake and setter responses. Config-file fields are not automatically ACP parameters. ACP selection not tested here. | opencode-go covers Go only, not other providers or Zen. magpie provider/opencode_client.go/opencode_endpoints.go. |
| Gemini | Native model.name and ACP catalog. Only exposed session dimensions. | magpie configuration proves launch selection only. ACP unverified. | Google login quota, not Antigravity. magpie agent/gemini.go/provider/google.go. |
| Kimi | config.toml models/providers/default_model. Kimi Code support_efforts/default_effort differs from kimi-cli thinking. | magpie changes new-session defaults. ACP unverified. agent/kimi.go. | kimi-code uses an explicitly saved key with coding/v1/usages. Do not infer native-login reuse. |
| Qwen | modelProviders and model.name/baseUrl. Only exposed session dimensions. | Launch defaults or native /model. ACP unverified. magpie agent/qwen.go. | Not integrated. Native login quota source unconfirmed. |
| Oh My Pi | Its pi-catalog and user models. Native thinking. Role models and default thinking are distinct settings. | Reads config at launch. ACP unverified. Do not apply Pi RPC contracts. magpie agent/omp.go/nativemodels.go. | Per provider, not integrated. |
| Copilot | ACP catalog and dimensions unverified. | Setters and turn evidence unverified. | magpie provider/copilot_accounts.go/subscription_usage.go. Not integrated in ARC. |
| Kiro | ACP catalog and dimensions unverified. | ACP unverified. | magpie provider/kiro.go/kiro_accounts.go. Not integrated. |
| Droid | Native model catalog, ACP unverified. Do not infer effort from other Agents. | Source reference only. | magpie provider/factory_usage.go/factory.go. Not integrated. |
| Devin | Native provider catalog, ACP/dimensions unverified. | ACP unverified. | magpie provider/devin.go. Not integrated. |
| Cline | Native provider configuration, ACP/dimensions unverified. | ACP unverified. | magpie provider/cline_usage.go. Not integrated. |
| CodeBuddy | Native configuration, ACP/dimensions unverified. | magpie agent/codebuddy.go. | Not equivalent to WorkBuddy. Unconfirmed. |
| Goose | Native provider configuration, ACP/dimensions unverified. | magpie agent/goose.go. | Per provider, not integrated. |
| Hermes | Native provider configuration, ACP/dimensions unverified. | magpie agent/hermes.go. | Per provider, not integrated. |
| Junie/custom ACP | Actual process handshake and exposed fields only. | Keep native defaults without a catalog/setter contract. | Unconfirmed. Do not add unsupported dimensions. |

Catalog model rows keep the opaque `model` ID and existing fields. Optional `displayName` is the unmodified native human name. Optional `provider:{id,name}` comes from an explicit native provider record or a provider-defined group; if only a provider key is supplied, both fields use that key. Optional `contextWindow` is a native token count, or an array of native token counts when only selectable windows are supplied. A stated default count takes precedence over the window list. Missing metadata is omitted, never inferred from model IDs, brands, model families, endpoints or names.

`authoritative` describes completeness for the queried native session/catalog, not entitlement or execution. It is true for a fully paginated Codex model/list response, live Pi get_available_models, or a complete live ACP model selector. It is false for persistent/session snapshots, the Grok cache, Pi's installed registry subset, unavailable catalogs, empty provider groups and truncated previews. A selection absent from a non-authoritative list is not evidence of an invalid selection. Snapshots retain all model metadata but are always non-authoritative when read without a live session. The decision view groups models with identical provider and effort/tier/option choices into compact strings, such as `model-a,model-b: low-ultra, fast=priority, option=a/b`. A native displayName differing from the ID appears as `displayName (id)`; an informative native provider name labels the group once. Exact duplicate names are omitted. IDs and labels are not parsed or rewritten. Per-model contextWindow is omitted from decision strings. `authoritative` remains at catalog level. `view:"full"` retains structured model rows and all available metadata; combine it with `agent` for an untruncated single-Agent catalog. Agents without criteria or history omit model summaries in decision view and report authoritative:false because that response carries no catalog.

Native extraction boundaries:

- Codex copies model/list displayName, provider/providerId and providerName when present, and contextWindow. It does not assign OpenAI from an Agent name.
- Pi copies the RPC provider field or installed registry provider key, model name and contextWindow. The provider key is not recovered by splitting a model ID.
- DSH model selector groups declare provider IDs and names. ARC retains their JSON-array model values byte for byte.
- ACP model options and availableModels supply names and explicit provider metadata. Generic groups such as Recommended do not denote providers. Grok, Cursor and Claude groups become providers only when native metadata declares provider semantics. `category:model` denotes a selector, not a provider.
- ACP `_meta` may supply provider and context metadata. Grok supplies totalContextTokens/contextWindows there and context_window/context_windows in cache model info. A configOptions selector may use metadata from an availableModels entry only when their complete IDs match.

Sessionless queries do not launch Agents:

| Agent | Source | Boundary |
| --- | --- | --- |
| Codex | Existing model/list | Existing contract. |
| Grok | `$GROK_HOME/models_cache.json`, default .grok, or newer ACP snapshot | Native fetched_at, visible models, per-model reasoning_efforts. No credentials. Custom TOML models require session snapshots. |
| Pi | Installed pi-ai dist/providers/data for providers in native auth.json, or newer RPC snapshot | Same source as magpie piRegistry. No inferred authentication validity. Custom providers and dynamic thinking levels require RPC snapshots. |
| Claude | Persistent ACP catalog | Public Anthropic catalogs do not represent CLI aliases, allowlists, and model-specific options. |
| DSH | Persistent ACP profile catalog | Built-in constants/provider configuration do not define the complete current ACP catalog. Preserve JSON-array model IDs. |
| Cursor | Persistent ACP catalog | --list-models and provider names differ from parameterized ACP IDs. No invented conversion. |
| Other ACP | Persist the first exposed session catalog, otherwise needs-session | Native configuration-to-ACP mapping is unverified. Do not claim native reads are integrated. |

Session initialization, native configuration updates, and catalog readback save full snapshots. Empty observations never replace a nonempty persisted catalog; they may initialize an empty store. Identical content, ignoring top-level observedAt, does not rewrite a snapshot. A retained snapshot keeps its saved observation time; current native reads report their own observation time. General-query truncation affects responses only. Snapshots describe the last catalog, not current authentication, defaults, or execution. Model-specific options belong to optionsForModel. Native Grok files expose options per model. Fresh session facts take precedence and update snapshots. Files are read on demand without background polling or CLI session startup.

ACP prefers [configOptions](https://agentclientprotocol.com/protocol/v1/session-config-options), retaining IDs, values, groups, and categories. Older protocols exposing only models/modes use their corresponding session operations. This is upstream protocol support, not an ARC legacy-tool shim. Dimensions follow post-model-switch responses rather than one cached universal effort list.

magpie reference is [2374ffe1](https://github.com/yetone/magpie/tree/2374ffe1). internal/usage and usageapi aggregate historical calls. provider reads upstream windows, allowances, and balances. catalog supplies catalogs. budget belongs to magpie's gateway keys and in-flight reservations. ARC incorporates only native-read logic, not gateways, account rotation, estimated reservations, or automatic routing. Substantial code reuse MUST preserve Copyright (c) 2026 yetone, the full MIT license, and bundled notices.

## Queries

The guide/query/act envelopes remain unchanged. dispatch_policy accepts agent and, for non-Codex Agents, taskId. Default queries include installed/enabled Agents. all:true includes the full registered inventory. Decision/full views and criteria hashes are defined in [Dispatch policy](dispatch-policy.md).

Full facts include availability.installed/available/enabled and separate authentication source/time. Successful quota access does not prove ACP or model inference authentication. Native model/options retain IDs, names, current values, source, and observation time. Sessionless reads compare native catalogs with independently persisted snapshots and choose the newer observation. source/catalogSource identify provenance. optionsForModel scopes model-specific options. lastObservedValue is not a new-session default. agents/catalogs survives task cleanup and restart.

Only absence of both native and cached catalogs yields needs-session. Create one empty-prompt session and query its taskId if needed. Queries never create or resume sessions. Dispatch revalidates session catalogs and updates snapshots. Disabled Agents do not start processes.

Quota reuses SubscriptionService windows, provider IDs, and stale/error state without another poller or credential copy. Missing integration is not zero. Multiple providers expose only known associations, not a claim that a quota covers the selected model. General queries use bounded catalog previews and omitted counts. Single-Agent queries return complete catalogs.

Codex models/policy/quota/history are in its Agent row. Non-Codex native facts live under capabilities. selectionSupported means ARC implements the native selection protocol, not that every Agent's inference has been verified. Actual models and dimensions remain session-defined.

## Policy file

Use top-level Agent-ID sections and one top-level criteria string. Add no rule engine or configuration migration framework. Global criteria describes task-to-Agent fit. Agent criteria describes model/options selection. The control source interprets criteria. ARC does not.

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

This factory example never overwrites existing files. Preserve existing Codex settings, criteria, and tier overrides. Missing sections are empty policies without writing empty sections for every Agent. Null/omission means no native override. New sessions follow native defaults. Later turns inherit session values. Existing nonempty Codex defaults continue applying.

Non-Codex model IDs are opaque. options maps native config IDs to string values. Pi uses thinkingLevel. Do not repeat model inside options. Precedence is explicit, Agent policy default, native current value. Denylists win. Empty allowlists are unrestricted. Check final values, including known native defaults. Restricted but unknown values fail explicitly rather than bypassing policy. Invalid format never falls back. mode may change permissions and is not universally effort.

## Dispatch, records, and review

agent_create/agent_send accept model/options/reason/purpose. Codex keeps model/effort/serviceTier. Unknown or unsupported explicit choices fail before the prompt. Empty-prompt creation obtains a catalog without applying policy/selection or counting as dispatch. Configure through a prompt-bearing dispatch.

After idempotency, resolve policy under the task dispatch lock. Check idle/terminal status, set model, read updated options, set remaining options, confirm, then send the prompt. Never change configuration while running. Multiple setters are not atomic. Partial success followed by failure returns confirmed configuration without a prompt. Read actual state next time without fabricating rollback. Setter timeout closes the process and marks configuration unconfirmed to prevent late setters racing the next prompt.

Pi uses set_model/set_thinking_level and get_state. ACP uses session configuration operations and responses/updates. Selection normally affects only the ARC session without rewriting native user configuration. Cursor reuses declared cursor_login with existing login. Interactive-login requirements return native failure without launching login or changing accounts. clientCapabilities._meta.parameterizedModelPicker preserves parameterized catalogs and native defaults. Cursor setters persist user defaults, so ARC rejects different model/parameter values. Explicit current values are only asserted by readback without a setter. Native default inference and session mode remain usable. modelSelectionUnavailable reports this boundary until session-isolated setters exist.

Records reuse dispatches and its lock, adding agent/taskId/options. Old Codex records without agent mean codex. submittedConfiguration stores overrides. sessionConfirmation stores the pre-prompt snapshot. turnEvidence stores native turn evidence or null. submission is pending/accepted/rejected/unconfirmed. Preserve scope/time without backfilling old turns from new session values. agent_read.dispatches exposes records, verdicts, and rework links. Pi/ACP turnId remains the ARC prompt UUID. Pi assistant provider/model may add turn evidence. Claude prompt _meta.quota.model_usage may describe a model set including internal calls, not one main model or effort/Fast evidence. Other ACP implementations without reliable turn fields retain missing evidence. Process exit, timeout, or uncertain submission never proves success or permits automatic resend.

codex_review and agent_review share record updates, rework links, and aggregation. Agent review takes agent/taskId, optional turnId, verdict, and note. Drivers retain native terminal-state ownership. Separate ops preserve Codex threadId contracts. Reviews require an existing confirmed terminal turn in a readable task, regardless of who started it. AgentHost validates the task and native current-turn snapshot; historical turns use confirmed dispatch, review, or native timeline status records. Missing historical configuration remains null. External reviews share the latest-verdict and rework-link behavior, carry reviewer provenance and nullable native configuration, and remain separate from dispatch records. History includes external reviews only with known model and effort, in separate external counters within the same configuration groups. Omitted turnId selects the latest confirmed terminal turn. Running turns cannot be reviewed.

History groups by Agent/model/native options, retaining Codex effort/serviceTier and excluding self-test. Native retry inheritance remains Codex-specific. Pi/ACP messages do not imply new dispatches. Unattributable providers, turn tokens, and costs remain unknown internally and omitted from the decision view.

Loop guides require dispatch_policy, native Agent/model/effort selection with reason, same-task rework according to criteria, and pass/rework after terminal review. Dynamic model and quota data stay outside guide.

## Implementation and acceptance boundaries

Capability work distinguishes handshake evidence, source inference, and unsupported dimensions without changing local policy. Read-only queries add filters, availability, shared quota, and session facts without regressing Codex. Dispatch integration includes defaults, constraints, confirmation, records, reviews, rework, history, and guide together. Extend providers individually only with reliable authentication, quota, and model-association sources under subscriptions/providers.

Use small Regression/Property fixtures for native catalog extraction and no-inference invariants. After authorized build/install, use temporary tasks with purpose:self-test and notify:null to verify defaults, explicit selection, denial, idempotency, records/review/rework, and history exclusion. Report configuration confirmation separately from inference evidence. Archiving ended self-test tasks is optional. Use `act({op:"agent_archive",args:{agent,taskId}})` for explicitly selected non-Codex tasks, including empty-prompt catalog sessions. Use `codex_archive` for Codex threads. `agent_archive` refuses active or unconfirmed turns and pending interactions with `ARCHIVE_ACTIVE_TURN`; use `agent_interrupt` or `agent_pending` followed by `agent_respond`, then verify the task before retrying with a new requestId. It closes only the owned process, flushes output, marks the task archived, hides its task/native projections from conversations and activity, and ends live wait/notification scope. It retains receipts, task evidence, native upstream sessions and transcripts. `agent_read` remains available; send/wait cannot reopen an archived task. There is no restore op. Retain the original requestId for identical retries; read `receipt` after an uncertain response. Preserve and recheck original Codex policy bytes unless the task explicitly authorizes editing them.

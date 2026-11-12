# Accounts

[UI conventions](ui.md) · [Coding lanes](worktrees.md) · [Architecture](architecture.md) · [Tools](../reference/tools.md)

This page describes account ownership, identity resolution and the separation between platform connectors and local Agent accounts.

## Model

The platform UI uses Platform → Connector instance → Activity. Local Agents use Agent → Profile → Task. Native provider accounts retain identity and quota associations without merging connector instances in the UI.

- Platform: a supported product family such as OpenAI, Anthropic, Google, X, or Microsoft. GitHub products belong to Microsoft. Each authorized connector instance is a separate child, even when two instances share an upstream identity. Agents are not platform menu items.
- Account: one provider identity, independent of side.
  - `id` (stable ARC ID), `provider` (provider family, including `anthropic`, `openai`, `deepseek`, `google`, `xai`, or another known platform), `identityKey` (provider account ID when known, else a hash of normalized email + organization), `alias` (user-editable; defaults to the organization name or `Personal`), optional `email`, `orgName`, `plan`, plus `createdAt` and `observedAt`.
  - `sources`: control-source IDs authorized as this account. Several connections or devices of one account may share one `accountId`; each source remains a separate connector instance in the platform UI.
  - `agentProfiles`: list of `{ agent, profileId, kind, state, default }` with kind `cli-profile`, `codex-home` or `api-key` and state `signed-in`, `signed-out`, `unfinished` or `invalid`. The isolated Claude CLI profiles in `native/src/claude_accounts` become `claude` profiles. Codex retains the system `codex-home` profile and supports independent native or imported Codex credentials. Key-based Agents expose one `api-key` profile.
  - `notifications`: Claude routes and bound cloud sessions move under the account. ChatGPT accounts report MCP Events reachability. Agent-only accounts report `n/a`.
  - `quota`: subscription windows belong to the account. An account with both sources and agent profiles shows one shared quota. Optional `quotaProviderId` selects an existing shared SubscriptionService provider; otherwise detail reads use the native account profile.
  - `identityAliases` retains identities explicitly confirmed to share ownership. `mergedAccountIds` lists previous ARC account IDs; retained tombstones point to the current owner with `mergedInto`.
- Same identity: an account with both `sources` and `agentProfiles`. This includes a ChatGPT account and the Codex login of the same ChatGPT identity.
- Default account: at most one default profile per Agent; dispatch without an explicit account uses it.

## Codex accounts and native sessions

The native primary home is the configured external `CODEX_HOME`, or the user's `.codex` directory. Every execution process uses this same home, including its sessions, archived sessions, indexes, databases, locks, configuration and installed resources. ARC keeps account credentials and scheduling associations separately. It does not copy or partition conversation history.

The Desktop login is the primary account (`profileId:codex-home`). Other credential profiles are secondary accounts. `agentProfiles.role` exposes this distinction and `desktopDispatch` reports whether Desktop dispatch is available. `defaultFor` selects the account used when a dispatch omits `account`; it does not promote secondary credentials to primary. Secondary work always uses its own App Server. Explicit Desktop opening and handoff are rejected even when a secondary account is the dispatch default.

`account_add({kind:"codex"})` starts official CLI OAuth in a private credential home. That process performs account operations only. Execution starts another App Server in the shared native home and receives access credentials through native experimental `chatgptAuthTokens`. It never updates the primary credential file. `account_import` accepts native credentials and explicit `refreshOwner`: `codex`, `none`, or `external`. Reimport reuses a known provider account's profile. Active profiles reject credential replacement and reauthentication.

With `codex`, the native credential process owns refresh tokens. Execution requests renewal through its external-token callback, and ARC asks the credential process to refresh before reading its access token. With `none`, ARC retains access credentials and requests reimport after expiration. With `external`, a local executable owns upstream authentication. It receives a JSON request on stdin with native `reason` and `previousAccountId`, then returns `accessToken`, `chatgptAccountId`, and optional `chatgptPlanType`. ARC invokes no shell and discards imported refresh tokens in `none` and `external` modes. Executable hooks require local CLI or panel authority.

ARC persists task-to-account bindings for dispatch, send, resume, interrupt, approvals, writer diagnosis and archive. Native creator account metadata and explicit parent bindings identify subagents without creation notifications. Directory location no longer determines account ownership. Send without `account` keeps the original account; a different account returns `CODEX_THREAD_ACCOUNT_MISMATCH`. Native listings use one upstream cursor over the shared store. Reads never resume a session.

Accounts and dispatch-policy reads expose `agentProfiles.parity` with `primary`, `shared`, or `error` and a configuration fingerprint. Execution processes load native settings directly. Codex loads configuration and global instructions for new threads and invalidates skills caches through its native file watcher. ARC keeps each profile on its existing server across configuration changes, preserving running turns and thread ownership. Configuration fingerprints are diagnostic only; dispatch, existing-thread operations, account reads and quota reads do not depend on them. There are no generated execution homes or startup projection records.

Existing per-account session directories are not moved, merged or deleted at startup, login or refresh. Their history needs a separate explicit migration before it can be continued from the shared native store.

## Built-in local authority

Local CLI (`ingressId:local-cli`, credential type `local`) and the local panel share one durable local source identity. The panel records `ingressId:local-ui` in its origin. They are built-in authority on this computer, not external control sources or provider accounts. Their source ID remains available for task and receipt attribution; new local origins have no account ID. Local `whoami` reports `authority:local`, a null account `id`, and `identityResolution.state:not-applicable`.

Control-source lists, Accounts, topology account nodes and source pickers exclude the built-in local source. Other configured local transports remain ordinary control sources. Local product metadata remains available to label historical records. Local authority cannot be disconnected, revoked, removed or switched to an external connection. Native mutations reject it with `LOCAL_SOURCE_PROTECTED`; the UI offers no control-source actions for it.

For legacy installations, ensuring the built-in local ingress repairs its local credential marked `revoked` or `connectionRemoved` to `connected`, clears removal and pending-switch metadata, persists the repair and logs the transition once. It preserves the source ID and historical origins. Account reconciliation detaches local source membership and retains a tombstone for any resulting empty account; Agent profiles and other source memberships remain intact. External sources never receive this repair. A local notification handshake may verify delivery, but its identity resolution stays `not-applicable` and never attaches a provider account.

`SOURCE_REVOKED` identifies the rejected source and ingress and distinguishes revoked authorization, removed connections and superseded credentials. CLI failures provide authorization recovery in `next`, without command-usage advice. Revoked external sources require a new authorized control source; disconnected sources whose connection was removed can use Change connection and reauthorize. Local callers restart the upgraded ARC app and retry to trigger automatic repair.

## Identity resolution

ARC derives a source's account from provider authorization facts when available (`accountId`, email, organization). Correcting the product updates the provider namespace of an unidentified account only when it belongs solely to that source and has no Agent profile. The account ID and user alias remain stable. Confirmed provider identities are preserved. Client names, labels, platform guesses and caller-supplied metadata are not provider facts. Agent profiles resolve from the CLI's own auth status.

Current inbound MCP OAuth is ARC's authorization server, with locally generated opaque access/refresh tokens and grant/client/resource identifiers. Its registration and consent flow does not obtain provider email or organization claims, and it has no provider userinfo/introspection exchange. The official OpenAI Tunnel path supplies a configured tunnel ID/control-plane API key to Tunnel Client and forwards MCP over stdio with a local ARC ingress principal; ARC does not receive a per-caller provider identity from that bridge. Bearer/unauthenticated HTTPS similarly anchors one ingress source. MCP initialize reads protocolVersion but does not consume clientInfo identity. Connector observations retain operational metadata, not provider identity. Relay membership authenticates ARC instances by public key, not the ChatGPT/Claude user. Native Claude `auth status --json` provides email, accountId, orgId, orgName and subscriptionType when supplied by the CLI; Codex `account/read` provides the native account facts. Neither proves an inbound source owns that identity on its own.

A second resolution path is the confirmed Claude cloud-session handshake. `notify_control` binds a source-owned target and selects a specific ARC Claude profile through `route`, unique session visibility, or a match to the calling source origin `accountId` when no profile is confirmed visible. Verification pins that profile and snapshots its CLI identity before sending a source-bound challenge. Only `notification_ack` with the code received in that conversation links the source to the profile's account. Bind, visibility and send success alone are insufficient. A route change invalidates the pending challenge; missing profile identity keeps the source unresolved. Previously verified routes require a fresh handshake to supply identity evidence.

External `whoami.identityResolution` and source reads report `state:unresolved|resolved|conflict`. Accounts expose `sourceIdentities` keyed by source ID. Authorization evidence records `kind:authorization`, `identityKey` and `observedAt`. Handshake evidence records `kind:claude-session-handshake`, `sourceId`, `target`, `profileId`, `accountId`, `identityKey` and `confirmedAt`. A conflicting handshake never replaces a confirmed account silently: keep the existing account and return `ACCOUNT_IDENTITY_CONFLICT` in the resolution with its reason and proposed evidence. Later provider facts take precedence while retaining the disagreement. Conflicts set account health to attention and remain visible until a new matching handshake reconciles them. Notification delivery may still be verified. Source IDs and historical origins are never rewritten.

A third path is an explicit user-confirmed account merge. `account_merge` joins selected account IDs into one owner without inferring identity from aliases, platform or email similarity. It preserves source IDs, native profile IDs and credential paths. Identity aliases let subsequent observations retain confirmed memberships. New contradictory authorization facts still resolve through the normal identity rules. Source resolutions retain their authorization and handshake evidence and record the user confirmation separately. Old account IDs resolve to the canonical owner; task and receipt records retain their original IDs. Panels, topology, notification membership and cancellation include those previous IDs. An optional shared subscription supplies the account quota; unified billing observations identify X Pass under X.

An external control source without a resolution path has its own `Unidentified` account. A later confirmed identity merges its membership into the provider account and retains the provisional account tombstone.

Migration: existing Claude accounts become accounts with `claude` profiles and their routes. Sources and profiles with the same `identityKey` merge into one account. Records keep their source IDs; history is never rewritten.

Lifecycle: removing an account with running tasks lets them finish (or the user cancels them) and keeps a tombstone so history reads `Removed account · <alias>`. Signing out one profile keeps the account and its sources.

## AX operations

Every UI action has an op; no account operation is UX-only. Ops join the frozen `guide`/`query`/`act` tools through the catalog and `docs/reference/tools.md`.

Queries:

- `whoami`: the calling control source's account (`id`, `alias`, `provider`, `email`, `orgName`, `plan`), its `sourceId` and platform, linked agent profiles and notification reachability. ARC resolves it from the connection's authorization facts or confirmed Claude session handshake; the source's platform, device or environment is not ARC's concern.
- `accounts({ id?, agent? })`: accounts with sources, agent profiles, health, default flags and quota summaries. The list omits `email` and `orgName`; `id` returns full detail. Privacy mode never changes AX results.
- `dispatch_policy` reports per-account quota and health for each Agent.

Actions:

- `account_update({ id, alias?, defaultFor?, default? })`: rename; `defaultFor` names an Agent whose default becomes this account's profile. `default:false` with `defaultFor` clears only this account's default without selecting a replacement. `default` requires `defaultFor`; omission means true. Clearing survives refresh/restart. The first profile of a previously unconfigured Agent is initially default.
- `account_merge({ into, ids, alias?, quotaProviderId? })`: merge explicitly confirmed active accounts into `into`. All references are checked before saving. Replay resolves previous IDs without duplicating memberships. A null `quotaProviderId` returns to native quota; omission retains the existing association.
- `account_add({ kind, browserId? })` with kind `claude`, `codex`, `api-key` or `detect`: starts a login and returns `{ loginId, state, loginUrl? }`. Agents run the whole flow; only the sign-in itself needs the user.
- `account_import({ auth, refreshOwner, refreshCommand?, alias? })` imports an independent Codex credential profile with explicit refresh ownership. External ownership requires a local executable hook.
- `account_login({ loginId, action, code? })` with action `code` or `cancel`.
- `account_reauth({ id, agent })` restarts login for one profile.
- `account_remove({ id, running })` with running `finish` or `cancel`.
- `codex_create`, `codex_send`, `agent_create` and `agent_send` accept optional `account` (account ID or alias). Omitted means the Agent's default. Receipts, tasks and activity record `agentAccountId`; origins record `origin.accountId` beside `origin.sourceId`.

The management API mirrors these ops for the UI under `accounts/*` and replaces `claude-accounts/*`. Notification send/test stays under the account.

## Source-account containers

SRC accounts also own isolated website containers and an L3 conversation registry.
Phase 1 opens one native window per account on macOS 14+, keeping existing panels
unchanged. Account IDs key persistent random WK store UUIDs; no provider cookies
enter the account JSON store. The `src_*` operations and Desktop bridge are defined
in [Embedded control sources](embedded-control-sources.md#phase-1) and
[Source conversations](../reference/tools.md#source-conversations). Identity merges
do not silently transfer website sessions. Source login status remains separate
from Agent profile authentication and notification verification. Handshake evidence
retains the native org ID for in-process website import ownership checks.
`src_conversations` reconciles and lists every SRC account independently of the
write-operation ownership boundary. `src_login_clear` removes only website login
data and the store UUID mapping, preserving conversations and task bindings.

## UI

### Entry

The bottom-left capsule opens Tasks, Records, Connection management, Platforms, Permissions & readiness, and Settings.

### Platforms workspace

The left menu lists supported platforms with their logos and names. The right pane contains one card per authorized connector instance for the selected platform. Empty platforms remain selectable. A connector is identified by its control-source ID, not by an account, email, product name, or connection address. Two instances remain separate even when they share all those values.

ARC receives connectors passively after users copy a connection link into an external product and authorize access. This workspace has no Add account or Add connector flow. Cards show the product, client name when distinct, connection, creation time, authorization time, and last activity when available. Authorization-provided email, organization and account identifier appear only when present on that instance. Missing identity data is omitted. Local Agent profiles and merged account metadata do not supply connector facts. Connector labels can be edited independently.

The existing `accounts` page identifier remains the native navigation boundary. Account management APIs remain available for local Agent profiles, quota and historical attribution; the workspace does not expose those management operations.

### Privacy mode

One persisted preference, selected in Settings > General through two icon options: show sensitive information (Eye) or hide sensitive information (EyeOff). Accounts and source-panel headers have no privacy control. It blurs emails, organizations, identity keys, session names and connection addresses everywhere they render. `cli app snapshot` and UI scenario screenshots default to privacy on. The topology shows aliases only, so it needs no blurring.

### Control source panel

Homepage connector nodes open their own activity panel. Its header contains a platform logo linking to connector information, the instance label, width control and close. Activity is scoped to the selected source ID and uses the same stacked groups as Agent conversations. There are no account, connection or activity tabs.

Source platform panels show the same connector cards as the Platforms workspace, without Agent accounts, quota, notifications or a platform-wide connection switch. Connection configuration remains in Connection management.

Local Agents are separate from platforms. An Agent with multiple profiles opens an account selector with email and quota; selecting an account opens its scoped activity. A single profile opens activity directly. These cards do not navigate to the Platforms workspace.

### Topology

- Modes: Tree (default) and Flat, a persisted preference at the end of Settings > General. Switching never reorders nodes.
- Tree: source-side L1 is a platform and L2 is one node per connector instance. Agent-side L1 is a local tool; multiple local accounts form L2 nodes with working capsules for their recorded tasks. A single-account Agent keeps its existing node.
- Flat: connector instances retain their labels and stable source IDs. Agent accounts retain `Agent · Alias` labels. Nodes from the same group stay adjacent.
- Connector marks identify the external product; platform roots use platform marks. Local Agent account nodes retain their own quota rings. No Agent account identity merges source-side nodes.
- Account siblings fold through TopologyGroup based on configuration and viewport width. Explicit disclosure preserves keyboard focus and layered Escape.
- Account panels open scoped activity with recorded attribution and available quota.
- Geometry stays in `ui/topology/layout.ts`. Tasks use the separate card feed and working capsules.

## Fixtures

Fixtures, scenarios and docs use invented identities on `example.com` and placeholder organizations. No real emails, organization names or session IDs.

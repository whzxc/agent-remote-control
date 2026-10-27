# Accounts

[UI conventions](ui.md) · [Coding lanes](worktrees.md) · [Architecture](architecture.md) · [Tools](../reference/tools.md)

This page describes account ownership, identity resolution and the homepage account panels.

## Model

ARC manages control sources and Agents by Platform → Account → Task.

- Platform: a control-source product (Claude, ChatGPT, ...) or an Agent (claude, codex, dsh, ...). Unchanged.
- Account: one provider identity, independent of side.
  - `id` (stable ARC ID), `provider` (provider family, including `anthropic`, `openai`, `deepseek`, `google`, `xai`, or another known platform), `identityKey` (provider account ID when known, else a hash of normalized email + organization), `alias` (user-editable; defaults to the organization name or `Personal`), optional `email`, `orgName`, `plan`, plus `createdAt` and `observedAt`.
  - `sources`: control-source IDs authorized as this account. Several connections or devices of one account are several sources sharing one `accountId`; they never add account nodes.
  - `agentProfiles`: list of `{ agent, profileId, kind, state, default }` with kind `cli-profile`, `codex-home` or `api-key` and state `signed-in`, `signed-out`, `unfinished` or `invalid`. The isolated Claude CLI profiles in `native/src/claude_accounts` become `claude` profiles. Codex's current login is one `codex-home` profile. Key-based Agents expose one `api-key` profile.
  - `notifications`: Claude routes and bound cloud sessions move under the account. ChatGPT accounts report MCP Events reachability. Agent-only accounts report `n/a`.
  - `quota`: subscription windows belong to the account. An account with both sources and agent profiles shows one shared quota. Optional `quotaProviderId` selects an existing shared SubscriptionService provider; otherwise detail reads use the native account profile.
  - `identityAliases` retains identities explicitly confirmed to share ownership. `mergedAccountIds` lists previous ARC account IDs; retained tombstones point to the current owner with `mergedInto`.
- Same identity: an account with both `sources` and `agentProfiles`. This includes a ChatGPT account and the Codex login of the same ChatGPT identity.
- Default account: at most one default profile per Agent; dispatch without an explicit account uses it.

## Built-in local authority

Local CLI (`ingressId:local-cli`, credential type `local`) and the local panel share one durable local source identity. The panel records `ingressId:local-ui` in its origin. They are built-in authority on this computer, not external control sources or provider accounts. Their source ID remains available for task and receipt attribution; new local origins have no account ID. Local `whoami` reports `authority:local`, a null account `id`, and `identityResolution.state:not-applicable`.

Control-source lists, Accounts, topology account nodes and source pickers exclude the built-in local source. Other configured local transports remain ordinary control sources. Local product metadata remains available to label historical records. Local authority cannot be disconnected, revoked, removed or switched to an external connection. Native mutations reject it with `LOCAL_SOURCE_PROTECTED`; the UI offers no control-source actions for it.

For legacy installations, ensuring the built-in local ingress repairs its local credential marked `revoked` or `connectionRemoved` to `connected`, clears removal and pending-switch metadata, persists the repair and logs the transition once. It preserves the source ID and historical origins. Account reconciliation detaches local source membership and retains a tombstone for any resulting empty account; Agent profiles and other source memberships remain intact. External sources never receive this repair. A local notification handshake may verify delivery, but its identity resolution stays `not-applicable` and never attaches a provider account.

`SOURCE_REVOKED` identifies the rejected source and ingress and distinguishes revoked authorization, removed connections and superseded credentials. CLI failures provide authorization recovery in `next`, without command-usage advice. Revoked external sources require a new authorized control source; disconnected sources whose connection was removed can use CLI/AX source switching and reauthorize. Local callers restart the upgraded ARC app and retry to trigger automatic repair.

## Identity resolution

ARC derives a source's account from provider authorization facts when available (`accountId`, email, organization). Client names, labels, platform guesses and caller-supplied metadata are not provider facts. Agent profiles resolve from the CLI's own auth status.

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

SRC and AGENT accounts are inspected from the homepage topology. There is no Accounts dock page. Old `accounts` page state, deep links and navigation events return to the homepage. Account merge, notification binding/testing, default-account switching and dispatch-policy summaries have no UI entries; their Core, CLI and AX capabilities remain unchanged.

### Add account

AGENT L1 starts the existing native login for its selected Agent, then opens the centered sign-in and confirmation dialog. The login dialog also exposes Account type (Claude, ChatGPT / Codex, API key, Detect on this computer) → Sign in (waiting state, browser choice as pills inside this step, Copy login link, Paste a code instead, one line noting that `account_add` lets Agents run the flow) → Confirm (detected identity, alias field, an identity-match notice when it matches an existing source).

### Privacy mode

One persisted preference, toggled from the source panel header. It blurs emails, organizations, identity keys, session names and connection addresses everywhere they render. `cli app snapshot` defaults to privacy on. The topology shows aliases only, so it needs no blurring.

### Homepage panels

SRC panels dock left; AGENT panels dock right at every viewport width. Portrait panels overlay the scene without relocating nodes. Platform L1 opens account L2 and task L3 with a back control. A platform with exactly one active account opens L2 directly; Back still returns to L1. The panel shell stays in place while layers change. Escape returns one layer before closing the panel, and editing dialogs dismiss first.

SRC L1 lists each account once with alias and source state, even when several connections belong to that account. Add account opens Add SRC with the product preselected. SRC L2 shows account health, observed source states and the latest last-seen timestamp among this platform's sources for the account. Its conversation list reads `src-conversations/query` by account ID. A conversation with one task reference opens that task on the AGENT side; several task references expand into explicit choices. A conversation without an ARC task remains read-only. It does not infer a task from the conversation URL, title or source order.

AGENT L1 shows name, version, Add account and compact content-height account rows from the top, with alias, profile state and the account's quota icon. On both sides, healthy states may use an accessibly named dot; signed-out, disconnected, invalid and other attention states show visible text. It has no aggregate task list or platform quota. AGENT L2 shows account health, profile states, account quota and tasks with recorded account attribution, including merged account IDs. Task rows open the unchanged L3 detail. A task opened directly without recorded account attribution returns to L1 rather than inventing an account.

Both L2 panels edit aliases through InlineName and confirm removal through ObjectMenu. Removal uses `account_remove` with `running:finish`; the confirmation states the effect on running tasks and retained history. Rename uses `account_update` and refreshes the shared account store. There are no connection tabs, source disconnect controls, cross-role account links, profile reauthentication shortcuts, default selectors or merge controls in these panels. CLI/AX retains those capabilities.

The hub-right Agent settings dialog owns discovery, enable/disable, order and official installation links. It has no account, task, quota overview or display-settings inspector. Display preferences are configured through CLI/AX. Quota overview remains available through its existing tray surface.

### Homepage

See [Arena homepage](arena.md).

## Fixtures

Tests, design examples and docs use invented identities on `example.com` and placeholder organizations. No real emails, organization names or session IDs.
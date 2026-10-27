# UI component inventory

[Component specification](component-spec.md) · [Object model](object-model.md) · [UI](ui.md)

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

This inventory describes current presentation owners. The object model defines the panel and connection-flow boundaries. UI acceptance uses `npm run dev:ui` against real app data; native authentication, connectivity and delivery require runtime checks.

## Identity and shared state

`ui/state/accounts.ts::useAccounts` supplies account identity, source membership and quota to the homepage and inspectors. Account IDs, merged IDs and explicit profile associations determine ownership. Labels, email text and source order never choose a mutation target. A source with unresolved identity remains a source without a fabricated account.

The built-in local authority is excluded from user-managed SRC accounts. Connection state still includes Local and every externally configured ingress. Read-only rows do not erase capabilities or stored bindings.

## Navigation and page owners

| Surface | Owner | Current boundary |
| --- | --- | --- |
| Homepage | ConnectionOverview, Topology, IngressPanel, AgentPanel | SRC and AGENT inspectors; task bubbles and detail; Add SRC and Agent settings hub actions. |
| Logs | RecordsPage | Time, available source, operation and result; filtering and expandable evidence. |
| Connections | ConnectionsPage | Public link and Local state, address copy, deployment and start/stop; other connections are read-only rows. |
| Settings | SettingsPage | Task behavior, startup, notifications, language, appearance and updates; one System permissions entry. Specialized settings use CLI/AX. |
| System permissions | SystemPermissions | Existing OS checks and grant requests, including split app/command disk-access evidence. No OAuth grant or tool-policy list. |

`App` owns the dock in Logs, Connections, Settings order. `resolvePage` normalizes saved page state and external navigation. Removed `tasks` and `accounts` targets return to the homepage; `remote` opens Connections; `permissions` opens Settings. Desktop deep-link and tray adapters apply the same mapping.

## SRC platform and account

| Variant | Implementation | Current callers and behavior |
| --- | --- | --- |
| Platform Chip / Node / Row / Card | `objects/src-platform/` | Provenance, topology, Add SRC product choice and shared platform framing. Platform identity is distinct from vendor grouping. |
| Account Chip / Node | `objects/src-account/` | Cross-role references, task provenance and topology. Historical references do not invent live state. |
| Account Row | SrcAccountRow | SRC L1 account list and platform cards; homepage rows show one alias with its observed source states. |
| Account Card | SrcAccountCard | Identity, state, timestamps and current authorization evidence. Homepage L2 composes account state, last seen and conversation rows. No grant history. |

SourcePanel owns SRC L1/L2. Add account preselects the product. L2 reads account conversations; task references open AGENT L3. InlineName edits aliases in the L2 header; ObjectMenu confirms removal in an anchored Popover. SourceDispatches remains in Logs for source-attributed receipts. The old source connection inspector and cross-role panel links are removed.

There is no Accounts page, notification binding/test card, merge dialog, product correction, Change connection or account-wide dispatch-policy summary. Core identity, notification and merge operations remain available through CLI/AX.

## AGENT platform and account

| Variant | Implementation | Current callers and behavior |
| --- | --- | --- |
| Platform Chip / Node / Row / Card | `objects/agent-platform/` | Topology, catalog/settings and AgentPanel framing. Catalog owns enablement, order and official setup links. |
| Account Chip / Node | `objects/agent-account/` | Account topology and object reference mounts with account-owned quota. |
| Account Row / Profile Row | AgentAccountRow, AgentProfileRow | Account lists and profile evidence; native reauthentication uses explicit profile IDs. Default state is read-only. |
| Account Card | AgentAccountCard | AgentPanel identity, profile state, quota and account-filtered conversations/tasks. |

AddAccount retains native login and confirmation. AgentPanel L1 lists accounts with state/quota icons and starts the Agent login flow. L2 owns account quota, attributed tasks and rename/remove. Back traverses L3 to L2 to L1, including the single-account shortcut. Display preferences use CLI/AX; Agent settings has no quota overview or detail inspector.

## TUNNEL and Add SRC

| Variant | Implementation | Current callers and behavior |
| --- | --- | --- |
| Chip | TunnelChip | Source rows/cards; navigates to Connections when a live target exists. |
| Node | TunnelNode | Arena wire painter boundary. No vertex or click target is added. |
| Row | TunnelRow | Read-only additional Connections rows with kind, address and state. LocalConnectionRow shows Local state only.  |
| Card | TunnelCard | Public-link state, masked MCP address and start/stop. |

AddControlSource offers Product, Configure, Approval and observed success for remote products; local products show a setup command. PublicLinkDeployment owns inline deployment in Add SRC and Connections, preserving progress, cancellation and retry. No connection selector, nested setup dialog, provider editor, Secure Tunnel setup, joined-relay management, hosted-relay administration, invitation or member-device component/export remains.

DeploymentProgressCard and DeploymentProgressChip remain for public-link deployment. Relay member objects and their design mounts are removed. OAuth pairing approval remains in AuthorizationRequestCard and its live ApprovalCard adapter; this is distinct from the removed grant-history and tool-policy editors.

## TASK and execution requests

| Variant | Implementation | Current callers and behavior |
| --- | --- | --- |
| Chip | TaskChip | Compact task references; no action without a destination. |
| Node | TaskNode through ActivityBubble | Topology task content, unread action, reorder and attention. |
| Row | TaskRow | AgentConversations, SourceDispatches, resolved update work and receipt projections. |
| Card | TaskCard | ActivityTimeline detail framing, recorded summary and host-owned timeline/request body. |
| Execution request | InteractionRequestCard / Chip / Row | TaskNeedsYou, AppUpdate and timeline history; shared RequestCard framing with domain-specific response adapters. |
| Authorization request | AuthorizationRequestCard / Chip / Row, SourceAuthorizationChip | Pairing, current source authorization and pending request review. |

The Tasks page and its receipt-detail host are removed. Homepage L3 task detail remains. TaskNeedsYou retains pending execution input and receipt history. RequestRouting retains its live routing controls. DispatchSpec remains the sole recorded task/turn model, effort and tier renderer; it is not an account dispatch-policy summary.

Peer messages have no dedicated UI object model or renderer. Generic timeline text does not establish a peer-message presentation.

## Quota and shared presentation

AgentQuotaIcon retains the single/dual account rings. AgentQuota retains compact window cards, reset information, pacing and refresh. QuotaBubble retains the richer provider presentation, product usage and credit details. UsageHistory and ResetCreditDetails retain their disclosure behavior. The removed account-workspace quota adapter has no remaining caller.

SectionHeader, EntityRow, EntityCard, FactList, Freshness, AddressField, SettingsSection, SettingRow and shared form/action primitives own recurring layout. StateBadge uses `objects/statePresentation.ts`; unknown states remain neutral. PlatformIcon resolves source, Agent and provider artwork. Sensitive, SensitiveInput, SensitiveIdentity and PrivacyToggle own masking; Address copies raw values only on explicit action.

## Fixtures and design mounts

- `homepage-*`, `task-bubbles-*` and `task-detail-*` cover topology and L3, including portrait/narrow layout at the shared 640-wide viewport.
- `src-*` and `agent-*` cover L1/L2, single-account shortcuts, empty collections, multi-connection source identity, quota and Agent settings/login.
- `add-src-*`, `connections-*`, `settings-*`, `update-*` and `logs-*` cover the surviving creation and workspace surfaces. `navigation-redirects` covers all four removed page targets through the App navigator.

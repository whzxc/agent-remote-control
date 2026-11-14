# Design asset mapping and status

`modules/agent-account-add.tsx` owns the approved Codex add-account dialog: `oauth`, `import`, and `external`. It reuses the M Dialog, Field, Input, SingleChoice and Button. Content lives in `fixtures/agent-account-add.ts`. Runtime implementation: `ui/components/AgentAccountAdd.tsx`; entry points: `AgentPanel` and `AgentPlatformView`. The `codex-account-add-*` browser fixtures cover the declared forms. Claude add is the exact frame `modules/agent-account-add/claude-add`; it is not a frame of `modules/agent-account`.

The Agent platform and quota assets use synthetic data from `fixtures/agent-accounts.ts` and `fixtures/quota.ts`.

| Source / frames | Runtime owner | Behavior |
|---|---|---|
| `surfaces/agent-platform.tsx` / `accounts`, `single-account`, `empty` | `ui/components/AgentPlatformView.tsx`, `ui/components/AgentPanel.tsx` | The first-level Claude and Codex panels retain platform scope at any account count. Account history opens from the selected alias. |
| `modules/agent-account.tsx` / `account-card`, `edit-account-alias`, `remove-account` | `ui/components/AccountCards.tsx` | Both platforms share one card with alias, privacy-aware email and a default badge. Signed-out profiles offer recovery through their owning login. The panel can remove standalone managed profiles while preserving history. Edit and remove use the M Dialog. |
| `modules/agent-account-add.tsx` / `claude-add`, `reauth`, `reauth-waiting`, `reauth-expired` | `ui/components/AgentAccountAdd.tsx` | Shared M Dialog with local Chrome profile selection on desktop. Claude accepts a manual authorization code when required. |
| `modules/quota.tsx` / `quota-card-healthy`, `quota-card-warning`, `quota-card-exhausted` | `ui/components/ui/QuotaCard.tsx`, `ui/components/AgentQuota.tsx`, `ui/subscriptions/QuotaBubble.tsx` | Platform cards, account history and subscription surfaces share a window card. Reset and pace details and display preferences apply in each. |

[Governance and direction](design.md) · [ADG asset rules](https://github.com/whzxc/agent-design-gallery/blob/main/docs/asset-rules.md#adopting-an-existing-project)

## Status conventions and scope

Review and adoption are separate. **Proposed** means a new visual proposal awaits user gallery approval and has no runtime adoption. **User-approved** means the user has approved the visual source; runtime adoption remains separate. **Pending** means the current asset has not completed its assigned governance review. **Awaiting Claude** means the proposed structural family awaits control-source review. **Awaiting user** means the current proposal requires gallery approval. **Reviewed** requires Claude's approval; visual differences outside the structural crop criteria or open decisions also require user gallery approval. **Adopted** means a design composition or mapped implementation consumes the part. **Unknown** means the named counterpart or consumer is unresolved. A specimen alone is not a consumer. Existing usage does not imply a reviewed visual match.

The mapping records current review, adoption and retained exceptions. Codex owns proposals, implementation and comparisons; release follows the assigned review authority. New visual direction requires user gallery approval.

Remaining work consists of the Known gaps below. Missing presentation forms require their own visual source review before runtime implementation changes.

Quota health uses `--success` for healthy readings, bars and rings, including account summaries. `usageColors.good` maps to `var(--success)`; caution keeps `--warning`, warning and exhausted keep `--danger`, and unknown keeps `--text-tertiary`.

Layer sources are Reviewed (user-approved) and adopted. All center workspaces use XL (960px). Dialogs and left/right node panels use M (560px). Narrow and portrait viewports use the available width between the margins. The shared design shells inherit these widths without per-surface size overrides. Workspace frames capture the panel region, including its fixed header and footer. `surfaces/layers` owns viewport placement: every current height is vertically centered between the top line and bottom margin. First-level layers have no scrim. Only nested dialogs dim their stationary parents, using 24% light and 60% dark scrims. Entry and exit currently use opacity fades. Geometry settles instantly during entry; subsequent height changes preserve the vertical center. The shell retains the largest height within a view and may reset it on content replacement.

The runtime `ConfirmDialog` reuses the approved Dialog and Button forms for removal confirmation in Connections, connector cards, MCP hub, Relay hosting and Devices. It preserves their existing actions and footer spacing.

## Owners, parts and consumers

Paths in the tables are relative to `design/`, unless prefixed with `ui/`. Implementation entries identify source counterparts; fidelity review is pending. Direct design users appear per part below. Transitive consumers follow those sources' imports into the surface table; homepage imports through `modules/homepage-topology` are included explicitly. Same-source composition and runtime usage are stated where no external design consumer exists. `GET /relationships` in the ADG viewer exposes the production graph. All production compositions participate in default discovery.

Generic sources live in `components/`; feature sources live in `modules/`. The owner column assigns current responsibility. The Frames column lists current source frames, including combined frames that still need per-part coverage.

| Source / owner | Part | Current frames | Direct design consumer / adoption | Implementation counterpart | Review / remaining gap |
| --- | --- | --- | --- | --- | --- |
| `components/panel.tsx` / Panel family | `Panel`, `Dialog` slot widths | Existing `panel`, `dialog`; slot compositions in `surfaces/layers` | `surfaces/layers` | `ui/components/ui/Dialog.tsx`, `ui/components/ui/Panel.tsx` node slots | Reviewed (user-approved). Center Panel uses XL; Dialog and node PanelShell use M. Shared geometry caps height and keeps the header/footer outside the scrolling body. All layers share one centered slot; content chooses M or XL size. |
| `components/panel.tsx` / Panel family | `DialogDismissalFooter` | `dialog-discard`, `dialog-running-cancellable`, `dialog-running` | Same-source Dialog compositions | `ui/components/ui/LayerDismissalFooter.tsx`, `ui/state/layers.ts` | Reviewed (user-approved). Replaces ordinary footer actions after outside input or Escape. Keep editing is the focused primary action. Both running states show the pending close and a focused primary Keep open action that withdraws it. Cancellable work also offers Stop and close. |
| `components/agent-icon.tsx` / Brand icons | `BrandMark` | `brand-mark` | `components/setup-choice`, `components/single-choice`, `components/tile`, `modules/agent-settings`, `modules/connectors`, `modules/quota`, `modules/timeline`, `surfaces/agent-platform`, `surfaces/quota-overview`, `surfaces/source-panel` | `ui/components/ui/index.tsx#BrandMark` | Reviewed. Adopted by choices, tiles, quotas and composed surfaces. Part frame crops the existing 38px mark from AgentIcon no-ring. Runtime BrandMark accepts markup and 24/40px sizes; design resolves a brand key and caller size. |
| `components/agent-icon.tsx` / Brand icons | `AgentIcon` | `agent-icon-no-ring`, `agent-icon-single-ring` and its pace variants, `agent-icon-two-part-ring`, `agent-icon-three-part-ring` | `modules/topology-node`, `surfaces/agent-panel` | `ui/components/ui/agent-icon.tsx#AgentIcon` | Reviewed and adopted, including single-ring pace and tick direction. Runtime AgentQuotaIcon supplies markup/readings; design uses a brand key and fixed specimen readings. Runtime omits zero-value fill paths; source draws a zero-length dash. |
| `components/button.tsx` / Button family | `Button` | `danger`, `ghost`, `pending`, `primary`, `secondary` | `components/notice`, `components/prompt`, `modules/ax`, `modules/board`, `modules/connection-onboarding`, `modules/connectors`, `modules/general-settings`, `modules/homepage-topology`, `modules/mcp-service`, `modules/onboarding`, `modules/pets`, `modules/relay-hosting`, `modules/request`, `modules/source-onboarding`, `modules/timeline`, `modules/updates`, `modules/welcome`, `surfaces/connections`, `surfaces/quota-overview` | `ui/components/ui/index.tsx#Button`; `ui/style.css` | Reviewed. Adopted. No direct implementation capture; surface captures cover use. Runtime uses 18px line-height and wrapping; source uses 16px and nowrap. Disabled opacity and link geometry need owning implementation review. |
| `components/card.tsx` / Card family | `Card` | `card`, `card-reply` | `components/settings-row`, `modules/agent-settings`, `modules/ax`, `modules/connectors`, `modules/experimental`, `modules/pets`, `modules/request`, `modules/updates` | `ui/components/ui/card.tsx#Card` | Reviewed. Adopted by composed surfaces. Runtime card defaults match the generic ownership; fidelity remains pending implementation review. |
| `components/card.tsx` / Card family | `CardHeader` | `card-header` | Adopted via runtime ConnectionsContent and objects/ConnectorCard; no design usage | `ui/components/ui/card.tsx#CardHeader` | Reviewed. Adopted via runtime ConnectionsContent and objects/ConnectorCard. No composed design consumer. Part frame uses existing card specimen text; runtime header uses a grid and source uses a flex column. |
| `components/card.tsx` / Card family | `CardTitle` | `card-title` | No design usage; no runtime consumer found | `ui/components/ui/card.tsx#CardTitle` | Reviewed. Retained without a design or runtime consumer; adoption/deletion remains pending. Part frame uses existing card specimen text. |
| `components/card.tsx` / Card family | `CardDescription` | `card-description` | No design usage; no runtime consumer found | `ui/components/ui/card.tsx#CardDescription` | Reviewed. Retained without a design or runtime consumer; adoption/deletion remains pending. Part frame uses existing card specimen text. |
| `components/card.tsx` / Card family | `CardContent` | `card-content` | Adopted via runtime ConnectionsContent and objects/ConnectorCard; no design usage | `ui/components/ui/card.tsx#CardContent` | Reviewed. Adopted via runtime ConnectionsContent and objects/ConnectorCard. No composed design consumer. Part frame uses existing card specimen text. |
| `components/card.tsx` / Card family | `CardFooter` | `card-footer` | No design usage; no runtime consumer found | `ui/components/ui/card.tsx#CardFooter` | Reviewed. Retained without a design or runtime consumer; adoption/deletion remains pending. Part frame uses existing card specimen text. |
| `modules/request.tsx` / Task requests | `PermissionCard` | `permission-card`; request-sheet-permission and inline-request compositions | Same-source RequestSheet and InlineRequest; transitive surfaces/task-detail | `ui/components/TaskNeedsYou.tsx` (inline permission preview); `ui/components/ActivityInteraction.tsx` | Reviewed. Adopted. Source content is configurable with unchanged defaults. Runtime renders native command/path/reason data and owns approval, bypass and rejection behavior. |
| `components/copy-field.tsx` / Input family | `CopyField` | `default` | `modules/connection-management`, `modules/connection-onboarding`, `modules/source-onboarding` | `ui/components/ui/index.tsx#CopyField` | Reviewed. Adopted by connections and setup. Runtime password masking uses Sensitive and visibility controls; source uses blur for masked/password. Static loading occupies the copy action; runtime loading replaces the actions. Implementation-state coverage remains pending. |
| `modules/model-configuration.tsx` / Model configuration | `DispatchSpec` | `dispatch-spec-standard` | `modules/task-presentation`, `modules/timeline` | `ui/components/ui/DispatchSpec.tsx` | Reviewed. Adopted. Representative states live in fixtures/model-configuration; runtime fidelity remains pending implementation review. |
| `modules/model-configuration.tsx` / Model configuration | `EffortGauge` | `effort-gauge-five-levels`, `effort-gauge-four-levels`, `effort-gauge-three-levels` | same-source DispatchSpec | `ui/components/ui/EffortGauge.tsx` | Reviewed. Adopted. Representative states live in fixtures/model-configuration; runtime fidelity remains pending implementation review. |
| `modules/model-configuration.tsx` / Model configuration | `EffortSlider` | `effort-slider-stepped` | same-source ModelEffortPicker | `ui/components/ui/EffortSlider.tsx` | Reviewed. Adopted. Representative states live in fixtures/model-configuration; runtime fidelity remains pending implementation review. |
| `modules/model-configuration.tsx` / Model configuration | `ModelDialog` | `model-effort` composition | same-source ModelEffort | `ui/components/AgentDispatchDefaults.tsx#TaskDispatchDialog` | Reviewed. Adopted M Dialog; part is visible in the model-effort composition. Runtime portal boundaries and capture selector remain in [C]. |
| `modules/model-configuration.tsx` / Model configuration | `ModelEffortPicker` | `model-effort` composition | same-source ModelEffort | `ui/components/ModelEffortPicker.tsx` | Reviewed. Adopted; part is visible in the model-effort composition. Runtime portal boundaries and capture selector remain in [C]. |
| `modules/model-configuration.tsx` / Model configuration | `ModelMenu` | `model-effort` composition | same-source ModelEffort | `ui/components/ModelEffortPicker.tsx` | Reviewed. Adopted; part is visible in the model-effort composition. Runtime portal boundaries and capture selector remain in [C]. |
| `modules/model-configuration.tsx` / Model configuration | `ModelEffort` | `model-effort` composition | Mapped runtime TaskDispatchDialog and ModelEffortPicker; no external design consumer | `ui/components/AgentDispatchDefaults.tsx; ui/components/ModelEffortPicker.tsx` | Reviewed. Adopted; part is visible in the model-effort composition. Runtime portal boundaries and capture selector remain in [C]. |
| `components/field.tsx` / Input family | `Input` | `input`, `input-error` | `modules/general-settings`, `modules/onboarding`, `modules/pets`, `modules/request` | `ui/components/ui/index.tsx#Input` | Reviewed. Adopted by approval, settings, pets and setup. Independent input frames reuse the existing field content. Runtime uses a native input and aria-invalid; static design uses invalid. Runtime fidelity remains pending. |
| `components/field.tsx` / Input family | `Field` | `field`, `field-error` | `modules/onboarding`, `modules/pets` | `ui/components/ui/index.tsx#Field` | Reviewed. Adopted by pets and setup. Runtime error text has 16px line-height; source uses 12px. Runtime heading gap is 12px; source uses 8px. Reconcile in implementation scope. |
| `components/icon-button.tsx` / Button family | `IconButton` | `compact`, `regular` | `components/copy-field`, `components/panel`, `modules/agent-settings`, `modules/ax`, `modules/board`, `modules/connection-management`, `modules/connectors`, `modules/experimental`, `modules/general-settings`, `modules/homepage-topology`, `modules/mcp-service`, `modules/model-configuration`, `modules/onboarding`, `modules/quota`, `modules/timeline`, `surfaces/agent-panel`, `surfaces/agent-platform`, `surfaces/pets-settings`, `surfaces/platforms`, `surfaces/quota-overview`, `surfaces/relay-hosting`, `surfaces/source-panel` | `ui/components/ui/index.tsx#IconButton`; `ui/style.css` | Reviewed. Adopted. No direct implementation capture; surface captures cover use. Runtime has circular corners; source uses control radius. Runtime agent/active presentation is caller-owned; exact parity remains unverified. |
| `modules/nav-capsule.tsx` / Homepage topology | `NavCapsule` | `default` | `modules/homepage-topology`, `surfaces/homepage-topology-mobile` | Unknown named counterpart; navigation is composed in `ui/App.tsx` | Reviewed. Runtime fidelity remains in implementation scope. |
| `components/notice.tsx` / Generic feedback | `Notice` | `danger` | `modules/mcp-service` | `ui/components/ui/index.tsx#Notice` | Reviewed. Adopted through mapped runtime usage. No composed design consumer. Runtime uses a 16px gap and 14px vertical padding; source uses a 12px gap and 16px/13px padding. Reconcile with MCP and other consumers in implementation scope. |
| `modules/request.tsx` / Task requests | `QuestionCard` | `question-card`; request-sheet-question composition | Same-source RequestSheet | `ui/components/TaskQuestion.tsx` | Reviewed. Adopted. Runtime owns answer drafts, validation and submission. Source preserves representative choices and the other-answer field. |
| `modules/request.tsx` / Task requests | `RequestSheet` | `request-sheet-permission`, `request-sheet-question` | Mapped runtime TaskNeedsYou narrow Dialog | `ui/components/TaskNeedsYou.tsx` | Reviewed. Adopted. Owns the approval-permission and approval-question captures. Permission uses S and question uses M, capped to the full-width portrait slot at 390×844; actions stay in the fixed footer. See [F]. |
| `modules/request.tsx` / Task requests | `InlineRequest` | `inline-request`; surfaces/task-detail/needs-you | `modules/timeline` | `ui/components/TaskNeedsYou.tsx` | Reviewed. Adopted. Owns request heading/status and PermissionCard composition; runtime paging, routing and focus behavior remain implementation concerns. |
| `modules/request.tsx` / Task requests | `RequestEntry` | `request-entry` | Mapped runtime TaskNeedsYou; no external design consumer | `ui/components/ui/TaskPresentation.tsx#RequestEntry` | Reviewed. Adopted via runtime TaskNeedsYou. Source remains a static entry; runtime opens the narrow request sheet and pauses routing. |
| `modules/request.tsx` / Task requests | `ReviewUnavailable` | `review-unavailable` | Mapped runtime ActivityTimeline; no external design consumer | `ui/components/ui/TaskPresentation.tsx#ReviewUnavailable` | Reviewed. Adopted via runtime ActivityTimeline. Runtime exposes alert semantics and retry behavior; source preserves the existing specimen. |
| `components/panel.tsx` / Panel family | `Panel` | `panel` | `modules/agent-settings`, `modules/display-settings`, `modules/experimental`, `modules/general-settings`, `modules/onboarding`, `modules/welcome`, `surfaces/pets-settings`, `surfaces/platforms`, `surfaces/relay-hosting`, `surfaces/updates` | `ui/components/ui/Panel.tsx`; `ui/components/ui/Dialog.tsx`; `ui/components/ui/Panel.tsx` node slots | Reviewed. Adopted by panels, settings and setup. Runtime Panel owns workspace and node-slot geometry, focus and motion; static Panel owns the generic presentation. |
| `components/panel.tsx` / Panel family | `Dialog` | `dialog` | No external design consumer; mapped runtime or same-source use requires owning review | `ui/components/ui/index.tsx#Dialog` | Reviewed. No external design consumer. Retained with its mapped runtime Dialog usage; the static export delegates to Panel. |
| `components/panel.tsx` / Panel family | `PanelShell` | `panel-shell` | `modules/ax`, `modules/board`, `modules/mcp-service`, `modules/model-configuration`, `modules/request`, `modules/timeline`, `surfaces/agent-panel`, `surfaces/agent-platform`, `surfaces/connections`, `surfaces/quota-overview`, `surfaces/source-panel` | `ui/components/ui/Dialog.tsx#LayerShell` (composed counterpart) | Reviewed. Adopted by topology panels and request/model compositions. Independent shell presentation uses the existing panel specimen content. Runtime LayerShell composes the corresponding shell. |
| `components/panel.tsx` / Panel family | `PanelHeader` | `panel-header` | `modules/ax`, `modules/board`, `modules/mcp-service`, `modules/model-configuration`, `modules/request`, `surfaces/connections`, `surfaces/quota-overview` | Unknown shared counterpart; headers are composed by panel consumers | Reviewed. Adopted by approval, connections, Board, AX, MCP and quota. Header frame crops the panel specimen. Runtime headers remain consumer-local; shared counterpart unknown. |
| `components/prompt.tsx` / Feedback family | `Prompt` | `default` | `modules/mcp-service` | `ui/components/ui/index.tsx#Prompt` | Reviewed. Adopted by runtime MCP Hub import and add-service prompts. No composed design consumer. The stacked MCP import form uses a 16px content/action gap. Copy feedback and errors belong to runtime behavior. |
| `modules/quota.tsx` / Quota | `QuotaCard`, `QuotaCards` | `quota-card-healthy`, `quota-card-warning`, `quota-card-exhausted` | `surfaces/agent-panel`, `surfaces/agent-platform` via `modules/agent-account`, `surfaces/quota-overview` | `ui/components/ui/QuotaCard.tsx`, `ui/components/AgentQuota.tsx`, `ui/subscriptions/QuotaBubble.tsx` | Reviewed and adopted. The shared grid wraps cards to the available width. Runtime detail disclosures and meters remain interactive. |
| `modules/request.tsx` / Task requests | `RoutingRow` | `routing-row`; request-routing compositions | Same-source RequestRouting; mapped runtime RequestRouting | `ui/components/ui/TaskPresentation.tsx#RoutingRow` | Reviewed. Adopted. Runtime wraps controls and long status text; source presents the declared inline and stacked forms. |
| `modules/request.tsx` / Task requests | `RequestRouting` | `request-routing-passive`, `request-routing-actionable`, `request-routing-actionable-inline` | Mapped runtime TaskNeedsYou; no external design consumer | `ui/components/RequestRouting.tsx` | Reviewed. Adopted. Source preserves routing-state and label defaults; runtime owns timers, route changes, read-only boundaries and busy behavior. |
| `components/search.tsx` / Input family | `SearchInput` | `default` | `modules/ax`, `modules/mcp-service` | `ui/components/ui/index.tsx#SearchInput` | Reviewed. Adopted by AX and MCP. Runtime entered values use the input text color; source uses tertiary color for both values and placeholders. Reconcile entered-value state in implementation scope. |
| `components/settings-row.tsx` / General settings | `Setting` | `setting` | Adopted via mapped runtime settings; no composed design consumer | `ui/components/ui/Settings.tsx#Setting` | Reviewed. Runtime settings consumers; no external design consumer. |
| `components/settings-row.tsx` / General settings | `SettingsSection` | No standalone frame; mapped runtime section | Adopted via mapped runtime settings; no composed design consumer | `ui/components/ui/Settings.tsx#SettingsSection` | Reviewed. Runtime settings consumers; no external design consumer. |
| `components/settings-row.tsx` / General settings | `SettingLine` | Settings module compositions | `modules/agent-settings`, `modules/display-settings`, `modules/general-settings` | `ui/components/ui/Settings.tsx#Setting` (composed counterpart; prop alignment pending) | Reviewed. Runtime fidelity and standalone part coverage remain under Known gaps. |
| `components/setup-choice.tsx` / Choice family | `SetupChoice` | `product`, `row` | `components/single-choice`, `modules/source-onboarding` | `ui/components/ui/index.tsx#SingleChoice` option-card presentation (no named SetupChoice counterpart) | Reviewed. Adopted through SingleChoice card/tile forms. The generic row/product presentation stays in components; source onboarding owns SetupAction. Runtime cards use a border and checked outline; source uses a filled radio dot. Reconcile in implementation scope. |
| `modules/source-onboarding.tsx` / Source onboarding | `SetupAction` | `setup-action` | Same-source SourceOnboarding; transitive surfaces/setup | `ui/components/ui/SetupChoice.tsx#SetupAction` | Reviewed. Adopted via AddControlSource. Composes generic SetupChoice. Source is static; runtime owns button semantics and interaction. |
| `components/single-choice.tsx` / Choice family | `SingleChoice` | `dropdown`, `navigation`, `option-card`, `pills`, `tabs` | `components/settings-row`, `modules/ax`, `modules/board`, `modules/connection-onboarding`, `modules/connectors`, `modules/general-settings`, `modules/mcp-service`, `modules/model-configuration`, `modules/onboarding`, `modules/request`, `modules/source-onboarding` | `ui/components/ui/index.tsx#SingleChoice` | Reviewed. Adopted by model configuration and composed surfaces. Reuses generic SetupChoice for card/tile forms. Runtime also measures available width and supports swatches, warnings, descriptions and secondary grouping; those undeclared static forms remain an implementation alignment gap. |
| `modules/task-presentation.tsx` / Task presentation | `StatePill` | `state-pill-running`, `state-pill-waiting`, `state-pill-done`, `state-pill-failed`, `state-pill-stopped` | `modules/timeline` | `ui/components/ActivityTimeline.tsx` (inline task state) | Reviewed. Adopted. Runtime uses task-state and PhaseLabel; reconcile the static dot, tint and state/phase distinction in implementation scope. |
| `components/switch.tsx` / Input family | `Switch` | `off`, `on` | `components/settings-row`, `modules/agent-settings`, `modules/display-settings`, `modules/general-settings`, `modules/mcp-service` | `ui/components/ui/index.tsx#Switch` | Reviewed. Adopted by settings-row, settings and MCP. Track, inset and thumb dimensions match the runtime source. Runtime interaction and disabled-state fidelity remain pending. |
| `components/tag.tsx` / Feedback family | `Tag` | `tag-meta`, `tag-fact`, `tag-danger`, `tag-ownership` | `modules/agent-activity`, `modules/mcp-service`, `modules/task-presentation` | `ui/components/ui/index.tsx#Tag`; `ui/components/ui/TaskPresentation.tsx#OwnershipTag` | Pending generic label-family review. Props have no task-state semantics; MCP tool labels, project metadata and application ownership reuse the generic part. |
| `components/tag.tsx` / Feedback family | `Disclosure` | `disclosure`; module MCP compositions | `modules/mcp-service` | `ui/components/ui/index.tsx#Disclosure` | Reviewed. Runtime fidelity remains in the mapped implementation scope. |
| `modules/task-presentation.tsx` / Task presentation | `TaskBubble` | `task-bubble-compact`, `task-bubble-detailed`, `task-bubble-row`, `task-bubble-row-attention`, `task-bubble-standard` | `modules/homepage-topology`, `surfaces/agent-panel`, `surfaces/homepage-topology-mobile`, `surfaces/settings` | `ui/components/ActivityBubbles.tsx#ActivityBubbleContent` | Reviewed. Retained by Agent history. The homepage uses TaskCard and NodeCapsule. Fixtures own sample content; static source widths and runtime adaptive conversation layouts require implementation fidelity review. |
| `modules/task-presentation.tsx` / Task presentation | `TaskRow` | `task-row`, `task-row-attention`; compact use in Agent/source groups | `modules/agent-activity`, `modules/source-activity` | `ui/components/ui/TaskRow.tsx#TaskRow`; runtime `ui/components/SourceDispatches.tsx` | Reviewed. Adopted. Compact layout, copy and trailing slots preserve each owner's row presentation. Independent part frames show the standard and attention presentations. Runtime is a button with disabled/focus behavior and a 1px copy gap; design is static. Agent runtime history still uses ConversationRow/ActivityBubbleContent. |
| `modules/task-presentation.tsx` / Task presentation | `TaskMessage` | `task-message-prompt`, `task-message-queued` | `modules/timeline` | `ui/components/ui/TaskPresentation.tsx#TaskMessage`; runtime `ui/components/TimelineEntries.tsx` and `ui/components/TaskQueuedMessages.tsx` | Reviewed. Adopted. Runtime uses fit-content, 12px vertical padding and 22px line-height; source is full-width with 15px padding and 16px line-height. Queued gaps also differ. |
| `modules/agent-activity.tsx` / Agent activity | `AgentTaskHistory` | `history` | `surfaces/agent-panel` | `ui/components/AgentConversations.tsx#ConversationRow`; `ui/components/ActivityBubbles.tsx#ActivityBubbleContent` | Reviewed. Adopted. Uses shared TaskRow; grouping, project metadata and dates remain Agent-owned. Runtime history still uses ActivityBubbleContent; projection and fidelity remain in Agent scope. |
| `modules/source-activity.tsx` / Source activity | `SourceTaskGroups` | `dispatches`, `history` | `surfaces/source-panel` | `ui/components/SourceDispatches.tsx` | Reviewed. Adopted. Uses shared TaskRow; group labels, phase text and disclosure availability remain source-owned. Runtime disabled rows and native state projection remain in source scope. |
| `modules/task-relationships.tsx` / Task relationships | `TaskRelation` | `task-relation-side-chat`, `task-relation-subagent` | Same-source RelationTaskCard and TaskDetailHeader; transitive surfaces/task-relationships | `ui/components/ui/TaskRelation.tsx#TaskRelation` | Reviewed. Adopted by the family region and mapped runtime consumers. Runtime labels localize through i18n; source labels are static. Runtime separator spacing depends on phase context. |
| `modules/task-relationships.tsx` / Task relationships | `TaskParentLink` | `task-parent-link` | Same-source TaskDetailHeader; transitive surfaces/task-relationships | `ui/components/ui/TaskRelation.tsx#TaskParentLink` | Reviewed. Adopted. Runtime is an actionable Button with 16px gap and 8px horizontal padding; source is static with 14px gap and 12px padding. |
| `modules/task-relationships.tsx` / Task relationships | `RelationTaskCard` | `relation-task-card`; all five cards in surfaces/task-relationships/family | Same-source TaskFamily; transitive surfaces/task-relationships | Unknown dedicated counterpart; relation cards are composed in `ui/components/ActivityBubbles.tsx` | Reviewed. Adopted by the family region. Dedicated runtime counterpart remains unknown; ActivityBubbleContent composes relation labels into task bubbles. Native relationship projection and fidelity remain in implementation scope. |
| `modules/task-relationships.tsx` / Task relationships | `TaskDetailHeader` | `task-detail-header-side-chat`, `task-detail-header-subagent` | Same-source TaskFamily; transitive surfaces/task-relationships | `ui/components/ActivityTimeline.tsx` (inline header) | Reviewed. Adopted. Runtime header belongs to the adaptive task detail region; source crops the existing fixed-width family headers. Native navigation and parent evidence remain in implementation scope. |
| `modules/task-relationships.tsx` / Task relationships | `TaskFamily` | `surfaces/task-relationships/family` | `surfaces/task-relationships` | `ui/components/ActivityBubbles.tsx`; `ui/components/ActivityTimeline.tsx` (combined relationship presentation) | Reviewed. Adopted by the family region. Agent marker, overflow control and branch layout belong to this composition. No dedicated runtime owner or prepared capture exists for this combined 1140×520 layout. |
| `modules/timeline.tsx` / Relay timeline | `RelayRoute`, `RelayMessage` | relay-route, relay-message-{dispatch,followup,queued,local} | Same-source relay parts and RelayTimeline | `ui/components/RelayRoute.tsx`, `TimelineEntries.tsx#Prompt`, `TaskQueuedMessages.tsx` | User-approved. Adopted. Controller instructions are left-aligned with a source edge and a directional route. The route needs an ARC dispatch receipt naming the controller; turns without one use the neutral `local` form. `queued` uses the existing queued follow-up state. |
| `modules/timeline.tsx` / Relay timeline | `TimelineStep`, `TimelineRail` | timeline-step-{thought,thought-expanded,thinking,say,say-streaming,tools,edit,failed,live,request,answered}, timeline-rail | Same-source RelayTimeline | `ui/components/TimelineEntries.tsx` | User-approved. Adopted. One flat rail per turn in transcript order: reasoning summaries, narration, grouped or single tools, edits with line counts, inline failures with their first error line, one live row with elapsed time and output tail, and the streaming caret on the newest narration. `answered` names the responder from a recorded answer origin and falls back to the plain approval label (`timeline-step-answered-unknown`). ARC records bounded answeredBy attribution in its own interaction and approval state. |
| `modules/timeline.tsx` / Relay timeline | `TimelineFold`, `TimelinePlanDock`, `TimelineEarlierTurn` | timeline-fold, timeline-fold-failed, timeline-plan-dock, timeline-plan-dock-expanded, timeline-earlier-turn | Same-source RelayTimeline | `ui/components/TimelineEntries.tsx`, `TaskNeedsYou.tsx`, `TaskOutcome.tsx` | User-approved. Adopted. Settled work folds to duration and counts; failure opens the fold. The live plan moves to the panel footer while a turn runs and expands upward. Earlier turns collapse to route, outcome and duration. |
| `modules/timeline.tsx` / Relay timeline | `RelayReply`, `RelayRequest`, `RelayFailure` | relay-reply, relay-request, relay-failure | Same-source RelayTimeline | `ui/components/TimelineEntries.tsx`, `TaskNeedsYou.tsx`, `TaskOutcome.tsx` | User-approved. Adopted. Final reply and review cards have neutral borders without a colored left edge. The final reply is addressed back to the controller as a role; no delivery or read status is claimed. Requests reuse PermissionCard and RequestRouting with the existing routing states. Failure keeps retained-change and retry copy. |
| `modules/timeline.tsx` / Relay timeline | `RelayTimeline` | surfaces/task-detail/relay-{running,needs-you,done,failed} | surfaces/task-detail | `ui/components/ActivityTimeline.tsx` | User-approved. Adopted. The header shows the relay route instead of a separate source chip. Bound to relay-running, relay-needs-you, relay-done and relay-failed accept:ui scenarios. |
| `components/tile.tsx` / Generic tiles / task presentation | `Tile` | `card`, `phase` | `modules/agent-activity`, `modules/ax`, `modules/board`, `modules/connection-management`, `modules/connection-onboarding`, `modules/mcp-service`, `modules/source-activity`, `modules/source-onboarding`, `modules/task-presentation`, `modules/task-relationships`, `modules/welcome`, `surfaces/agent-panel`, `surfaces/quota-overview` | `ui/components/ui/index.tsx#Tile`; `ui/components/ui/TaskPresentation.tsx#AgentPhaseTile` | Reviewed. Runtime fidelity remains in the mapped implementation scope. |
| `components/tooltip.tsx` / Feedback family | `Tooltip` | `setting` | No external design consumer; mapped runtime or same-source use requires owning review | `ui/components/ui/index.tsx#Tooltip` | Reviewed. Adopted through mapped runtime usage. No composed design consumer. Runtime limits width and owns portal, dismissal and focus behavior. Static frame represents content only. |
| `modules/topology-mark.tsx` / Homepage topology | `TopologyMark`, `ArcRecovery` | `topology-mark` and its hover and fault forms, `arc-recovery-remote`, `arc-recovery-core`, `arc-recovery-core-stopped`, `arc-recovery-blocked` | `modules/homepage-topology`, `surfaces/homepage-topology-mobile` | `ui/topology/Hub.tsx` (composed counterpart) | Reviewed and adopted. A remote fault offers Connections and recovery side by side. ARC-owned remote transport and Core health have independent recovery. Browser fixtures are `studio-connections`, `studio-no-connections`, `studio-stopped` and `studio-unavailable`. |
| `modules/topology-group.tsx` / Homepage topology | `TopologyGroup` | `mixed`, `pool`, `rail-agent`, `rail-source`, `unlabeled` | `modules/homepage-topology` | `ui/components/ui/TopologyGroup.tsx`; `ui/components/ui/TopologyGroup.css`; `ui/topology/Topology.tsx` | Reviewed and Adopted. Portrait capsules place the brand marks nearest their rail. Same-brand pools show their brand and total member count; mixed groups show up to three brand marks. Topology status and quota dots are removed. |
| `modules/topology-node.tsx` / Homepage topology | `TopologyNode` | `default` | `modules/homepage-topology`, `surfaces/homepage-topology-mobile` | `ui/topology/Topology.tsx` (composed counterpart) | Reviewed. Runtime fidelity remains in implementation scope. |
| `modules/topology-scene.tsx` / Homepage topology | `TopologyScene` | `default` | `modules/task-relationships`, `modules/homepage-topology`, `surfaces/homepage-topology-mobile` | `ui/topology/Topology.tsx` (composed counterpart) | Reviewed. Free-form canvas; all production compositions are discoverable modules. |
| `modules/onboarding.tsx` / Shared onboarding | `OnboardingChoiceField` | `onboarding-choice-field` | modules/connection-onboarding | `ui/components/AddConnection.tsx` (inline choices) | Reviewed. Adopted. Composes SingleChoice; live choice state and labels belong to the connection flow. |
| `modules/onboarding.tsx` / Shared onboarding | `OnboardingField` | `onboarding-field` | modules/source-onboarding, modules/connection-onboarding | `ui/components/AddConnection.tsx`; `ui/components/AddControlSource.tsx` (inline Field/Input compositions) | Reviewed. Adopted. Source presents static field values; native input semantics and validation belong to runtime. |
| `modules/onboarding.tsx` / Shared onboarding | `OnboardingSteps` | `onboarding-steps` | Same-source OnboardingShell | `ui/components/SetupDialog.tsx` (inline steps) | Reviewed. Adopted. Source preserves representative step labels and progress; runtime owns navigation. |
| `modules/onboarding.tsx` / Shared onboarding | `OnboardingFooter` | `onboarding-footer` | Same-source OnboardingShell | `ui/components/SetupDialog.tsx` (inline footer) | Reviewed. Adopted. Source preserves per-step action dimensions; runtime owns pending/disabled states and submission. |
| `modules/onboarding.tsx` / Shared onboarding | `OnboardingShell` | surfaces/setup standalone and nested compositions | surfaces/setup | `ui/components/SetupDialog.tsx` | Reviewed. Adopted. Owns shared heading, breadcrumbs, steps and footer; business content enters through children. Nested width and accessible text gaps remain in [E]. |
| `modules/welcome.tsx` / Welcome | `WelcomeChoice` | `welcome-choice-local`, `welcome-choice-remote` | Same-source Welcome | `ui/components/ui/SetupChoice.tsx#WelcomeChoice`; `ui/components/Onboarding.tsx` | Reviewed. Adopted. Crops preserve the grid's equal-height choices. Runtime owns selection and navigation. |
| `modules/welcome.tsx` / Welcome | `WelcomeStatus` | `welcome-status` | Same-source Welcome | `ui/components/Onboarding.tsx`; `ui/components/ui/SetupChoice.tsx#WelcomeStatusAction` | Reviewed. Adopted. Source combines ready status and an invite action; runtime composes separate status actions. Reconcile in implementation scope. |
| `modules/welcome.tsx` / Welcome | `Welcome` | surfaces/setup/welcome | surfaces/setup | `ui/components/Onboarding.tsx` | Reviewed. Adopted. Owns welcome artwork, choices and status; live readiness belongs to runtime. |
| `modules/source-onboarding.tsx` / Source onboarding | `SourceOnboarding` | `source-onboarding-products`, `source-onboarding-connection`, `source-onboarding-empty`, `source-onboarding-local`, `source-onboarding-address`, `source-onboarding-approval`, `source-onboarding-success` | surfaces/setup | `ui/components/AddControlSource.tsx` | Reviewed. Adopted. Owns product artwork and source-specific presentation; runtime owns catalog availability, connection approval, identities and submission. |
| `modules/connection-onboarding.tsx` / Connection onboarding | `ConnectionOperations` | `connection-operations` | Same-source ConnectionOnboarding | `ui/components/ToolPolicyField.tsx` | Reviewed. Adopted. Source preserves the representative operation preset/count; runtime owns the available operation set and selection. Tool lists use a retained in-dialog view with the owner breadcrumb and Back navigation; they do not add a modal layer. |
| `modules/connection-onboarding.tsx` / Connection onboarding | `ConnectionOnboarding` | `connection-onboarding-method`, `connection-onboarding-nested-method`, `connection-onboarding-relay`, `connection-onboarding-local`, `connection-onboarding-join`, `connection-onboarding-own`, `connection-onboarding-secure`, `connection-onboarding-ready`, `connection-onboarding-login` | surfaces/setup | `ui/components/AddConnection.tsx` | Reviewed. Adopted. Owns connection method/configuration/readiness presentation. Native installation, tunnel deployment, login and connection state belong to runtime. |
| `modules/connection-management.tsx` / Connection management | `ConnectionFacts` | `connection-facts`; connection-card compositions | Same-source ConnectionCard | `ui/components/ConnectionsContent.tsx` (connection-facts) | Reviewed. Adopted. Provider/method facts retain existing text and order. Runtime uses dl/dt/dd and places relay version with provider; design places version after both facts. Reconcile in implementation scope. |
| `modules/connection-management.tsx` / Connection management | `ConnectionCard` | `connection-card-relay`, `connection-card-tunnel` | Same-source ConnectionList; transitive surfaces/connections | `ui/components/ConnectionsContent.tsx` (Card/CardHeader/CardContent) | Reviewed. Adopted. Owns identity, attached source, address, actions and facts. Runtime owns live ingress/source data, offline/error states, edit/delete/leave behavior and relay settings. Design card has local presentation dimensions; runtime composes generic Card parts. |
| `modules/connection-management.tsx` / Connection management | `ConnectionList` | `connection-list`; surfaces/connections/overview | surfaces/connections | `ui/components/ConnectionsContent.tsx#ConnectionsContent` | Reviewed. Adopted. Representative relay and secure tunnel records stay in the owning fixture. Runtime filters pending/revoked/local sources and exposes error/removal/editor states outside the current declared design forms. |
| `modules/board.tsx` / Coordination Board | `BoardRow` | `board-row-attention`, `board-row-passive`, `board-row-long` | Same-source BoardSection | `ui/coordination/CoordinationCenter.tsx#RecordRow`; attentionRow and recordRow compositions | Reviewed. Adopted. Source preserves actionable/passive and long-title forms. Runtime owns button semantics, navigation, live status and record metadata. AX candidate rows remain Board records; AX detail stays with the AX module. |
| `modules/board.tsx` / Coordination Board | `BoardSection` | `board-section-attention`, `board-section-partial` | Same-source CoordinationBoard | `ui/coordination/CoordinationCenter.tsx#Section` | Reviewed. Adopted. Source owns grouped rows and observation coverage note. Runtime groups owner attention, active work and blockers, and derives counts/coverage from live projections. |
| `modules/board.tsx` / Coordination Board | `BoardFeedback` | `board-feedback-gap`, `board-feedback-unavailable` | Same-source CoordinationBoard | `ui/coordination/CoordinationCenter.tsx` (Current/Activity Notice compositions) | Reviewed. Adopted. Owns Board-specific recovery copy/layout. Runtime composes generic Notice; its spacing and action layout require implementation alignment. Cursor reset, retry, pending and retained coverage belong to runtime. |
| `modules/board.tsx` / Coordination Board | `BoardFilters` | `board-filters-current`, `board-filters-activity` | Same-source CoordinationBoard | `ui/coordination/CoordinationCenter.tsx` (center-filters) | Reviewed. Adopted. Preserves Current status/resource and Activity resource-only forms. Runtime owns dynamic resources, selection and busy behavior. |
| `modules/board.tsx` / Coordination Board | `CoordinationBoard` | surfaces/coordination/current, empty, gap, unavailable | surfaces/coordination | `ui/coordination/CoordinationCenter.tsx#CoordinationCenter` | Reviewed. Adopted. Owns Board navigation, filters, feedback, grouped records, empty and observed states. Surface declares region/captures. Native record details and Activity event timelines have no declared design form; retain current runtime until their source review. |
| `modules/ax.tsx` / AX | `AXStatusBadge` | `ax-status-badge-open`, `ax-status-badge-triaged`, `ax-status-badge-fixed`, `ax-status-badge-wontfix` | Same-source AXEntryRow and AXEntryDetail | `ui/coordination/AXPanel.tsx#Status` | Reviewed. Adopted. Source declares four statuses; runtime derives a broader status set from AX decisions. Runtime icon size is 14px; source preserves 13px. Reconcile status coverage and geometry in implementation scope. |
| `modules/ax.tsx` / AX | `AXEntryRow` | `ax-entry-row-open`, `ax-entry-row-triaged`, `ax-entry-row-fixed`, `ax-entry-row-wontfix` | Same-source AXBoard; transitive surfaces/coordination-ax | `ui/coordination/AXPanel.tsx` (ax-row) | Reviewed. Adopted. Preserves synthetic entry IDs, titles and metadata. Runtime owns short IDs, counts, source lookup, search/filtering, selection and accessible row associations. |
| `modules/ax.tsx` / AX | `AXEntryDetail` | `ax-entry-detail`; surfaces/coordination-ax/detail | Same-source AXBoard | `ui/coordination/AXPanel.tsx#detail` | Reviewed. Adopted. Owns facts, resolution, fixing commit, evidence and history presentation. Runtime owns native AX data, copy feedback/errors, merged/document decisions and focus restoration. |
| `modules/ax.tsx` / AX | `AXBoard` | surfaces/coordination-ax/open, closed, detail | surfaces/coordination-ax | `ui/coordination/AXPanel.tsx#AXPanel`; `ui/coordination/CoordinationCenter.tsx` shell | Reviewed. Adopted. Owns AX filters, list/detail composition and footer; the full-region surface owns captures. Loading, unavailable/not-found states and pagination behavior remain runtime concerns. Board attention references reuse AX meaning without owning AX detail. |
| `modules/mcp-service.tsx` / MCP service | `McpService` | `mcp-service-expanded`, `mcp-service-http-failed`, `mcp-service-command-failed`, `mcp-service-off` | Same-source composition; transitive surfaces/mcp-hub | `ui/mcp/McpHub.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/mcp-service.tsx` / MCP service | `McpHub` | Contained in module/surface compositions | `surfaces/mcp-hub` | `ui/mcp/McpHub.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/mcp-service.tsx` / MCP service | `McpFailure` | Contained in module/surface compositions | Same-source composition; transitive surfaces/mcp-hub | `ui/mcp/McpHub.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/mcp-service.tsx` / MCP service | `McpImportPrompt` | `mcp-import-prompt` | Same-source composition; transitive surfaces/mcp-hub | `ui/mcp/McpHub.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/connectors.tsx` / Connectors | `ConnectorCard` | `connector-card` | Same-source composition; transitive surfaces/platforms | `ui/components/objects/ConnectorCard.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/connectors.tsx` / Connectors | `ConnectorContent` | `connector-content-connected`, `connector-content-empty` | `surfaces/platforms` | `ui/components/PlatformsPage.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/general-settings.tsx` / General settings | `GeneralSettings` | `general-settings-content` | `surfaces/settings` | `ui/components/SettingsPage.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/general-settings.tsx` / General settings | `GeneralSettingsContent` | `general-settings-content` | Same-source composition; transitive surfaces/settings | `ui/components/SettingsPage.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/agent-settings.tsx` / Agent settings | `AgentInventoryCard` | `agent-inventory-card` | Same-source composition; transitive surfaces/settings | `ui/components/AgentsSettings.tsx#AgentCard` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/agent-settings.tsx` / Agent settings | `AgentDispatchSettings` | `agent-dispatch-settings` | Same-source composition; transitive surfaces/settings | `ui/components/AgentDispatchDefaults.tsx#AgentDispatchDefaults` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/agent-settings.tsx` / Agent settings | `AgentDetail` | Contained in module/surface compositions | `surfaces/settings` | `ui/components/AgentsSettings.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/agent-settings.tsx` / Agent settings | `Agents` | Contained in module/surface compositions | `surfaces/settings` | `ui/components/AgentsSettings.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/display-settings.tsx` / Display settings and theme swatches | `DisplayContent` | `display-content` | Same-source composition; transitive surfaces/settings | `ui/components/AgentDisplaySettings.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/display-settings.tsx` / Display settings and theme swatches | `Display` | `display-content` | `surfaces/settings` | `ui/components/AgentDisplaySettings.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/display-settings.tsx` / Display settings and theme swatches | `ThemeSwatch` | `theme-swatch` | `modules/general-settings` | `ui/components/SettingsPage.tsx` (theme-color choices) | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/experimental.tsx` / Experimental feature settings | `ExperimentalContent` | `experimental-content` | Same-source composition; transitive surfaces/settings | `ui/components/ExperimentalSettings.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/experimental.tsx` / Experimental feature settings | `Experimental` | `experimental-content` | `surfaces/settings` | `ui/components/ExperimentalSettings.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/pets.tsx` / Pet import and library | `PetImport` | `pet-import` | Same-source composition; transitive surfaces/pets-settings | `ui/pets/PetsPage.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/pets.tsx` / Pet import and library | `PetCard` | `pet-card-built-in`, `pet-card-removable` | Same-source composition; transitive surfaces/pets-settings | `ui/pets/PetsPage.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/pets.tsx` / Pet import and library | `PetsLibrary` | `pets-library` | `surfaces/pets-settings` | `ui/pets/PetsPage.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/updates.tsx` / Updates | `UpdateContent` | `update-content-available`, `update-content-downloading`, `update-content-download-failed`, `update-content-installing` | `surfaces/updates` | `ui/components/AppUpdate.tsx#PanelContents` | Reviewed and adopted. Grouped notes, download progress, retry and restart confirmation. Runtime owns the downloaded update and recovery. |
| `modules/updates.tsx` / Updates | `UpdateHistoryContent` | `update-history-content` | `surfaces/updates` | `ui/components/AppUpdate.tsx#UpdateHistory` | Reviewed and adopted. Read-only notes by version, linked from About. |
| `modules/updates.tsx` / Updates | `UpdateAboutContent` | `update-about-content` | `modules/general-settings`; `surfaces/updates` | `ui/components/SettingsPage.tsx`; `ui/components/AppUpdate.tsx` | Reviewed and adopted. Embedded About section with an update history entry. |
| `modules/relay-hosting.tsx` / Relay hosting | `RelayHostingContent` | Contained in module/surface compositions | `surfaces/relay-hosting` | `ui/components/RelayHosting.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/connectors.tsx` / Source connector summary | `SourceConnectorSummary` | `source-connector-summary` | `surfaces/source-panel` | `ui/components/SourcePlatformView.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/agent-settings.tsx` / Native Agent information | `NativeAgentInfo` | `native-agent-info` | `surfaces/agent-platform` | `ui/components/AgentPlatformView.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |
| `modules/homepage-topology.tsx` / Homepage topology composition | `TopologyScreen` | `landscape` | `surfaces/homepage-topology-tasks`, `surfaces/homepage-topology-empty`, `surfaces/homepage-topology-portrait`, `surfaces/homepage-topology-studio`, `surfaces/homepage-topology-accounts` | `ui/topology/Topology.tsx` | Reviewed. Adopted. Static declared presentation; runtime owns native data, interaction, validation and recovery. Remaining coverage and fidelity gaps are listed below. |

| `components/settings-row.tsx` / Shared settings | `SettingsChoices` | Settings module compositions | modules/general-settings, modules/agent-settings, modules/display-settings | `ui/components/ui/index.tsx#SingleChoice` | Reviewed. Adopted. Shared width/option adapter; runtime choice semantics and standalone part coverage remain implementation/design gaps. |
| `components/settings-row.tsx` / Shared settings | `SettingsGroup` | Settings module compositions | modules/general-settings, modules/agent-settings, modules/display-settings | `ui/components/ui/Settings.tsx#SettingsSection` | Reviewed. Adopted. Owns shared section/card composition; source h3 typography differs from runtime section headings. |
| `components/settings-row.tsx` / Shared settings | `SettingsToggleRows` | Settings module compositions | modules/general-settings, modules/experimental | `ui/components/ui/Settings.tsx#Setting`; `ui/components/ui/index.tsx#Switch` | Reviewed. Adopted. Representative static toggle rows; runtime owns native labels, interaction and persistence. |

### Button family support

`fixtures/buttons.ts` owns the five Button examples and two IconButton examples. Single-part frame names remain `primary`, `secondary`, `ghost`, `danger`, `pending`, `regular` and `compact`. The fixture is support data, outside gallery discovery. Components retain their named exports and all current import paths. No frame or capture references require a rename.

`tokens.css` adds shared `--control-height-compact`, `--control-gap` and `--control-icon-size` alongside `--control-height`. Button and IconButton reuse those values; explicit IconButton `size` remains a supported caller override. Runtime token adoption is pending implementation scope. `link`, `danger-outline`, disabled, active and agent presentations have callers or props but no separate declared family frames; coverage belongs to the owning future review with the current declared forms unchanged.

### Input family support

`fixtures/inputs.ts` owns the existing field values/errors, masked copy value, search placeholder and switch state examples. All five parts stay in their generic component sources and retain named exports and importer paths. `field.tsx` is multi-part: `field` and `field-error` own labeled compositions; `input` and `input-error` crop the same input content into independent part frames. Field and Input each own their default/error content under part-prefixed frame names. These component frames have no implementation captures; mapped surface frames declare the implementation fixture/capture targets.

Input and CopyField share `--field-padding-inline`; CopyField and Switch share `--control-inset`; SearchInput reuses `--control-gap`. Field/SearchInput icon dimensions use `--field-icon-size`; their numeric ADG Icon size remains 14 to preserve the toolkit's absolute stroke normalization. Field owns `--field-error-gap`. Switch owns its width, height, thumb size and radius tokens, and keeps a circular thumb with `rounded-full`. These values retain current geometry. Runtime token adoption and the source differences listed per part belong to implementation scope.

### Panel/card family support

`fixtures/panels.ts` owns the panel title/content and the two card specimens. Generic Panel, Dialog, PanelShell and PanelHeader remain in `components/panel.tsx`; generic Card and its five subparts remain in `components/card.tsx`. PermissionCard belongs to modules/request.tsx. Import paths and named exports remain stable. Surface fixtures/captures stay in the owning surfaces.

Panel and Card frames use part-prefixed names. PanelHeader is content-cropped from the panel presentation. Shell and card subpart frames use existing specimen content with unchanged part functions. Dialog has the same generic presentation as Panel; native modal behavior belongs to runtime Dialog. CardTitle, CardDescription and CardFooter remain retained without consumers, pending adoption/deletion review. This is a temporary lifecycle exception for the retained parts; resolve it when a real consumer is assigned or deletion is authorized.

### Choice family support

`fixtures/choices.ts` owns the theme, platform, tab and answer options, specimen labels/selections and generic SetupChoice row/product content. The platform option list is shared by SingleChoice's navigation specimen and `surfaces/platforms`. SingleChoice retains its five declared forms. SetupChoice is a single-part source with `row` and `product` frames. Named exports remain stable; surface captures remain with their owning surfaces.

SingleChoice and SetupChoice are generic presentation owners in `components/`. SetupAction belongs to modules/source-onboarding and imports generic SetupChoice. Tile is outside the choice family: SingleChoice/SetupChoice do not import it, and its phase/source-badge presentation belongs to task presentation alongside its generic icon tile. Tile remains in components with its task-presentation mapping. No additional token is required; dropdown gaps and segmented-control insets reuse shared control tokens, while local dimensions stay with the owning part.

### Generic feedback support

`fixtures/feedback.ts` owns the generic notice diagnostic, prompt text and tooltip label. Notice keeps its single-part `danger` frame; Tooltip and Prompt keep their single-part `default` frames. Named exports and import paths remain stable. RequestEntry and ReviewUnavailable belong to modules/request.tsx; fixtures/request owns their representative data.

Notice and Prompt are consumed by modules/mcp-service; Tooltip has no external design consumer. Runtime usage establishes adoption; keep them while their mapped callers remain. MCP failure and import prompts reuse Notice and Prompt through their stacked presentation; default generic frames stay unchanged. No part is deleted. The runtime uses below are direct JSX consumers of `ui/components/ui/index.tsx`; behavior and visual alignment remain pending their implementation scopes.

| Part | Runtime consumers |
| --- | --- |
| `Notice` | `ui/App.tsx`, `ui/components/AddConnection.tsx`, `ui/components/AddControlSource.tsx`, `ui/components/AgentConversations.tsx`, `ui/components/AgentDispatchDefaults.tsx`, `ui/components/AgentDisplaySettings.tsx`, `ui/components/AgentPanel.tsx`, `ui/components/AgentPlatformView.tsx`, `ui/components/AgentsSettings.tsx`, `ui/components/AppUpdate.tsx`, `ui/components/ChangeConnection.tsx`, `ui/components/ConnectionOverview.tsx`, `ui/components/ConnectionsContent.tsx`, `ui/components/IngressDialog.tsx`, `ui/components/IngressPanel.tsx`, `ui/components/OAuthApproval.tsx`, `ui/components/Onboarding.tsx`, `ui/components/PlatformsPage.tsx`, `ui/components/RelayHosting.tsx`, `ui/components/RelayProgress.tsx`, `ui/components/RelaySettings.tsx`, `ui/components/SourceDispatches.tsx`, `ui/components/ToolPolicyField.tsx`, `ui/components/objects/ConnectorCard.tsx`, `ui/coordination/AXPanel.tsx`, `ui/coordination/CoordinationCenter.tsx`, `ui/mcp/McpHub.tsx`, `ui/pets/PetPicker.tsx`, `ui/pets/PetsPage.tsx`, `ui/subscriptions/UsageOverview.tsx` |
| `Tooltip` | `ui/components/ActivityInteraction.tsx`, `ui/components/AppUpdate.tsx`, `ui/components/PermissionsPage.tsx`, `ui/components/ToolPolicyField.tsx`, `ui/topology/Hub.tsx` |
| `Prompt` | `ui/mcp/McpHub.tsx` |

### Brand icon family support

`fixtures/agent-icons.ts` owns the representative brand and quota-reading states. Single-ring frames cover consumption ahead of, behind, and even with time progress in both display modes. The single ring plots elapsed time in used mode and remaining time in remaining mode. An inset dashed arc joins the tick and the quota endpoint, using danger for consumption ahead of time and success for consumption behind time. Equal progress and unknown timing omit the dashed arc. BrandMark and AgentIcon remain in `components/agent-icon.tsx`. Frame names carry the owning part prefix. The BrandMark frame is the 38×38 mark contained in AgentIcon's 48×48 no-ring presentation. Registry artwork imports and computed arc geometry stay with the presentation source.

Runtime BrandMark is consumed by `ui/components/AgentsSettings.tsx`. Runtime AgentIcon is consumed by `ui/subscriptions/AgentQuotaIcon.tsx`, which supplies quota readings to the product's Agent presentation. Rendering fidelity and provider-data edge states remain in implementation scope. Artwork budgets and approval status follow below.

### Runtime token alignment

`ui/tokens.css` imports `design/tokens.css`, so design tokens are available to runtime CSS without duplicate declarations. Design entries without a corresponding runtime presentation usage remain pending runtime alignment. The shared Button/input dimensions requiring consumer alignment include `--control-height-compact`, `--control-gap`, `--control-icon-size`, `--field-padding-inline`, `--field-icon-size`, `--field-error-gap`, `--control-inset`, `--switch-width`, `--switch-height`, `--switch-thumb-size` and `--radius-switch`. Runtime component styles still use local dimensions for these roles. Alignment belongs to implementation scope.

### AX support

`modules/ax.tsx` owns AX status badges, entry rows, detail and list/detail composition. `fixtures/ax.ts` owns representative records, labels, evidence/history and declared form copy; its AXEntry import is type-only from the defining module. Status icon/tone presentation stays with the module. `surfaces/coordination-ax.tsx` owns the three full-region frames and their captures. All four declared status and row forms have cropped part frames; detail crops the existing complete detail content. Outer detail spacing belongs to AXBoard.

### Coordination Board support

`modules/board.tsx` owns BoardRow, BoardSection, BoardFeedback, BoardFilters and CoordinationBoard. `fixtures/board.ts` owns representative content, declared form metadata and recovery copy; its BoardForm and BoardGroupData type-only imports point to the defining module. `surfaces/coordination.tsx` declares the four complete regions and their captures. Board part frames crop the existing attention/passive/long rows, full/partial sections, recovery feedback and filters. Outer spacing belongs to the composition so cropped parts retain their content bounds.

Board records may reference tasks, connections, updates or AX candidates; their Board presentation stays with this module. AX entry/detail presentation stays with the AX owner. The homepage uses the shared HomepageBar. Runtime-only Board details and event rows remain implementation gaps, not new visual proposals.

### Connection management support

`modules/connection-management.tsx` owns connection cards, provider/method facts and their list. `fixtures/connection-management.ts` owns the representative records and copy; its ManagedConnection type-only import points to the defining module. `surfaces/connections.tsx` owns the complete L center workspace and its capture. Card and list frames crop that region; the facts frame offsets its existing negative outer margin without changing the part.

### Onboarding support

`modules/onboarding.tsx` owns the shared shell and fields; `modules/welcome.tsx` owns the initial choice; `modules/source-onboarding.tsx` owns product/source setup; `modules/connection-onboarding.tsx` owns connection setup. Their matching fixtures own representative state records, copy, values and options. Product artwork lookup stays with the source module. The shared module defines OnboardingStep; fixtures import its type only.

`surfaces/setup.tsx` assembles the modules and owns the 18 complete forms and their fixture/capture declarations. Cropped part frames use the existing content. The shared shell's child slot keeps business conditions with their source or connection owner. Welcome choices retain the parent grid's stretched height. SetupAction is source-specific; generic SetupChoice remains independent.

### Homepage Tasks mode

**User-approved and adopted.** HomepageBar uses one row in both modes: clock and
Board on the left, the persisted mode selector centered, and Tasks view controls on
the right. Compact widths omit the date. Node task-state activation selects Tasks
with a transient clearable scope and focuses its matching tasks.

| Source / part | Declared forms | Consumer / intended runtime owner | Status |
| --- | --- | --- | --- |
| `modules/homepage-mode.tsx` / HomepageModeSwitch | `mode-switch-topology`, `mode-switch-tasks` | `ui/display/Studio.tsx`; `ui/state/homepage.ts` | User-approved and adopted. Manual two-choice selector without a needs-me badge. |
| `modules/homepage-mode.tsx` / HomepageBar | `homepage-bar-topology`, `homepage-bar-tasks`, `homepage-bar-tasks-compact` | `ui/display/Studio.tsx`; TopologyScreen; Tasks switcher surfaces | User-approved and adopted in both modes. One row below the native drag strip with the existing Board entry and compact date omission. The topology viewport gives the freed height to both solvers. |
| `modules/tasks.tsx` / OriginChain | `origin-chain-{local,remote,member,offline}` | `ui/components/ui/TaskSnapshot.tsx` | User-approved and adopted. Source → optional remote device → Agent → account. Each icon retains its full accessible identity. |
| `modules/tasks.tsx` / NodeTaskFilter | `node-task-filter` | `ui/components/HomepageTasks.tsx` | User-approved and adopted. Clearable node scope with keyboard focus. |
| `modules/tasks.tsx` / TasksEmpty | `tasks-empty` | `ui/components/HomepageTasks.tsx` | User-approved and adopted. Empty task or filter state. |
| `modules/tasks.tsx` / TaskSnapshot, TaskStatusMark | `task-snapshot-{waiting-input,waiting-approval,running,unread,unconfirmed,narrow}`, `task-status-mark-{waiting-input,waiting-approval,running,unread,unconfirmed}` | `ui/components/ui/TaskSnapshot.tsx` | User-approved and adopted. Status mark above each portrait snapshot; no request actions or attention borders. Origin, title, project/path and newest-anchored bounded timeline precede routing state, plan, latest change or mark read. Runtime rows use native observations; remote snapshots retain available metadata. |
| `modules/tasks.tsx` / TaskViewControls | `task-view-controls`, `task-view-controls-compact` | `ui/components/TaskViewControls.tsx` in HomepageBar | User-approved and adopted. Counted status filter as SingleChoice dropdown, omitted on mobile; icon-only Tile/Stack SingleChoice with persisted layout. |
| `modules/tasks.tsx` / TaskTiles, TaskStack | Composed switcher forms below | `ui/components/HomepageTasks.tsx`; `ui/components/TaskStack.tsx` | User-approved and adopted. Tile uses 6/5/2 fixed columns. Stack fills the remaining page height and recedes left with interpolated spacing, scale, canvas fog and left-cast shadows. A viewport-bounded moving window renders five nearby details and fogged placeholders farther back; preview reads follow mounted details. Navigation floats without reserving a bottom row. Status marks remain on strips, with text when space permits. Pointer/touch follows 1:1 and settles with velocity. Both wheel axes and arrow keys browse; passed cards spread full size to the right. The `task-stack-browsed` frame owns that state. Click/Enter opens. Snapshot morphs to the centered task layer and back to its current position; reduced motion is instant. |
| `surfaces/homepage-tasks.tsx` / switcher | `switcher-tile-wide`, `switcher-tile`, `switcher-stack`, `switcher-tile-portrait`, `switcher-stack-portrait`, `switcher-tile-mobile`, `switcher-stack-mobile` | `ui/components/HomepageTasks.tsx`; `homepage-switcher-{tile,stack}` fixtures | User-approved and adopted. Replaces grouped TasksList and TaskCard forms. Existing group and observation ordering remains. Each frame declares its fixture and page capture. |
| `fixtures/tasks.ts`, `fixtures/homepage-mode.ts` | Support data | Tasks and mode parts | User-approved. Fictional identities, prompts, snapshot histories and routing copy. |

Runtime mapping uses `ui/state/taskProjection.ts` for bounded timeline summaries and
`ui/state/activityModel.ts` for groups and node aggregates. `ui/components/HomepageTasks.tsx`
owns the switcher, transient scope, focus and existing ordering. Shared TaskSnapshot and
NodeCapsule live in `ui/components/ui/`. The `homepage-modes-*` browser family covers
both modes, responsive layouts, manual persistence, capsule focus, completion read
and device management in both themes. Remote cards join the controller-scoped `device/tasks` activity and bounded records.
Remote task snapshots are validated at the read boundary. Failed or malformed reads
retain that device's last observation as unconfirmed and expose its error in the
device panel. Remote elapsed time ends at the snapshot's observation timestamp.
Native visibility determines the remote task scope. Local cards use the current
Agent activity and existing task records. Partial timeline coverage remains explicit.

`modules/task-activity.tsx` owns TaskActivityIcon, TaskLiveTimeline, TaskPlanProgress
and TaskChangeSummary. Frames are `task-live-timeline-{wide,standard}`,
`task-plan-progress`, and `task-change-summary`. `fixtures/task-activity.ts` owns
fictional steps, plan and diff content. Both node capsules and task cards reuse the same
activity-icon owner. These parts are user-approved and consumed by Tasks and topology.
The recorded-field mapping is documented in `design.md`.

### Retired task topology consumers

Retained historical sources have no active homepage task-layout consumer. No shim or task overlay
is part of the new model. Shared primitives, native transcripts, task detail and queued
messages inside a conversation retain their owners.

| Existing source / forms | Retirement scope | Replacement / retained use |
| --- | --- | --- |
| `modules/task-presentation.tsx` / TaskBubble `task-bubble-{compact,standard,detailed,row,row-attention}` | Retired from homepage; retained for history rows | TaskSnapshot and OriginChain own homepage task presentation. Retain current Agent/history consumers; TaskRow, StatePill and TaskMessage remain shared parts. |
| `surfaces/homepage-topology-tasks.tsx` / `tasks`; `homepage-topology-studio.tsx` / `studio` | Retired runtime task tentacles and task-dependent full-page arrangements | Static device topology plus Tasks mode. |
| `surfaces/homepage-topology-accounts.tsx` / `accounts`, `dense` | Retained node/account grouping and animated topology | Retain TopologyGroup and configuration account/profile nesting. Activity cannot drive compaction; capsule width participates in horizontal fitting. |
| `surfaces/homepage-topology-portrait.tsx` / `expanded-single-task`, `expanded-two-tasks`, `sources-compacted`, `tasks-and-accounts` | Portrait solver/painter retained; task slots and queues removed | Portrait rails, node groups, device trees and Tasks cards. Configuration-only node/group forms remain retained. |
| `surfaces/homepage-topology-mobile.tsx` / `narrow-two-tasks` | Retired runtime task-connected mobile canvas | `surfaces/homepage-tasks.tsx` / `mobile`. |
| `surfaces/agent-panel.tsx` / task-bearing and centered task-overview forms; `modules/agent-activity.tsx`, `modules/source-activity.tsx` / homepage activity projections | Retired runtime focus-to-expand homepage task overlays and task queues | Tasks mode owns primary task access. Retain management, quota, native history and source/account parts until their consuming surface migration. |

There is no separate approved queue-only source. Queue and compaction ownership is
embedded in the task-bearing topology compositions above. Retiring those usages does
not retire conversation-level queued messages or structural account-group folding.

### Device level in homepage topology

**User-approved.** The homepage retains its left control-source
and right executor dimensions. A paired member is a tier-1 sibling of local Agents.
Its Agents and accounts/profiles form successive child levels. Exactly one Agent
merges into its device node; expansion continues with accounts/profiles.
Local Agents retain their current position without a local-device wrapper.

| Source / part | Declared forms | Consumer / intended implementation | Status |
| --- | --- | --- | --- |
| `modules/device-topology.tsx` / DeviceNode, DeviceBranch | `device-branch-{idle,lan,tunnel,offline,merged-collapsed,merged-expanded}` | `surfaces/device-link-topology.tsx`; `ui/topology/Topology.tsx` | User-approved. Reuses TopologyNode at its existing 48px graphic size, TopologyGroup; task content is represented only by NodeCapsule. Device glyph and merged Agent badge extend the node language. Reachability stays in the device panel. Offline fades the complete branch. |
| `modules/device-topology.tsx` / DeviceNodePanel | `device-node-panel-{lan,tunnel,offline}` | `surfaces/device-link-topology.tsx` / `device-panel`; `ui/devices/DeviceNodePanel.tsx` | User-approved. Reuses PanelShell, PanelHeader, Field/Input and Button for pairing state, LAN/Tunnel path, latency, last seen/error, address/override, transfer and unpair. |
| `modules/device-topology.tsx` / ControllerSourcePanel | `controller-source-panel-{off,on}` | `surfaces/device-link-topology.tsx` / `member-upstreams-{off,on}`; `ui/components/SettingsPage.tsx`; `ui/devices/DeviceNodePanel.tsx` | User-approved. Show upstream control sources defaults off; the shared Switch lives in the controller node panel. Manage device opens its management content using the existing nested-panel pattern. |
| `modules/device-topology.tsx` / PortraitDeviceBranch | Composed in `controller-portrait{,-idle,-offline,-accounts}`, `controller-mobile{,-idle,-overflow,-offline,-branch,-accounts}` | `surfaces/device-link-topology.tsx`; `ui/topology/Topology.tsx` | User-approved. Remote account/profile levels fold with TopologyGroup. Fixed compact columns retain node labels; horizontal pan reveals branch and account tiers. |
| `surfaces/device-link-topology.tsx` | `controller-idle`, `controller-overflow`, `controller-lan`, `controller-tunnel`, `controller-offline`, `merged-collapsed`, `merged-expanded`, `member-upstreams-off`, `member-upstreams-on`, `device-panel`, `controller-portrait{,-idle,-offline,-accounts}`, `controller-mobile{,-idle,-overflow,-offline,-branch,-accounts}` | `ui/topology/Topology.tsx` | User-approved. Landscape 1280×800; portrait 640×800; mobile 390×844. Both themes use existing tokens. |
| `fixtures/device-topology.ts` | Support data | Device topology parts and surface | User-approved. Fictional devices, accounts, tasks and inert example endpoints; visual types remain in their owning modules. |

Device status appears only on device nodes and their expanded management content. The
controller task-state aggregation includes only tasks it dispatched to that member. A member attributes such
tasks directly to its controller source, including when upstream sources are shown.
No device nav entry or summary chip is present in the proposed compositions. A member
may control further devices; each homepage renders one hop, without protocol forwarding.
The architecture proposal is in `arch/mechanisms/device-link.*`, `device-forward.*`
and `arch/system-map.*`.

Runtime adoption retains the topology solver, automatic/manual orientation, portrait solver and painter, node group/fold planner, earcup actions and scene animator. Landscape uses the original grown-wire and tentacle geometry. Capsules provide node extents and retain their logo ports. Task observations populate capsules and Tasks cards without adding task slots or task-driven compaction. The topology and Tasks scroll areas reserve the header, mode switch and navigation capsule.
The device node panel replaces the separate Devices workspace and summary. Pairing,
address and revoke dialogs retain their shared shells. Native management currently
exposes paired devices, paths and reachability. Remote Agent tiers and single-Agent merge use `availableAgents`. The native
`controller.showUpstreamSources` setting controls `controller.upstreamSources`.
Remote account/quota inventory, remote timeline/response forwarding and transfer UI
remain limited by the available management reads. Native addressing and cycle semantics belong
to the device-tier owner.

`modules/node-capsule.tsx` owns NodeCapsule and its shared outer-port geometry:
`idle`, `working`, `attention`, `unread`, `aggregate`, `thinking-waiting`, `overflow`,
`left-idle`, `left-working`, `compact`, `compact-overflow`, `unconfirmed`,
`compact-unconfirmed`, `left-source-attention`, and `account-contrast`. `fixtures/node-capsule.ts` owns fictional
counts, observed phases and quota readings. All node capsule forms are **User-approved**.

The quota ring is the capsule outline: the idle circle stretches into a 48px stadium
whose quota arcs keep their fractional meaning; the pace trace stays on the idle ring.
Items are 22px discs on a 28px step, concentric with the caps: the needs-me count as a
solid warning disc (the only number), one phase disc per running task tinted with the
phase tokens, and a three-dot overflow disc. Completed unread remains visible in Tasks and panels. Unconfirmed uses a dashed neutral outline,
a help disc and a dimmed logo. The account capsule remains 40px with a 1px border,
brand marks and a count.

The maximum width is 188px landscape (five items) and 104px compact (two items),
included in solver node extents. Only owning leaves morph into capsules. Configuration parents retain their normal nodes and child brackets. Outgoing wires share the computed capsule
width and start at its actual outer edge. Incoming ports and branch rails stay fixed.

Idle/working full compositions and narrow viewport pairs expose stable anchors.
Portrait/mobile retain labels and use explicit horizontal pan to reveal deeper
columns; header/navigation remain fixed. Pan is independent of task state.
Management panel disclosure folds the device's child branch to reserve panel space.

Runtime capsules split logo and task activation, retain keyboard node ordering,
and share width, reveal and outgoing ports through the 210/26 spring with 8ms
substeps. Reduced motion applies endpoints directly and disables the pulse.
`homepage-modes-*` fixtures own capsule, filter, pan and device interactions.

Device nodes use the retained topology engine. Configuration and attention determine grouping; capsule extents participate in horizontal fitting.
Task bubbles, queues, task-only arcs and task focus overlays are absent. Node positions
follow configuration and explicit structural disclosure within a fixed viewport.

### Retained Device link management parts

**Approved. Adopted.** `modules/device-link.tsx` owns DeviceExperiment,
DeviceMemberRow, DeviceStatus, DeviceFingerprint, DeviceDetail, DevicePairDialog,
DeviceAddressDialog, DeviceRevokeDialog and DeviceMemberView.
`fixtures/device-link.ts` owns fictional names, fingerprints, LAN endpoints, pairing content,
countdowns, errors and English / Simplified Chinese copy. Each declared state has `-en` and
`-zh-CN` forms; themes come from tokens. No real environment data is used.

| Parts / source | Declared forms | Consumer / intended runtime mapping | Status |
| --- | --- | --- | --- |
| DeviceExperiment | `device-experiment-{off,on}-{locale}` | Experimental settings row; `ui/components/ExperimentalSettings.tsx` | Approved. Reuses Card, SettingLine and Switch; no embedded actions. |
| DevicePairDialog | `device-pair-{input,waiting,success,invalid,expired,protocol,declined,unreachable}-{locale}` | `ui/devices/DeviceNodePanel.tsx` | Approved. Reuses the M Dialog with fixed actions, Field/Input, Notice and Button. Waiting retains the initiating action, controller fingerprint and original offer deadline. |
| DeviceAddressDialog / DeviceRevokeDialog | `device-address-{locale}`, `device-revoke-{member,controller}-{locale}` | `ui/devices/DeviceNodePanel.tsx` | Approved. Both use the M Dialog with fixed actions. Override supports save and clear. Both revocation directions confirm immediate loss of access while preserving running work. |
| DeviceMemberRow / DeviceStatus / DeviceFingerprint / DeviceDetail | In `surfaces/devices`: `controller`, `detail-mac`, `detail-windows`, `detail-linux` | `ui/devices/DeviceNodePanel.tsx` | Approved. Online/offline, LAN/tunnel, latency, last seen, full fingerprint, platform/arch, ARC version, capabilities and addresses. Windows/Linux omit screen capability and show its absence. Offline path is explicitly historical; unavailable latency is omitted. |

`ui/devices/DeviceNodePanel.tsx` owns device detail, member pairing offers,
approval, address override and revocation. The retired Devices workspace, its navigation
entry, summary chip and their design frames have been removed. The retained
`modules/device-link.tsx` owns pairing/address/revoke forms and shared device facts.

## Surface mappings and declared frames

Surfaces with mapped implementation usage are **adopted**. Declared compositions are **Reviewed** unless marked Proposed. The implementation column names its current owner. TSX `fixture` and `capture` props own exact scenario names, viewports, selectors and preparation clicks; the adapter details follow this table. A mapped capture remains unverified until its assigned implementation review. The two unreachable legacy forms are retained exceptions under Known gaps; their other forms remain adopted.

| Source | Declared frames | Implementation owner | Remaining gap / capture notes |
| --- | --- | --- | --- |
| `surfaces/layers.tsx` | `workspace-fit`, `workspace-cap`, `workspace-dialog`, `node-panel`, `portrait-workspace` | `ui/App.tsx`, `ui/components/ui/Panel.tsx`, `ui/topology/Topology.tsx`, `ui/state/layers.ts`, `ui/components/ui/layerFrame.ts` | Reviewed (user-approved). Slot-owned XL/M widths and always-centered geometry match the accepted runtime. First-level panels have no scrim; only the nested M dialog adds one. Entry and exit fade only. Relay hosting uses its real empty content for content-fit height and portrait. Full Settings reaches the height cap with a fixed header and scrolling body, including beneath the confirmation dialog. Workspace scenes hide the Board header. The node scene keeps the underlying topology geometry while the centered panel overlays it. Panels add no secondary tentacle. Dialog slot geometry and dismissal footers are adopted. Workspace center slots and M node slots are adopted. Node surface captures use the panel region; the layer-slot reference and browser bounds checks own viewport placement. |
| `surfaces/agent-panel.tsx` | `empty`, `overview`, `short`, `loading`, `centered-landscape`, `centered-portrait` | `ui/components/AgentPanel.tsx` | Reviewed and adopted. Overview height follows content, with a fixed header and scrolling body at the cap. All six frames capture the fixed M panel region. The legacy centered frame names retain landscape and collapsed-portrait coverage; placement belongs to the layer-slot source and acceptance bounds checks. |
| `surfaces/agent-platform.tsx` | `accounts`, `single-account`, `empty`, `loading`, `native` | `ui/components/AgentPlatformView.tsx` | Reviewed and adopted. The account overview fits its content, and the account list scrolls at the viewport cap. The loading frame has a dedicated browser fixture. The native specimen remains unreachable through the current fixture route. |
| `surfaces/homepage-tasks.tsx` | `wide-landscape`, `standard-landscape`, `empty`, `focused-node`, `member-origin`, `portrait`, `portrait-expanded`, `mobile`, `mobile-expanded` | Intended homepage content owner | User-approved. `homepage-modes-*` browser fixtures cover the local feed and responsive forms. |
| `surfaces/device-link-topology.tsx` | Forms listed above | `ui/topology/Topology.tsx` | User-approved. Device nodes and management are adopted within current native field coverage. |
| `surfaces/connections.tsx` | `overview` | `ui/components/ConnectionsContent.tsx` | Reviewed. Composes modules/connection-management. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/coordination-ax.tsx` | `closed`, `detail`, `open` | `ui/coordination/AXPanel.tsx` | Reviewed. Composes modules/ax. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/coordination.tsx` | `current`, `empty`, `gap`, `unavailable` | `ui/coordination/CoordinationCenter.tsx` | Reviewed. Composes modules/board. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/homepage-topology-accounts.tsx` | `accounts`, `dense` | `ui/topology/Topology.tsx` | `accounts` and `dense` reviewed. `dense` uses `topology-accounts-dense` with page capture at origin `0 0`, viewport `1280x800`; runtime acceptance pending. Composes the discoverable topology modules and fixtures; declared viewport and capture metadata remain with this surface. Runtime layout solving and transitions retain their mapped owner. |
| `surfaces/homepage-topology-empty.tsx` | `empty` | `ui/topology/Topology.tsx` | Reviewed. Composes the discoverable topology modules and fixtures; declared viewport and capture metadata remain with this surface. Runtime layout solving and transitions retain their mapped owner. |
| `surfaces/homepage-topology-mobile.tsx` | `narrow-two-tasks` | `ui/topology/Topology.tsx` | Reviewed. Composes the discoverable topology modules and fixtures; declared viewport and capture metadata remain with this surface. Runtime layout solving and transitions retain their mapped owner. |
| `surfaces/homepage-topology-portrait.tsx` | `agents-folded`, `expanded-empty`, `expanded-single-task`, `expanded-two-tasks`, `sources-compacted`, `sources-folded`, `tasks-and-accounts` | `ui/topology/Topology.tsx` | Reviewed and Adopted. The outer rails omit visible node and group names. The `640x1000` `tasks-and-accounts` form connects two tasks to a Codex account and shows folded sibling capsules using the shared TopologyGroup. The `portrait-topology-accounts` fixture captures it at origin `0 0`. Runtime layout solving and transitions retain their mapped owner. |
| `surfaces/homepage-topology-studio.tsx` | `studio` | `ui/topology/Topology.tsx` | Reviewed. Composes the discoverable topology modules and fixtures; declared viewport and capture metadata remain with this surface. Runtime layout solving and transitions retain their mapped owner. |
| `surfaces/homepage-topology-tasks.tsx` | `tasks` | `ui/topology/Topology.tsx` | Reviewed. Composes the discoverable topology modules and fixtures; declared viewport and capture metadata remain with this surface. Runtime layout solving and transitions retain their mapped owner. |
| `surfaces/mcp-hub.tsx` | `empty`, `failed`, `ready` | `ui/mcp/McpHub.tsx` | Reviewed. Composes modules/mcp-service. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/pets-settings.tsx` | `library` | `ui/pets/PetsPage.tsx` | Reviewed. Composes modules/pets. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/platforms.tsx` | `connected`, `empty` | `ui/components/PlatformsPage.tsx` | Reviewed. Composes modules/connectors. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/quota-overview.tsx` | `empty`, `overview` | `ui/subscriptions/UsageOverview.tsx` | Reviewed and adopted. The populated frame uses the same quota cards as the Agent panels. |
| `surfaces/relay-hosting.tsx` | `empty` | `ui/components/RelaySettings.tsx` | Reviewed. Composes modules/relay-hosting. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/settings.tsx` | `about`, `agent-detail`, `agents`, `display`, `experimental` | `ui/components/SettingsPage.tsx`; `ui/components/AgentsSettings.tsx`; `ui/components/AgentDisplaySettings.tsx`; `ui/components/ExperimentalSettings.tsx` | Reviewed. Composes modules/agent-settings, modules/display-settings, modules/experimental, modules/general-settings. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/setup.tsx` | `method`, `ready`, `relay-login`, `source-address`, `source-approval`, `source-connection`, `source-empty`, `source-local`, `source-product`, `source-success`, `stacked-join`, `stacked-local`, `stacked-method`, `stacked-own`, `stacked-ready`, `stacked-relay`, `stacked-secure`, `welcome` | `ui/components/SetupDialog.tsx`; `ui/components/AddConnection.tsx`; `ui/components/AddControlSource.tsx`; `ui/components/Onboarding.tsx` | Reviewed. Composes modules/connection-onboarding, modules/onboarding, modules/source-onboarding, modules/welcome. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/source-panel.tsx` | `dispatches`, `history`, `platform`, `loading` | `ui/components/SourcePanel.tsx`; `ui/components/SourcePlatformView.tsx` | Reviewed and adopted. Dispatch and connector overviews fit their content and scroll at the viewport cap. The dispatch loading frame has a dedicated browser fixture. |
| `surfaces/task-relationships.tsx` | `family` | `ui/components/ActivityBubbles.tsx`; `ui/components/ActivityTimeline.tsx` | Reviewed. Composes modules/task-relationships. Full-region forms and captures are declared in this surface. Runtime fidelity and missing-state gaps remain listed below. |
| `surfaces/task-detail.tsx` | `relay-running`, `relay-needs-you`, `relay-done`, `relay-failed` | `ui/components/ActivityTimeline.tsx` | User-approved. Adopted. Composes modules/timeline; each relay frame binds its accept:ui fixture and panel capture. |
| `surfaces/updates.tsx` | `available`, `downloading`, `download-failed`, `installing`, `history`, `settings` | `ui/components/AppUpdate.tsx`; `ui/components/SettingsPage.tsx` | Reviewed and adopted. Each form has a browser fixture. Settings capture targets the embedded About section. |

## Supporting assets and exceptions

| Asset | Owner / current state | Remaining work |
| --- | --- | --- |
| `tokens.css` | Shared design values; adopted by every source; Button and input dimensions Reviewed | Runtime adoption stays in implementation scope. |
| `fixtures/buttons.ts` | Button family; support data; Reviewed | Other representative data is owned by its defining family/module fixture. |
| `fixtures/inputs.ts` | Input family; support data; Reviewed | Surface-specific sample content stays with its owning feature migration. |
| `fixtures/panels.ts` | Panel/card family; support data; Reviewed | PermissionCard sample content belongs to fixtures/request. |
| `fixtures/choices.ts` | Choice family; support data; Reviewed | Setup-specific state records stay in the onboarding scope. |
| `fixtures/feedback.ts` | Generic feedback; support data; Reviewed | RequestEntry and ReviewUnavailable content belongs to fixtures/request. |
| `fixtures/mcp-service.ts` | MCP service; support data; Reviewed | Representative declared content and state; native data stays outside design fixtures. |
| `fixtures/connectors.ts` | Connectors; support data; Reviewed | Representative declared content and state; native data stays outside design fixtures. |
| `fixtures/general-settings.ts` | General settings; support data; Reviewed | Representative declared content and state; native data stays outside design fixtures. |
| `fixtures/agent-settings.ts` | Agent settings; support data; Reviewed | Representative declared content and state; native data stays outside design fixtures. |
| `fixtures/display-settings.ts` | Display settings and theme swatches; support data; Reviewed | Representative declared content and state; native data stays outside design fixtures. |
| `fixtures/device-link.ts` | Device link; synthetic data; Approved | English / Simplified Chinese states, fictional identities and addresses. |
| `fixtures/experimental.ts` | Experimental feature settings; support data; Reviewed | Representative declared content and state; native data stays outside design fixtures. |
| `fixtures/pets.ts` | Pet import and library; support data; Reviewed | Representative declared content and state; native data stays outside design fixtures. |
| `fixtures/updates.ts` | Updates; support data; Reviewed | Representative release notes and download state. |
| `fixtures/relay-hosting.ts` | Relay hosting; support data; Reviewed | Representative declared content and state; native data stays outside design fixtures. |
| `fixtures/topology.ts` | Homepage topology; support data; Reviewed | Representative scene geometry, content and part examples; visual types belong to their defining modules. |
| `fixtures/topology-mobile.ts` | Homepage topology; support data; Reviewed | Representative scene geometry, content and part examples; visual types belong to their defining modules. |
| `fixtures/nav-capsule.ts` | Homepage topology; support data; Reviewed | Representative scene geometry, content and part examples; visual types belong to their defining modules. |
| `fixtures/topology-mark.ts` | Homepage topology; support data | Accessible mark labels and representative ARC recovery content. |
| `fixtures/topology-group.ts` | Homepage topology; support data; Proposed | Representative folded-group members and declared group forms; visual types belong to `modules/topology-group`. |
| `fixtures/topology-node.ts` | Homepage topology; support data; Reviewed | Representative scene geometry, content and part examples; visual types belong to their defining modules. |
| `fixtures/topology-scene.ts` | Homepage topology; support data; Reviewed | Representative scene geometry, content and part examples; visual types belong to their defining modules. |
| `fixtures/tags.ts` | Generic labels; support data; Reviewed | Declared Tag and Disclosure specimen labels. |
| `fixtures/tiles.ts` | Generic tiles; support data; Reviewed | Declared card/phase tile specimens. |
| `fixtures/settings-controls.ts` | Shared settings; support data; Reviewed | Representative generic setting-row content. |
| `fixtures/ax.ts` | AX; support data; Reviewed | Synthetic entries, status labels, detail evidence/history and capture copy; AXEntry is defined by the module. |
| `fixtures/board.ts` | Coordination Board; support data; Reviewed | Representative groups, records, filters, recovery copy and full-frame metadata; types point to the defining Board module. |
| `fixtures/connection-management.ts` | Connection management; support data; Reviewed | Representative ingress, attached-source, provider/method and version content; native identities stay outside fixtures. |
| `fixtures/onboarding.ts` | Shared onboarding; support data; Reviewed | Declared steps, captures, shared method options and shell copy; no native identities. |
| `fixtures/welcome.ts` | Welcome; support data; Reviewed | Representative choices and ready status; native readiness stays outside fixtures. |
| `fixtures/source-onboarding.ts` | Source onboarding; support data; Reviewed | Representative catalog labels, source steps and field values; product availability belongs to runtime. |
| `fixtures/connection-onboarding.ts` | Connection onboarding; support data; Reviewed | Representative connection, operation and deployment states; live credentials stay outside fixtures. |
| `fixtures/timeline.ts` | Relay timeline; support data; User-approved; Adopted | Reuses task-presentation prompt and dispatch specimens; native session content stays outside fixtures. Relay parties, steps, plan, reply and failure copy are fictional. |
| `fixtures/request.ts` | Task requests; support data; Reviewed | Native request identities and live routing state stay outside design fixtures. |
| `fixtures/task-relationships.ts` | Task relationships; support data; Reviewed | The defining module owns RelationTask; the fixture imports its type only. Native session identities stay outside design fixtures. |
| `fixtures/task-presentation.ts` | Task presentation; support data; Reviewed | Static bubble, message, state and row specimens. |
| `fixtures/agent-activity.ts` | Agent activity; row support data; Reviewed | Remaining Agent panel content stays with its owning scope. |
| `fixtures/source-activity.ts` | Source activity; row support data; Reviewed | Platform facts remain in their owning composition. |
| `fixtures/quota.ts` | Quota module; support data; Reviewed | Runtime provider readings remain outside design fixtures. |
| `fixtures/model-configuration.ts` | Model configuration; support data; Reviewed | Runtime model catalogs remain outside design fixtures. |
| `fixtures/agent-icons.ts` | Brand icon family; support data; Reviewed | Runtime provider readings stay outside design fixtures. |

There are no deliberate import-lint opt-outs. Retained lifecycle and coverage exceptions are assigned to the owners above. No orphan is deleted before tracing mapped runtime and transitive consumers. Parts retained without consumers remain explicit lifecycle exceptions until adoption or deletion is authorized.

## Image dimensions and budgets

Budgets apply per file in `art/`. Owners downscale raster images before importing them. Brand SVGs may preserve their internal coordinates; display size belongs to the consuming part. These are maintenance limits, not additional presentation forms.

| Class / owner | Files | Display dimensions (CSS px) | Per-file budget | Current gap |
| --- | --- | --- | --- | --- |
| Brand registry / brand icon family | Registry SVGs listed below | BrandMark: 40×40 default; callers use 9, 20, 22, 24, 28, 36 and 38px squares. AgentIcon: 48×48 default; inner mark is round(outer size × 28/48) with rings or × 38/48 without rings. | 12 KiB SVG | Runtime markup mapping and provider states remain in implementation scope. |
| Catalog logos / onboarding | Gemini, Grok, Microsoft Copilot, GitHub Copilot and Qwen Code SVGs | 24×24 | 12 KiB SVG | Onboarding owns their surrounding presentation. |
| Source badge / task presentation, timeline and connection management | `source.svg` | 9×9 inside a 13×13 badge; 12×12 in the timeline source chip; 18×18 in connection identity; 24×24 in the source connector summary | 2 KiB SVG | Connection identity uses the same source artwork; runtime provider mapping remains in implementation scope. |
| Homepage ARC / topology | `arc-mark.svg` | 240×240 default drawing in TopologyMark, scaled by its size | 2 KiB SVG | Reviewed topology artwork. Faults recolor the affected arcs while preserving their geometry and the node fills. |
| Setup ARC / welcome | `setup-arc.svg` | 64×64 | 2 KiB SVG | Welcome owns its surrounding presentation; module is Reviewed. |
| Pet previews / pets | `pet-clawd.svg`, `pet-codex.svg`, `pet-synthetic1.svg`, `pet-synthetic2.svg`, `pet-synthetic3.svg` | 72×72; intrinsic viewBox 192×192 | 4 KiB SVG | Review with pets module. |
| Grok Bot / connection onboarding | `grok-bot.png` | 24×24; raster 48×48 for 2× density | 8 KiB PNG | Reviewed and User-approved. 3,996 bytes; within budget. |

### Artwork inventory

Each file inherits its display rule and per-file budget from its class above. Intrinsic dimensions below are SVG viewBox coordinates or raster pixel dimensions, not display dimensions. Review status is tracked in the class table.

| File in `art/` | Class | Committed bytes | Intrinsic viewBox / raster |
| --- | --- | --- | --- |
| `alibaba.svg` | Brand registry | 1,352 | `0 0 24 24` |
| `anthropic.svg` | Brand registry | 271 | `0 0 24 24` |
| `antigravity.svg` | Brand registry | 8,282 | `0 0 24 24` |
| `arc-mark.svg` | Homepage ARC | 688 | `4 4 92 92` |
| `claude-code.svg` | Brand registry | 380 | `0 0 24 24` |
| `claude.svg` | Brand registry | 1,643 | `0 0 24 24` |
| `codex.svg` | Brand registry | 1,754 | `0 0 24 24` |
| `cursor.svg` | Brand registry | 453 | `0 0 24 24` |
| `deepseek.svg` | Brand registry | 2,111 | `0 0 24 24` |
| `gemini.svg` | Catalog logos | 2,842 | `0 0 24 24` |
| `github-copilot.svg` | Catalog logos | 1,933 | `0 0 24 24` |
| `google.svg` | Brand registry | 866 | `0 0 24 24` |
| `grok-bot.png` | Grok Bot | 3,996 | `48×48` |
| `grok.svg` | Catalog logos | 679 | `0 0 24 24` |
| `microsoft-copilot.svg` | Catalog logos | 3,731 | `0 0 24 24` |
| `microsoft.svg` | Brand registry | 346 | `0 0 24 24` |
| `notion.svg` | Brand registry | 1,045 | `0 0 24 24` |
| `openai.svg` | Brand registry | 1,593 | `0 0 24 24` |
| `opencode.svg` | Brand registry | 139 | `0 0 24 24` |
| `pet-clawd.svg` | Pet previews | 1,465 | `0 0 192 192` |
| `pet-codex.svg` | Pet previews | 2,499 | `0 0 192 192` |
| `pet-synthetic1.svg` | Pet previews | 213 | `0 0 192 192` |
| `pet-synthetic2.svg` | Pet previews | 360 | `0 0 192 192` |
| `pet-synthetic3.svg` | Pet previews | 360 | `0 0 192 192` |
| `pi.svg` | Brand registry | 234 | `0 0 24 24` |
| `qwen-code.svg` | Catalog logos | 2,035 | `0 0 24 24` |
| `raycast.svg` | Brand registry | 528 | `0 0 24 24` |
| `setup-arc.svg` | Setup ARC | 698 | `4 4 92 92` |
| `slack.svg` | Brand registry | 1,295 | `0 0 128 128` |
| `source.svg` | Source badge | 1,599 | `0 0 24 24` |
| `xai.svg` | Brand registry | 280 | `0 0 24 24` |

## Capture adapter and implementation gaps

Surface TSX owns each scenario and capture target. See the [Frame contract](https://github.com/whzxc/agent-design-gallery/blob/main/docs/design-toolkit.md#frame) and [compare commands](https://github.com/whzxc/agent-design-gallery/blob/main/docs/design-toolkit.md#compare). `adg.config.mjs` supplies ARC's prepared fixtures below. Unreachable proposals omit the fixture and retain their concrete gap here.

```sh
adg compare --all
adg compare surfaces/task-detail --frame=relay-needs-you
```

Command flags override a frame's capture.

The adapter starts Vite with `vite.config.ts` on port 5188, blocks `/api/`, and uses the scenario's theme and language with clock `2026-01-01T00:00:00Z`. Portrait fixtures use `timezone: 'Asia/Shanghai'`, matching `accept:ui`. Compare and browser acceptance run in the main checkout. The viewer opens independently with `adg open design --port=<free-port>`; reserve port 4310 for other work.

[A] Prepared fixtures use existing scenario data and public UI controls:

| Compare fixture | Scenario | Preparation |
| --- | --- | --- |
| `approval-permission` | `approval` | Enter on `阅读项目说明 · 打开执行时间线`; wait for task detail. |
| `approval-question` | `task-states` | Enter on `Waiting for input · 打开执行时间线` inside `.agent-overview-layer`; wait for task detail. |
| `agent-account-*` | `agent-platform-lifecycle` | Open the selected account action or Claude add dialog. The adapter selects the synthetic Chrome profile and advances the relevant login states. |
| `quota-overview` | `agent-panel` | Escape and wait for the Agent panel to close. This panel has no Close button. |
| `board-unavailable` | `coordination-unavailable` | Open Board and wait for `SCENARIO_BOARD_UNAVAILABLE`, without retrying, as in `tooling/acceptance/coordination.mjs`. |
| `portrait-topology-sources-folded` | `portrait-topology-0` | Enter on `Collapse control sources`; wait for zero positioned source roots and settled portrait orientation, then clear focus. |
| `portrait-topology-agents-folded` | `portrait-topology-0` | Enter on `Collapse Agents`; wait for zero positioned Agent roots and settled portrait orientation, then clear focus. |

Task selection follows [AgentConversations](../../ui/components/AgentConversations.tsx) and [TaskNeedsYou](../../ui/components/TaskNeedsYou.tsx). Scoping avoids the identically named topology bubble beneath the panel. Portrait preparation follows [portrait acceptance](../../tooling/acceptance/portrait-topology.mjs); pointer clicks can hit the arc overlay instead of the keyboard control.

[B] `agent-platform/native` has no reachable state in the current scenarios. `antigravity-platform` has zero linked accounts. [selectAgentPanel](../../ui/state/overviewPanels.ts) converts native-only platforms with at most one account into Agent history, and [AgentPanel](../../ui/components/AgentPanel.tsx) enforces the same rule. The native empty card in `AgentPlatformView` cannot be reached through that route. Do not substitute the Antigravity history panel.

[C] `modules/model-configuration/model-effort` owns the `timeline-multi-turn` fixture and its unchanged dialog selector, viewport and preparation clicks. [TaskDispatchDialog](../../ui/components/AgentDispatchDefaults.tsx) owns the model dialog. [ModelEffortPicker](../../ui/components/ModelEffortPicker.tsx) portals its picker and nested modal menu, which makes the underlying dialog aria-hidden. adg reads an explicitly selected target inside hidden ancestors, so keep the dialog selector. The portal menu lies outside the dialog capture and is reviewed on the overlay only; its text is outside the captured target.

[D] `updates/settings` captures [AppUpdate](../../ui/components/AppUpdate.tsx) as the embedded About section. The fixture runs in a browser, where the desktop-only Check for updates button is disabled.

[E] [AddConnection](../../ui/components/AddConnection.tsx) and [SetupDialog](../../ui/components/SetupDialog.tsx) render `.setup-return` only for nested connection flows. The seven `p3-stacked-*` scenarios seed both source and connection setup; the selector identifies the child shell independently of the parent dialog's accessible visibility. The own-address form uses a taller viewport for its complete fields and footer. Setup and Add connection use the shared M Dialog. Nested captures select the child by its return context; the parent remains mounted and stationary beneath its scrim. Headers and footers stay fixed at the dialog-slot height cap.

[F] A task body at most 360px wide exposes the request entry; wider bodies show the request inline. Both request-sheet captures use 390×844 so the entry is reachable. The sheet uses the shared Dialog slot, with M for both permission and questions, a fixed header and footer, and a scrolling body. Portrait bounds retain 16px side margins.

The MCP hub uses the XL center Panel with content-fit height, capped at the bottom margin, a fixed header and a scrolling body. It retains its height across search and refresh. Agent platform and task-detail shells use the shared centered M size and retained content-fit height. Node coordinates never set their final rectangles.

Workspace and node frames capture their panel regions at the viewport cap. Scroll remaining content during browser acceptance. adg waits for stable target text after clicks and reports `settled`; this does not guarantee that an asynchronous domain state has arrived. The `board-unavailable` preparation explicitly waits for its error before capture, following [coordination acceptance](../../tooling/acceptance/coordination.mjs).

Pet preview atlas labels are decorative image content inside `aria-hidden` previews; review them as shapes in the overlay.

## Known gaps

- Remote task cards use `device/tasks`. Remote timelines and responses require device-aware management routing. Cards retain partial-history status until a timeline is available.

- Device nodes and management use `homepage-modes-controller` and `homepage-modes-member`. Remote Agent tiers, single-Agent merge and upstream controller sources are adopted. Remote account/quota inventory and transfer UI remain unavailable.

- Isolated AX badges, general/display settings content and the theme swatch have pixel-only crop fidelity differences with matching element, layout and color snapshots.
- Agent platform native has no reachable fixture. Its legacy drawing remains a retained exception.
- Runtime tokens, typography, geometry, native form semantics, accessibility and responsive shells still require alignment with their mapped design sources. Theme-swatch tokens are available but not adopted by runtime palette controls.
- Loading, failure, not-found, busy, pagination, Board detail/event rows and populated hosting forms without declared sources retain their current implementation; no new visual forms are proposed here.
- Retained generic card/settings parts without composed consumers or standalone part frames keep their per-part lifecycle/coverage exceptions above.

`surfaces/permissions.tsx` / `readiness` maps the L center workspace to `ui/App.tsx` and `ui/components/PermissionsPage.tsx`. `modules/permissions.tsx` owns readiness rows and `fixtures/permissions.ts` owns their representative text. Status: Proposed for gallery review; the source records existing business content under the approved Panel geometry.

The shared layer shells implement one centered slot with M node size and XL workspace size. Setup frames inherit the M Dialog shell, fixed footer and retained stacked parents. Hover help uses the shared Tooltip; shell and interaction motion read design tokens.

## Homepage implementation owners

| Approved owner | Runtime owner | Adoption |
| --- | --- | --- |
| `modules/homepage-mode.tsx` | `ui/display/Studio.tsx`, `ui/state/homepage.ts` | Manual persisted mode; needs-me badge capped at 99+. |
| `modules/tasks.tsx`, `modules/task-activity.tsx`, `surfaces/homepage-tasks.tsx` | `ui/components/ui/TaskSnapshot.tsx`, `ui/components/TaskStack.tsx`, `ui/components/HomepageTasks.tsx`, `ui/state/homepageTasks.ts`, `ui/state/taskProjection.ts`, `ui/state/activityModel.ts` | Local and controller-dispatched remote switcher, bounded newest-anchored timeline snapshots, Tile/Stack layouts, status filters, detail/read actions, ordering and node scope. Remote cards use native controller-scoped activity and records. Remote timeline and response forwarding remain unavailable through management. |
| `modules/node-capsule.tsx`, `modules/topology-node.tsx` | `ui/components/ui/NodeCapsule.tsx`, `ui/components/GraphNode.tsx`, `ui/topology/spring.ts` | Stadium quota outline, phase discs, attention, overflow, unconfirmed and mirrored wing. Shared 210/26 spring integrates width and outgoing port. |
| `modules/device-topology.tsx`, `surfaces/device-link-topology.tsx` | `ui/topology/Topology.tsx`, `ui/devices/DeviceNodePanel.tsx`, `ui/components/SettingsPage.tsx` | One-hop paired-device nodes, management and lower-arc Device link action. Default-off controller-source disclosure. Remote inventory and single-Agent merge use `device/tasks`. Upstream disclosure uses native device configuration. Remote account/quota inventory remains unavailable. |

`ui/topology/solve.ts`, `compact.ts`, `orientation.ts`, `portrait.ts`, `portraitRender.ts`, `render.ts` and `animate.ts` retain the topology engine. Node geometry, grouping, earcups, tentacles, springs and clock are adopted. Task slots, task queues, task wires and task-driven priorities are removed. `ArcActions.tsx` and `TuningControls.tsx` retain branch disclosure/read actions and the optional navigation entry. Browser fixtures cover the restored node engine alongside Tasks cards.

The `homepage-modes-portrait-device` fixture covers three source groups, four local Agents, two local account pools and one merged online device at 800×1250 and 1280×800 in both themes. It uses the restored solver and portrait painter.
`modules/device-topology.tsx` / `device-online-no-quota` maps to the shared neutral NodeCapsule ring. Device reachability controls its unconfirmed outline. Unknown remote task observations remain in Tasks without changing an online device's ring.

The shared layer contract uses one centered slot for every node panel, workspace and dialog. `components/panel.tsx` and `surfaces/layers.tsx` map to `ui/components/ui/layerFrame.ts`, `Panel.tsx` and `Dialog.tsx`. M/XL describe content size. Layer opening never reserves, squeezes or moves topology. The source and Agent panel surfaces use the same centered M position.

`modules/node-capsule.tsx`, `topology-node.tsx` and `topology-group.tsx` map to their shared runtime components and `ui/topology/nodeViews.tsx`. Only owning leaf nodes show task segments. Configuration parents remain normal nodes. Unread, per-member quota and device status dots are removed from topology. Tasks mode and panels retain status information.

`modules/topology-mark.tsx` maps to `ui/topology/Hub.tsx`. Its lower arc exposes Device link beside the Core action. The action opens `ui/devices/DeviceNodePanel.tsx` for adding and pairing devices. The right-wing add endpoint and its tentacle are removed. `solve.ts`, `Topology.tsx`, `render.ts` and `portraitRender.ts` render outward brackets only for configuration parents. Leaves have no outward arc or arc controls in any interaction or task state. `homepage-modes-polish` covers these rules in landscape and portrait, with both themes.

Working source capsules use `SourceIcon` at 28px through the shared `BrandMark` renderer. The compact artwork stays inside the inner cap and mirrors without covering outward task discs. `modules/node-capsule.tsx` / `left-source-attention` maps to `ui/topology/nodeViews.tsx` and `ui/components/SourceIcon.tsx`. Status: adopted. The `homepage-modes-polish` and `homepage-modes-capsules` fixtures cover source artwork separation and outward item placement in both themes.

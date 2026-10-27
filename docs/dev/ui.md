# UI conventions

[Connections and source setup](remote-link.md) · [Development](development.md) · [Architecture](architecture.md)

React renders. Tauri/Rust owns configuration, connections, tasks, authentication, native windows, and updates. The main window shares semantic tokens, preferences, and controls.

## shadcn and Tailwind foundation

ARC uses shadcn/ui source backed by Radix and Tailwind CSS v4. `vite.config.ts` uses the official `@tailwindcss/vite` plugin for the desktop frontend and `dev:ui`. `design-system/build.mjs` compiles the same token entry with that plugin and scopes preflight and utilities to `.arc-root`; component rules and floating portals remain inside their design islands. Node/npm are build tools, not desktop runtime dependencies.

Add a primitive from the repository root with the pinned CLI:

```sh
node node_modules/shadcn/dist/index.js add accordion
```

`components.json` selects the Radix `new-york` source, CSS variables, Lucide, `ui/tokens.css`, and `@/components/ui` → `ui/components/ui`. Adapt copied source in that directory. Use `cn()` from `ui/lib/utils.ts` (clsx plus tailwind-merge); replace a registry-generated `cn` package import with this helper. Keep internal copied-source imports relative so isolated renderer hosts can load them too. Do not add a second class-merging dependency or a wrapper whose only job is restyling. Review CLI dependency changes and keep direct versions pinned. Existing public adapters retain ARC's busy state, localization, privacy and domain-neutral presentation props.

Use Tailwind scale utilities and semantic tokens in features. Native controls, direct Select/ToggleGroup use, new dedicated CSS files, inline layout declarations and arbitrary color/spacing/radius/type values are rejected by `check:ui`. Compose domain objects under `ui/components/objects` and cross-object composites under `ui/components/composites`. Shared-layout CSS debt is zero. Only the arena stage and wires, quota rings and task bubbles retain dedicated brand stylesheets; ARC mark assets retain their brand painting. [UI debt](ui-debt.md) identifies the closed file and selector boundaries.

The copied primitives include button, input, textarea, label, switch, select, toggle/toggle-group, tabs, dialog, alert-dialog, tooltip, dropdown-menu, popover, card, badge, separator, scroll-area, skeleton, alert, field/form, collapsible, checkbox, slider, progress, empty and spinner. Native forms remain the default; the form helpers are available for React Hook Form consumers. Optional design-mount and Claude Design previews show primitive and shared-component states.

### Token map

| Semantic token | ARC value/owner | Utility examples |
| --- | --- | --- |
| `background` / `foreground` | White / #171719 in light; black / #f5f5f7 in dark | `bg-background text-foreground` |
| `card`, `popover` | Existing surface and raised surface | `bg-card text-card-foreground`, `bg-popover` |
| `primary` / `primary-foreground` | Existing neutral action / on-action | `bg-primary text-primary-foreground` |
| `secondary`, `muted`, `muted-foreground` | Subtle surface and secondary text | `bg-muted text-muted-foreground` |
| `accent` / `accent-foreground` | Existing neutral hover fill and foreground | `hover:bg-accent` |
| `brand-accent`, `ring` | Selected ARC paint; default #5b5ff5 / #7a7dff | `bg-brand-accent focus-visible:ring-ring` |
| `brand-foreground` | Contrast-adjusted selected accent for small text on neutral and tone surfaces | `text-brand-accent` (text-color namespace), `text-brand-foreground` |
| `destructive`, `border`, `input` | Existing danger, hairline and strong border | `text-destructive border-border border-input` |
| `radius` | 10px control base; sm 8px, lg 12px, panel/xl 20px | `rounded-md rounded-lg rounded-xl` |
| `role-source`, `role-agent`, `phase-*`, `brand-orange` | Existing ARC role, task phase and brand colors | `text-role-source text-phase-thinking` |
| `quota-*` | Existing quota palette, independent of light/dark except the selected accent | `text-quota-warning` |
| `chart-1` through `chart-8`, `sidebar-*` | Existing chart palette; sidebar derives from semantic surfaces | `bg-chart-1 bg-sidebar` |

`@theme` exposes these values to Tailwind. Body stays 14px, controls 13px, metadata 12px; spacing uses Tailwind's 4px base. Legacy `canvas`, `surface`, `text`, `action` and related names derive from the semantic variables while their feature consumers remain. Remove each legacy name when its final consumer migrates. `brand-accent` replaces the old overloaded purple `accent`; palette changes, topology and quota use that explicit brand token. These aliases remain only for brand painters and geometry consumers; functional layouts use semantic utilities.

Text and decorative paint have separate contrast needs. `--brand-foreground` derives a darker light-theme or lighter dark-theme color from the selected accent. Tailwind's `--text-color-brand-accent` mapping applies it to existing status, step, link and recommendation text without changing brand fills, borders, quota or topology paint. Brighter blue/orange/green light palettes use their own mixing weights. Success and phase foregrounds cover neutral, hover and soft tone surfaces; muted text uses the same surface matrix. Completed-task text is also checked after compositing the card at `--task-completed-opacity` over its surrounding surface. `tests/token-contrast.test.mjs`, included in `npm test`, computes unrounded sRGB contrast for every supported palette and theme, requiring at least 4.5:1 even for semantic colors also used by large text or icons. Host-provided MCP colors remain owned by the host.

`ui/theme.ts` follows system appearance by default, sets `data-theme` and the `.dark` class, and keeps native/MCP theme handling. The Tailwind dark variant reads `data-theme` so scoped design roots work without changing the host document. Reduced-motion media and environment overrides disable transitions. Common controls use Radix focus, keyboard and dismissal semantics; topology workspace geometry remains with ElasticPanel, using the shared shadcn Dialog surface.

Activity model badges retain their intrinsic width. Codex project labels use the native project catalog, shared with project resolution through a 30-second cache. Explicit project IDs take precedence; directory matching requires an unambiguous deepest root. The filesystem directory remains separate from its display name. Task details show the project beside the Agent name, with duration, source, and model in the metadata row. Model and effort share one pill. Conversation card height follows its content, with equal padding on every side.

Timeline groups follow native turn IDs regardless of dispatch origin. External Codex history remains readable after the activity monitor no longer retains the session. History read failures stay visible and retryable instead of becoming a cached partial result. Only actual coverage limits show a partial-history notice; external origin alone does not imply missing history. Incomplete coverage is distinct from a clipped output excerpt, whose notice stays beside that output. Every turn keeps a card surface in both disclosure states, including the latest and running turn. Clicking the title row toggles the turn; its right edge shows that turn’s execution duration. The task header sums known turn execution spans and excludes gaps between turns. Native lifecycle timestamps backfill historical turn timing; missing timing is not inferred from the time the panel opened. Work blocks have no outer border or extra padding. Reasoning rows show their available summary and disappear when it is empty.

The timeline owns vertical scrolling. Tables, code blocks, file lists, diffs and command logs scroll horizontally within the stream and expand to their full content height. Wheel gestures over these blocks send horizontal deltas to the block and vertical deltas to the timeline, including diagonal gestures. Unconsumed boundary events retain native scroll chaining.

## Homepage

See [Arena homepage](arena.md).

## Settings

Settings keeps everyday task behavior, startup, desktop notifications, language, system/light/dark appearance, macOS menu-bar/Dock placement, System permissions, and updates. The nested permissions and update pages retain Back/Escape navigation and entry-focus restoration. Updates shows version, release notes, check/install actions, installation timing, current progress, and recent outcomes with backup restoration.

Routing delay, proxy configuration, accent color, task-bubble presentation, quota collection/presentation/refresh, maintainer mode, and technical update policies are CLI/AX-only. There is no Extras page or display-settings dialog. The fixed stable release channel has no selector. [Advanced settings](../reference/cli.md#advanced-settings-through-cliax) documents the management ops and preference keys.


## Controls and forms

Reuse Button, Input, Slider, Field, SingleChoice, Switch, Dialog, Tooltip, Popover, menus, tables, and feedback from ui/components/ui/index.tsx. Copied shadcn primitives backed by Radix own selection, keyboard, focus, dismissal layers, Portal, and modal interaction. Layout components only arrange content.

- SingleChoice uses shadcn ToggleGroup pills for at most five options when the measured content fits, otherwise shadcn Select. Measurement uses the same content and presentation as the visible pills, including object rows. Card/navigation/swatch presentation keeps this same selection boundary. A selected pill cannot be cleared by clicking it again.
- Native forms default to one column with labels above. Only short related fields share rows.
- Field errors remain associated with inputs. Failed submission focuses the first error and preserves input.
- Dialog has an accessible title, scrolling content, and separate actions. Back removes one layer while retaining form/scroll state.
- Escape closes one layer and restores trigger focus. Async work may temporarily disable closing.
- Icon buttons have accessible names. Disabled/loading/empty/expired/failure/success states reflect real responses.


## Theme and motion

ui/tokens.css owns semantic colors, type, spacing, radii, dimensions, and shadows. ui/theme.ts follows the system by default. Explicit light/dark overrides use opaque white/black canvases. System fonts use 13-14px body, 12px metadata, and 14px reading text. IDs/credentials use shared monospace styling.

Functional icons use shared Icon with Lucide at 16/20px and 1.75px strokes. Brands retain their assets. Copied components own control styles through Tailwind. `ui/tokens.css` owns Tailwind, semantic tokens and global defaults. `ui/brand/` owns topology, quota-ring and task-bubble painting. Workspace, Dialog, dock and bottom-sheet layout live in their React components as Tailwind utilities; no non-brand feature or shared-component stylesheets remain.

Related tooltips remain mounted and move/resize continuously between triggers. HoverScope uses shared spring highlights following pointer, keyboard, and Radix state. reduced-motion removes unnecessary transitions.

## Functional pages

Task lists belong to AGENT account L2 and open the unchanged L3 task detail. SRC L2 lists account conversations and opens their recorded ARC task references on the AGENT side. There is no Tasks workspace. Shared rows retain recorded model/effort, title, project and runtime/error evidence. React never executes raw task HTML.

Logs (the former Records page) shows time, available source name, tool/op and result. Consecutive successes for one ingress/op may merge counts. Missing origins are not inferred. Recent counts use bounded raw logs without estimated request durations.

Connections shows the public relay link and Local connections with state, address copy and start/stop. Other connections are read-only rows. Provider, authentication and tool-policy configuration remain in CLI/AX. Add SRC retains pairing approval and denial without exposing grant history.

SRC panels dock left and AGENT panels dock right. A stable shell contains L1 platform, L2 account and L3 task views. Headers stay at the top. Back and Escape remove one layer, then restore the account/task trigger when it remains available. A single-account shortcut never removes the platform from the back path. Empty L1 panels retain Add account. Empty L2 panels retain state, quota when available, Rename and Remove.

SRC L1 lists aliases and states once per account. Add account preselects the platform in Add SRC. SRC L2 shows health, source state, latest last seen and conversations from the account's native conversation registry. A single task reference opens AGENT L3; multiple references require an explicit task choice; conversations without tasks remain read-only. Connection tabs and cross-role account links are removed.

AGENT L1 shows the Agent name/version, Add account using the existing native login flow, and account aliases, states and quota icons. It has no aggregate task list. L2 shows account state, quota and only tasks attributed to that account. Rename and Remove use shared centered dialogs. The L3 content and its task actions are unchanged.

Agent settings distinguishes installed cards from compact uninstalled rows. Installed enabled cards use Motion Reorder, with pointer dragging outside controls and arrow sorting on focused cards. Enable/disable and order persist to the homepage. A compact list of official setup links may accompany discovered agents; it does not need installation-status rows. Agent settings no longer opens Agent details, quota overview or display settings. CLI/AX owns task bubble density, width, auto-compact, homepage Agent count and quota presentation.

## Subscription quota

Homepage account nodes and AGENT L1 account rows use AgentQuotaIcon in QuotaRing. Agent settings shows logos without quota. Agent panels use an inner short-window ring and an outer weekly ring when those windows exist. Their compact quota block shows two window cards, reset countdowns or times, remaining or used percentages, and bars. Both bars mark time progress from their own known period and reset time, including windows with no consumption. Each window shows its own pace or estimated exhaustion hint beside its percentage, aligned at the bottom. Exhaustion estimates require a usable reset time and enough elapsed consumption; estimates are shown when the window is projected to exhaust before resetting. Update age and refresh stay in the window header. Agent panels and account quota sections share `AgentQuota`. Account-scoped panels use the account alias and that account's quota; platform panels show only account rows. Providers without a usable window show one muted line. QuotaBubble remains in settings and quota overview, retaining plan links, other window readings, reset times, pace, time ticks, credit-expiry details, and product usage. UsageHistory owns hover/focus spring following, collision placement, and layered Escape. Panel tooltips use compact padding, content sizing, no arrow tip, and top-center placement with collision avoidance. No historical charts are drawn. Quota overview reuses the same cards.

CLI/AX retains homepage count, remaining/used, countdown/date, enablement, and refresh interval. Sources participate automatically by Agent. Quota data appears by default when available. Homepage rings use weekly quota only and disappear without it. Details retain other upstream windows. No local usage periods, tokens, or money display.

## Update notification

The update popover keeps its header and action footer outside the scrolling body. Release notes and impact details scroll independently within a bounded content area, capped at 460px and reduced for short windows. Narrow windows stack the two scrolling sections.

Only the primary button shows download size/progress. Do not add a body progress area. Completion changes the button to the localized install-update action. Installation requires another click.

## Verification

Check light/dark, narrow windows, long Chinese/English content, layered Escape and focus restoration through `npm run dev:ui` connected to the running app. Radix owns generic keyboard handling and dialog semantics. Installed WebView, tray and lifecycle require separate runtime acceptance.

## Task detail projection

Task details prioritize pending decisions, final replies, phase prose, the latest plan, merged tool activity, and one live thinking line. Successful turns fold their process; failed and interrupted turns start expanded and honor subsequent disclosure choices. Process summaries align their text insets with final-reply cards and leave a full row gap above expanded content. Previous turns start collapsed and their arrows follow the expanded state. Previous-turn and process-summary arrows stay at the right edge. Tool groups open automatically only while running and honor manual disclosure choices. Each tool invocation row toggles its details, which start collapsed even after failure. Running commands retain their live log preview. Pending execution questions and permission requests show an input dock for every source, including ARC-local turns, while execution is running. The header derives its attention state from the same answerable, unsubmitted request set. Resolved history overrides stale activity requests. Question drafts survive closing the narrow-panel sheet. The dock disappears after resolution or execution ends. Prompt source labels use recorded provenance; prompts without a source omit the entire metadata row. Review status appears only for turns dispatched by a recorded control source. Control sources own dispatch, queue changes, interruption, and review. Task details expose no composer, purpose selector, stop, or review actions. The latest failed turn offers Retry inside its outcome card; the latest interrupted Codex turn offers Resume there. Retry sends an explicit continuation in the same task and retains its receipt requestId on uncertain retries. The continuation asks the Agent to inspect existing work and avoid repeating side effects instead of replaying the original prompt. Source chips show only the source icon and name. Titles stay on one line and truncate overflow. The header combines model, effort, and the optional fast-mode lightning icon in one pill, with duration aligned to the right. Turn numbers remain in the timeline without a separate header row. Chinese UI durations separate numbers and units with spaces. Changed-file lists show the first three files by default; a summary-row toggle with a right-edge arrow reveals or hides the rest. Added and deleted files carry explicit operation badges from native evidence. Later edits retain a recorded creation marker. Line counts never determine file operation badges.

At 360px of panel width or below, the header uses a single-line title, status and compact metadata. Tool counts become chips and the narrative drops its avatar column. Pending requests remain visible as an amber banner that opens the shared modal Dialog as a bottom sheet anchored to the Agent panel. Closing the sheet preserves selection and free-text drafts. Escape dismisses only that layer and restores focus. The overflow menu retains native-open and width controls. Dark theme and reduced motion use shared semantic tokens.

The pending-input dock uses at most 60% of the task panel height. The timeline shrinks into the remaining space. Question fields and permission previews scroll inside the dock while request navigation, answer actions and routing status remain visible. The narrow input sheet uses its actual shell width and available height, with the same internal scrolling boundary.

## Account privacy

The persisted `arc.privacy` preference masks emails, organization names, identity keys, notification session names, and connection addresses. The source-panel header exposes its toggle. Aliases, topology labels, task titles, prompts, and task bubbles remain readable.

Render sensitive fields with `Sensitive` and compound email/organization lines with `SensitiveIdentity`. Hidden fields contain deterministic stand-in letters, preserving whitespace, `@` and `.`, with a soft inline blur and reduced opacity in both themes. Off-DOM font measurement reserves the original text width and scales stand-ins to fit it; narrow containers clip the inline run. Multiline identity fields use `wrap` to let both visible text and masked stand-ins wrap naturally within the card instead of reserving a fixed inline width. Never keep raw values in hidden elements, titles, accessibility labels, input values, or data attributes. Plain-text tooltips and upstream notices use bullet masking for known identities and email substrings. Reduced motion disables the short blur-in animation.

`SensitiveInput` displays bullet stand-ins and becomes read-only while masked; turn privacy off to edit. Copy buttons continue to copy the real value from React state. Turning privacy off restores the exact original text. Snapshot requests enable privacy before rendering; AX and management responses remain unchanged.

`ui/types.ts` owns the native account types and `accountsApi` in `ui/api.ts` owns management routes. Login polling reads the list's `login` field and code submission receipts do not imply completion. Notification tests send to an explicit session target; manual binding assigns a host route and does not verify delivery. MCP Events exposes observed reachability without Claude notification actions. Unidentified sources retain their native alias and have no inferred identity or fake reauthorization recovery. `defaultFor` selects a replacement default; `default:false` clears that Agent default through CLI/AX. Current native limitations also include API-key authentication through each Agent's CLI and no provider identity claims from MCP OAuth grants.

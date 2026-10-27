# UI component debt

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

Compose feature UI from the shared primitives, shells, forms, composites and objects described in [Component specification](component-spec.md). Add shared patterns when real screens need them.

Run `npm run check:ui` (also part of `npm run check`) to enforce shared controls, DispatchSpec rendering, inline layout ownership and feature CSS selector ownership. Tailwind utilities are the supported replacement for legacy layout selectors.

## Scope

Feature code includes all UI source except `ui/components/ui/**`, `ui/components/composites/**`, `ui/components/objects/**`, `ui/design-mount/**`, and the topology geometry/painters enumerated in `tooling/ui-policy.mjs`.

Raw button, input, select, textarea, label, details, summary and definition-list elements require shared components. Direct model/effort/service-tier reads from `dispatchSummary` or `task` inside JSX require DispatchSpec. Event handlers and data processing outside JSX remain allowed; this syntactic rule does not perform alias/data-flow analysis. Inline margin, padding, gap, display, flex/grid and alignment properties require shared shells. Existing dynamic geometry properties such as top, left, width, height and transform remain allowed. New feature controls use SingleChoice/ChoiceControl rather than importing Select, ToggleGroup or RadioGroup directly. Arbitrary Tailwind color, spacing, radius and typography values are forbidden, including conditional and cn/cva string literals.

Dedicated CSS is restricted to `ui/tokens.css` and these brand-owned files. `tooling/ui-policy.mjs` enumerates both file paths and selector families. Shared primitives, composites and objects do not receive a CSS exemption. The token entry accepts only global foundation selectors, so feature rules cannot move there. New non-brand files and non-brand selectors in brand files fail `check:ui`.

| Brand owner | Stylesheet | Boundary |
| --- | --- | --- |
| Arena stage and wires | `ui/brand/topology.css` | Solver geometry, node painting and tactile power control; no feature settings or panel layouts |
| Quota rings | `ui/brand/quota.css`, `ui/components/composites/AgentQuotaIcon.css` | Ring painting and intrinsic brand artwork sizing |
| Task bubbles | `ui/brand/task-bubbles.css` | Bubble painting, phase animation and update-blocking visuals |

## Remaining migration ownership

No shared-layout debt remains. Workspace, Dialog/dock/input-sheet shells, Agent and source panels, breadcrumbs, timeline metadata, privacy text, shared hover previews, RequestCard and DispatchSpec use Tailwind utilities. ElasticPanel retains the existing geometry and lifecycle controller over the shadcn Dialog surface. Brand geometry is outside layout migration.

## Cleanup

The baselines and this list MUST only shrink. Never add lint directives, baseline entries or higher counts for new code. ESLint debt is bound to the file, rule, token fingerprint and occurrence count; moving lines or formatting does not grant new allowances. Changed violating fragments and extra copies fail. Remove the corresponding entries/counts when migrating code to shared components; checks report stale entries. Update the table below in the same change. There is no baseline regeneration command.

Local checks reject baseline growth against HEAD. CI MUST set `ARC_UI_DEBT_BASE` to the PR base commit to reject growth across committed changes. The initial baseline is admitted only when that base has no baseline file.

Counts are outstanding violations per file and rule, sorted by count.

<!-- ui-debt:start -->
| File | Rule | Count |
| --- | --- | ---: |

<!-- ui-debt:end -->

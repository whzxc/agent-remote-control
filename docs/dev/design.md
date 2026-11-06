# Design assets

[UI conventions](ui.md) · [Acceptance](acceptance.md) · [Development](development.md)

SVG assets in `design/` define how ARC looks. React implementations follow them. [UI conventions](ui.md) owns behavior, data projection and layout logic.

ARC uses the global `@whzxc/svg-design-gallery` CLI, version 0.3.3 or later. The [SDG toolkit contract](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md) owns the [format](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#asset-format), [checks](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#check), [workflow](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#workflow), [layout review](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#layout-review), [commands and viewer](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#commands), and [limits](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#limits).

## Layout

- `design/tokens.css` is ARC's token source. `ui/tokens.css` is the runtime sheet.
- `design/components/` contains shared component sheets; `design/surfaces/` composes them into ARC panels, dialogs and pages.
- `sdg.config.mjs` declares the required toolkit version, paths and browser fixture adapter. Generated output goes to the ignored `output/design/` directory.
- The homepage preserves the ARC mark, earcup connections and topology. Portrait forms use a 640×800 viewport, except expanded-single-task at 640×1000; landscape forms use 1280×800.
- Tile geometry has a neutral shell with a separate state tint. Phase labels keep shared text typography and apply their semantic color to a span.

## Presentation forms

Keep the forms declared in the assets. Themes use the same geometry, and each sheet uses one representative language. The frames table identifies the corresponding fixture, including its language and fixed clock.

Task bubbles retain compact, standard, detailed, row and attention-row forms. Portrait topology retains expanded-empty, expanded-single-task, expanded-two-tasks, sources-compacted, sources-folded and agents-folded forms. The shared board-header component retains active and idle forms, used by the existing homepage frames. Setup retains standalone and nested connection flows; method and ready have distinct controls. The task-relationships component's detail-header examples are parts of its family form, not separate surface frames.

## Implementation checklist

- Size shared controls through their size variables, such as `--icon-button-size`. A width or height override leaves the control's minimum size in place and distorts its shape.
- Make each surface rule win over generic panel rules, such as `.elastic-panel .dialog-header h2`. A text width difference in `compare` usually means a font rule lost.
- Remove redundant base definitions from `ui/tokens.css` when `design/tokens.css` owns the same token. Keep the scoped `data-surface="mcp"` overrides that map semantic tokens to host colors.
- Avoid `font-variant-numeric` and `letter-spacing` values that the asset does not use, because they change text widths.
- Panel forms have no stroke. A leftover 1px panel border shifts every text by 1px.
- Review the overlay for shapes, fills, icons and elevation, because `compare` reads text only.
- Delete superseded rules, classes and visual statements in [UI conventions](ui.md) in the same change.

## Migration

- A surface without an approved asset keeps its current implementation. Its next visual change starts by drawing its asset.
- `ui/tokens.css` is the runtime token sheet. Migrating a surface aligns the tokens it uses with `design/tokens.css`.
- Migrating a surface deletes its visual statements from [UI conventions](ui.md) and keeps its behavior statements.

## Frames

Paths are relative to `design/surfaces/`; frame names omit `frame-`. The table covers all 63 frames. The two unavailable presentations have no `data-fixture`; their closest scenarios are documented below. All other frames name either an existing `accept:ui` scenario or a prepared compare fixture in `sdg.config.mjs`.

Targets are exact region/dialog names for `--region`, except explicit CSS selectors for `--selector`. Selectors identify the intended shell when nested dialogs or popovers hide its accessible name. The viewport column is the `--viewport` argument; page frames also declare it and origin in the SVG. Use every listed viewport, including for region captures. A viewport is the browser size, not a forced element size.

Clicks become separate `--click` arguments in order. SDG 0.3.2 resolves visible controls by exact accessible name across buttons, radios, tabs, checkboxes, switches, menu items, options and links. `Activity` and `Google` must be included. A “prepared” entry runs automatically in the adapter before the listed clicks; do not pass its description to `--click`.

```sh
sdg compare surfaces/task-detail.svg --frame=needs-you --selector='.dialog:has(.task-detail-layer)' --viewport=1280x1100
sdg compare surfaces/coordination.svg --frame=gap --region=Board --viewport=1280x800 --click='Open board' --click=Activity
sdg compare surfaces/homepage-topology-portrait.svg --frame=sources-folded
```

The adapter starts Vite with `vite.config.ts` on port 5188, blocks `/api/`, and uses the scenario's theme and language with clock `2026-01-01T00:00:00Z`. Portrait fixtures use `timezone: 'Asia/Shanghai'`, matching `accept:ui`. Compare and browser acceptance run in the main checkout. The viewer opens independently with `sdg design`.

| Asset | Frame | Fixture | Target | Viewport | Clicks / preparation |
| --- | --- | --- | --- | --- | --- |
| `agent-panel.svg` | `overview` | `agent-panel` | Codex | 1280x1100 | — |
| `agent-panel.svg` | `empty` | `agent-panel-empty` | Codex | 1280x800 | — |
| `agent-platform.svg` | `accounts` | `agent-platform-accounts` | selector `.dialog:has(.agent-platform-view)` | 1280x800 | prepared [A] |
| `agent-platform.svg` | `native` | — | Unavailable: zero-account platforms open Agent history [B] | — | — |
| `approval.svg` | `permission` | `approval-permission` | selector `.dialog[data-sheet="true"]`; width drift: asset 360px, implementation 332px [F] | 510x844 | prepared task [A], then `打开` |
| `approval.svg` | `question` | `approval-question` | selector `.dialog[data-sheet="true"]`; width drift: asset 360px, implementation 330px [F] | 525x844 | prepared task [A], then `打开` |
| `approval.svg` | `model-effort` | `timeline-multi-turn` | selector `.dialog:has(.task-dispatch-fields)`; explicit hidden target [C] | 1280x800 | `本任务模型` → `模型与推理强度` → `默认模型: 跟随任务` [C] |
| `connections.svg` | `overview` | `p3-workspace-add-light` | 连接 | 1280x800 | — |
| `coordination.svg` | `current` | `coordination-problems` | Board | 1280x1400 | `Open board` |
| `coordination.svg` | `empty` | `coordination-empty` | Board | 1280x800 | `Open board` |
| `coordination.svg` | `gap` | `coordination-gap` | Board | 1280x800 | `Open board` → `Activity` |
| `coordination.svg` | `unavailable` | `board-unavailable` | Board | 1280x800 | prepared [A] |
| `homepage-topology-accounts.svg` | `accounts` | `topology-accounts` | page, origin `0 0` | 1280x800 | — |
| `homepage-topology-empty.svg` | `empty` | `connections-empty-light` | page, origin `0 0` | 1280x800 | — |
| `homepage-topology-portrait.svg` | `expanded-empty` | `portrait-topology-0` | page, origin `0 0` | 640x800 | — |
| `homepage-topology-portrait.svg` | `expanded-single-task` | `portrait-topology-1` | page, origin `0 0` | 640x1000 | — |
| `homepage-topology-portrait.svg` | `expanded-two-tasks` | `portrait-topology-2` | page, origin `0 0` | 640x800 | — |
| `homepage-topology-portrait.svg` | `sources-compacted` | `portrait-topology-4` | page, origin `0 0` | 640x800 | — |
| `homepage-topology-portrait.svg` | `sources-folded` | `portrait-topology-sources-folded` | page, origin `0 0` | 640x800 | prepared [A] |
| `homepage-topology-portrait.svg` | `agents-folded` | `portrait-topology-agents-folded` | page, origin `0 0` | 640x800 | prepared [A] |
| `homepage-topology-studio.svg` | `studio` | `arc-actions-light` | page, origin `0 0` | 1280x800 | — |
| `homepage-topology-tasks.svg` | `tasks` | `parallel-seven` | page, origin `0 0` | 1280x800 | — |
| `mcp-hub.svg` | `ready` | `mcp-hub-ready-dark` | MCP 中枢 | 1280x1200 | — |
| `mcp-hub.svg` | `failed` | `mcp-hub-failed-dark` | MCP 中枢 | 1280x1200 | — |
| `mcp-hub.svg` | `empty` | `mcp-hub-empty-dark` | MCP 中枢 | 1280x1200 | — |
| `pets-settings.svg` | `library` | `pets-settings` | Pets | 1280x800 | — |
| `platforms.svg` | `connected` | `accounts` | Platforms | 1280x800 | — |
| `platforms.svg` | `empty` | `accounts` | Platforms | 1280x800 | `Google` |
| `quota-overview.svg` | `overview` | `quota-overview` | selector `.dialog:has(.usage-overview)` | 1280x800 | prepared [A], then `管理 Agent` → `订阅额度` |
| `quota-overview.svg` | `empty` | `settings-about-dark` | selector `.dialog:has(.usage-overview)` | 1280x800 | `返回首页` → `管理 Agent` → `订阅额度` |
| `relay-hosting.svg` | `empty` | `relay-hosting-light` | Relay hosting | 1280x800 | — |
| `settings.svg` | `about` | `settings-about-light` | Settings | 1280x1600 | — |
| `settings.svg` | `agents` | `agent-settings-dispatch-defaults` | Agents | 1280x800 | `Manage Agents` |
| `settings.svg` | `agent-detail` | `agent-settings-dispatch-defaults` | Codex | 1280x800 | `Manage Agents` → `Codex` |
| `settings.svg` | `display` | `agent-settings-display-light` | Agent settings | 1280x1080 | `Manage Agents` → `Agent settings` |
| `settings.svg` | `experimental` | `experimental-settings` | Settings | 1280x800 | — |
| `setup.svg` | `welcome` | `p3-welcome-light` | 从哪里指挥 Codex？ | 1280x800 | — |
| `setup.svg` | `source-product` | `p3-source-fixed-light` | 添加控制源 | 1280x800 | — |
| `setup.svg` | `source-connection` | `p3-source-connection-light` | 添加 Claude | 1280x800 | — |
| `setup.svg` | `source-empty` | `p3-source-empty-light` | 添加 Claude | 1280x800 | — |
| `setup.svg` | `source-local` | `p3-source-local-light` | 添加 Claude Code | 1280x800 | — |
| `setup.svg` | `source-address` | `p3-source-address-light` | 添加 Claude | 1280x800 | — |
| `setup.svg` | `source-approval` | `p3-source-approval-light` | 添加 Claude | 1280x800 | — |
| `setup.svg` | `source-success` | `p3-source-success-light` | 添加 Claude | 1280x800 | — |
| `setup.svg` | `method` | `p3-connection-method-light` | 添加连接 | 1280x800 | — |
| `setup.svg` | `stacked-method` | `p3-stacked-method-light` | selector `.setup-dialog:has(.setup-return)`; width drift: asset 680px, implementation 626px [E] | 1280x800 | — [E] |
| `setup.svg` | `stacked-relay` | `p3-stacked-relay-light` | selector `.setup-dialog:has(.setup-return)`; width drift: asset 680px, implementation 626px [E] | 1280x800 | — [E] |
| `setup.svg` | `stacked-local` | `p3-stacked-local-light` | selector `.setup-dialog:has(.setup-return)`; width drift: asset 680px, implementation 626px [E] | 1280x800 | — [E] |
| `setup.svg` | `stacked-join` | `p3-stacked-join-light` | selector `.setup-dialog:has(.setup-return)`; width drift: asset 680px, implementation 626px [E] | 1280x800 | — [E] |
| `setup.svg` | `stacked-own` | `p3-stacked-own-light` | selector `.setup-dialog:has(.setup-return)`; width drift: asset 680px, implementation 626px [E] | 1280x1000 | — [E] |
| `setup.svg` | `stacked-secure` | `p3-stacked-secure-light` | selector `.setup-dialog:has(.setup-return)`; width drift: asset 680px, implementation 626px [E] | 1280x800 | — [E] |
| `setup.svg` | `stacked-ready` | `p3-stacked-ready-light` | selector `.setup-dialog:has(.setup-return)`; width drift: asset 680px, implementation 626px [E] | 1280x800 | — [E] |
| `setup.svg` | `ready` | `p3-connection-ready-light` | 添加连接 | 1280x800 | — |
| `setup.svg` | `relay-login` | `p3-connection-login-dark` | 添加连接 | 1280x800 | — |
| `source-panel.svg` | `dispatches` | `source-panel` | Claude | 1280x800 | — |
| `source-panel.svg` | `history` | `dispatch-states` | Claude | 1280x1200 | — |
| `source-panel.svg` | `platform` | `source-panel` | Anthropic | 1280x800 | `Anthropic` |
| `task-detail.svg` | `running-multi-turn` | `timeline-multi-turn` | selector `.dialog:has(.task-detail-layer)` | 1280x1100 | — |
| `task-detail.svg` | `needs-you` | `timeline-pending` | selector `.dialog:has(.task-detail-layer)` | 1280x1100 | — |
| `task-detail.svg` | `failed-turn` | `task-detail-failed` | selector `.dialog:has(.task-detail-layer)` | 1280x1100 | prepared task [A] |
| `updates.svg` | `available` | `updates-available-panel` | App updates | 1280x800 | — |
| `updates.svg` | `installing` | `updates-installing` | App updates | 1280x800 | — |
| `updates.svg` | `settings` | — | Unavailable: no standalone About shell [D] | — | — |

[A] Prepared fixtures use existing scenario data and public UI controls:

| Compare fixture | Scenario | Preparation |
| --- | --- | --- |
| `approval-permission` | `approval` | Enter on `阅读项目说明 · 打开执行时间线`; wait for task detail. |
| `approval-question` | `task-states` | Enter on `Waiting for input · 打开执行时间线` inside `.agent-overview-layer`; wait for task detail. |
| `task-detail-failed` | `task-states` | Enter on `Failed task · 打开执行时间线` inside `.agent-overview-layer`; wait for task detail. |
| `agent-platform-accounts` | `brand-accounts-light` | Enter on `Claude Code` inside `[data-agent-platform="claude"]`; wait for `.agent-platform-view`. |
| `quota-overview` | `agent-panel` | Escape and wait for the Agent panel to close. This panel has no Close button. |
| `board-unavailable` | `coordination-unavailable` | Open Board and wait for `SCENARIO_BOARD_UNAVAILABLE`, without retrying, as in `tooling/acceptance/coordination.mjs`. |
| `portrait-topology-sources-folded` | `portrait-topology-0` | Enter on `Collapse control sources`; wait for zero positioned source roots and settled portrait orientation, then clear focus. |
| `portrait-topology-agents-folded` | `portrait-topology-0` | Enter on `Collapse Agents`; wait for zero positioned Agent roots and settled portrait orientation, then clear focus. |

Task selection follows [AgentConversations](../../ui/components/AgentConversations.tsx) and [TaskNeedsYou](../../ui/components/TaskNeedsYou.tsx). Scoping avoids the identically named topology bubble beneath the panel. Portrait preparation follows [portrait acceptance](../../tooling/acceptance/portrait-topology.mjs); pointer clicks can hit the arc overlay instead of the keyboard control.

[B] `agent-platform/native` has no reachable state in the current scenarios. `antigravity-platform` has zero linked accounts. [selectAgentPanel](../../ui/state/overviewPanels.ts) converts platforms with at most one account into Agent history, and [AgentPanel](../../ui/components/AgentPanel.tsx) enforces the same rule. The native empty card in `AgentPlatformView` cannot be reached through that route. Do not substitute the Antigravity history panel.

[C] [TaskDispatchDialog](../../ui/components/AgentDispatchDefaults.tsx) owns the model dialog. [ModelEffortPicker](../../ui/components/ModelEffortPicker.tsx) portals its picker and nested modal menu, which makes the underlying dialog aria-hidden. SDG 0.3.3 reads an explicitly selected target inside hidden ancestors, so keep the dialog selector. The portal menu lies outside the dialog capture and is reviewed on the overlay only; its text is outside the captured target.

[D] `updates/settings` has no standalone shell in any current scenario. `updates-settings` renders [AppUpdate](../../ui/components/AppUpdate.tsx) inside `SettingsPage`: `.settings-about` is the inner content, while its `.page-sheet` ancestor contains every settings group. Neither matches the asset's 720×258 standalone About panel. Review the embedded content with `updates-settings` during browser acceptance; do not treat that content crop as this frame.

[E] [AddConnection](../../ui/components/AddConnection.tsx) and [SetupDialog](../../ui/components/SetupDialog.tsx) render `.setup-return` only for nested connection flows. The seven `p3-stacked-*` scenarios seed both source and connection setup; the selector identifies the child shell independently of the parent dialog's accessible visibility. The own-address form uses a taller viewport for its complete fields and footer. The implementation scales the nested width to 680px × .92 (626px when rounded), while all seven assets declare 680px. Keep these mappings and track the width difference as layout drift. Zero extracted texts in these nested dialogs are an ARC accessibility defect; the mapping remains the child shell.

[F] The request sheet is limited to its host width minus 16px. A wider host switches to the inline request, making the asset's 360px sheet unreachable. Use the reachable permission capture at 510×844 (332×292) and question capture at 525×844 (330×406), and track their sheet widths as implementation drift. Permission has no `打开` control at 525×844; keep the two viewports distinct.

The MCP hub uses the full workspace height ([UI conventions](ui.md#experimental-mcp-hub)); a taller viewport exposes its service list. Its current shell height follows the viewport, so the older content-fit sizes (662, 912 and 432px) are not current capture-size requirements. Agent platform and task-detail shells likewise follow [topology panel geometry](../../ui/topology/Topology.tsx); their width is not fixed to the drawing's 480 or 640px. Compare these differences as layout findings rather than selecting another panel or resizing the DOM.

Full-content drawings in `agent-panel/overview`, `coordination/current`, `settings/about`, `settings/display` and `source-panel/history` can exceed the scroll viewport. The explicit heights provide room for their content; inspect remaining scroll content during browser acceptance. SDG waits for stable target text after clicks and reports `settled`; this does not guarantee that an asynchronous domain state has arrived. The `board-unavailable` preparation explicitly waits for its error before capture, following [coordination acceptance](../../tooling/acceptance/coordination.mjs).

Pet preview atlas labels are decorative image content inside `aria-hidden` previews; review them as shapes in the overlay.

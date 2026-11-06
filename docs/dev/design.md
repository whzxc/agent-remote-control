# Design assets

[UI conventions](ui.md) · [Acceptance](acceptance.md) · [Development](development.md)

SVG assets in `design/` define how ARC looks. React implementations follow them. [UI conventions](ui.md) owns behavior, data projection and layout logic.

ARC uses the global `@whzxc/svg-design-gallery` CLI, version 0.3.0 or later. The [SDG toolkit contract](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md) owns the [format](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#asset-format), [checks](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#check), [workflow](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#workflow), [layout review](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#layout-review), [commands and viewer](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#commands), and [limits](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md#limits).

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

All asset paths below are relative to `design/surfaces/`. Frame names omit the `frame-` prefix. Each frame declares its `data-fixture`; all 63 frames have an existing `accept:ui` scenario. No surface frame lacks a scenario.

The region column gives the exact accessible region or dialog name for `--region`, except where it explicitly names a selector. Viewport frames declare `data-viewport` and `data-origin` in the SVG. Other viewport overrides below preserve the full-height presentation where practical. Clicks run in the listed order; each button name becomes one `--click` argument. For example:

```sh
sdg compare surfaces/agent-panel.svg --frame=overview --region=Codex
sdg compare surfaces/homepage-topology-portrait.svg --frame=expanded-empty
```

The adapter starts Vite with `vite.config.ts` on port 5188, blocks `/api/` requests, and uses each scenario's theme and language with the fixed `2026-01-01T00:00:00Z` clock. Compare and browser acceptance run in the main checkout. The viewer opens independently with `sdg design`.

Portrait browser acceptance sets the timezone to `Asia/Shanghai`, matching the board-header date and `08:00` clock in those assets. SDG 0.3.0 has no fixture timezone option and uses the browser's timezone. Compare review must use the same timezone for these labels.

| Asset | Frame | Fixture | Region or viewport | Clicks |
| --- | --- | --- | --- | --- |
| `agent-panel.svg` | `overview` | `agent-panel` | Codex | — |
| `agent-panel.svg` | `empty` | `agent-panel-empty` | Codex | — |
| `agent-platform.svg` | `accounts` | `brand-accounts-light` | Claude Code | `Claude Code` |
| `agent-platform.svg` | `native` | `antigravity-platform` | Antigravity | — |
| `approval.svg` | `permission` | `approval` | 待处理请求; `--viewport=390x844` | `Codex` → `阅读项目说明 · 打开执行时间线` → `打开` |
| `approval.svg` | `question` | `task-states` | 待处理请求; `--viewport=390x844` | `Waiting for input · 打开执行时间线` → `打开` |
| `approval.svg` | `model-effort` | `timeline-multi-turn` | 本任务模型 | `本任务模型` → `模型与推理强度` → `默认模型: 跟随任务` |
| `connections.svg` | `overview` | `p3-workspace-add-light` | 连接 | — |
| `coordination.svg` | `current` | `coordination-problems` | Board; `--viewport=1280x1400` | `Open board` |
| `coordination.svg` | `empty` | `coordination-empty` | Board | `Open board` |
| `coordination.svg` | `gap` | `coordination-gap` | Board | `Open board` → radio `Activity` [1] |
| `coordination.svg` | `unavailable` | `coordination-unavailable` | Board | `Open board` |
| `homepage-topology-accounts.svg` | `accounts` | `topology-accounts` | viewport `1280x800`, origin `0 0` | — |
| `homepage-topology-empty.svg` | `empty` | `connections-empty-light` | viewport `1280x800`, origin `0 0` | — |
| `homepage-topology-portrait.svg` | `expanded-empty` | `portrait-topology-0` | viewport `640x800`, origin `0 0` | — |
| `homepage-topology-portrait.svg` | `expanded-single-task` | `portrait-topology-1` | viewport `640x1000`, origin `0 0` | — |
| `homepage-topology-portrait.svg` | `expanded-two-tasks` | `portrait-topology-2` | viewport `640x800`, origin `0 0` | — |
| `homepage-topology-portrait.svg` | `sources-compacted` | `portrait-topology-4` | viewport `640x800`, origin `0 0` | — |
| `homepage-topology-portrait.svg` | `sources-folded` | `portrait-topology-0` | viewport `640x800`, origin `0 0` | `Collapse control sources` |
| `homepage-topology-portrait.svg` | `agents-folded` | `portrait-topology-0` | viewport `640x800`, origin `0 0` | `Collapse Agents` |
| `homepage-topology-studio.svg` | `studio` | `arc-actions-light` | viewport `1280x800`, origin `0 0` | — |
| `homepage-topology-tasks.svg` | `tasks` | `parallel-seven` | viewport `1280x800`, origin `0 0` | — |
| `mcp-hub.svg` | `ready` | `mcp-hub-ready-dark` | MCP 中枢 | — |
| `mcp-hub.svg` | `failed` | `mcp-hub-failed-dark` | MCP 中枢 | — |
| `mcp-hub.svg` | `empty` | `mcp-hub-empty-dark` | MCP 中枢 | — |
| `pets-settings.svg` | `library` | `pets-settings` | Pets | — |
| `platforms.svg` | `connected` | `accounts` | Platforms | — |
| `platforms.svg` | `empty` | `accounts` | Platforms | radio `Google` [1] |
| `quota-overview.svg` | `overview` | `agent-panel` | 订阅额度 | `关闭` → `管理 Agent` → `订阅额度` |
| `quota-overview.svg` | `empty` | `settings-about-dark` | Subscription quotas | `Back to home` → `Manage Agents` → `Subscription quotas` |
| `relay-hosting.svg` | `empty` | `relay-hosting-light` | 中继托管 | — |
| `settings.svg` | `about` | `settings-about-light` | Settings; `--viewport=1280x1400` | — |
| `settings.svg` | `agents` | `agent-settings-dispatch-defaults` | Agents | `Manage Agents` |
| `settings.svg` | `agent-detail` | `agent-settings-dispatch-defaults` | Codex | `Manage Agents` → `Codex` |
| `settings.svg` | `display` | `agent-settings-display-light` | Agent settings; `--viewport=1280x1080` | `Manage Agents` → `Agent settings` |
| `settings.svg` | `experimental` | `experimental-settings` | Settings | — |
| `setup.svg` | `welcome` | `p3-welcome-light` | 从哪里指挥 Codex？ | — |
| `setup.svg` | `source-product` | `p3-source-fixed-light` | 添加控制源 | — |
| `setup.svg` | `source-connection` | `p3-source-connection-light` | 添加 Claude | — |
| `setup.svg` | `source-empty` | `p3-source-empty-light` | 添加 Claude | — |
| `setup.svg` | `source-local` | `p3-source-local-light` | 添加 Claude Code | — |
| `setup.svg` | `source-address` | `p3-source-address-light` | 添加 Claude | — |
| `setup.svg` | `source-approval` | `p3-source-approval-light` | 添加 Claude | — |
| `setup.svg` | `source-success` | `p3-source-success-light` | 添加 Claude | — |
| `setup.svg` | `method` | `p3-connection-method-light` | 添加连接 | — |
| `setup.svg` | `stacked-method` | `p3-stacked-method-light` | 添加连接 | — |
| `setup.svg` | `stacked-relay` | `p3-stacked-relay-light` | 添加连接 | — |
| `setup.svg` | `stacked-local` | `p3-stacked-local-light` | 添加连接 | — |
| `setup.svg` | `stacked-join` | `p3-stacked-join-light` | 添加连接 | — |
| `setup.svg` | `stacked-own` | `p3-stacked-own-light` | 添加连接 | — |
| `setup.svg` | `stacked-secure` | `p3-stacked-secure-light` | 添加连接 | — |
| `setup.svg` | `stacked-ready` | `p3-stacked-ready-light` | 添加连接 | — |
| `setup.svg` | `ready` | `p3-connection-ready-light` | 添加连接 | — |
| `setup.svg` | `relay-login` | `p3-connection-login-dark` | 添加连接 | — |
| `source-panel.svg` | `dispatches` | `source-panel` | Claude | — |
| `source-panel.svg` | `history` | `dispatch-states` | Claude; `--viewport=1280x1200` | — |
| `source-panel.svg` | `platform` | `source-panel` | Anthropic | `Anthropic` |
| `task-detail.svg` | `running-multi-turn` | `timeline-multi-turn` | Review project configuration and verify the requested changes; `--viewport=1280x1080` | — |
| `task-detail.svg` | `needs-you` | `timeline-pending` | Review project configuration and verify the requested changes | — |
| `task-detail.svg` | `failed-turn` | `task-states` | Failed task | `Failed task · 打开执行时间线` |
| `updates.svg` | `available` | `updates-available-panel` | App updates | — |
| `updates.svg` | `installing` | `updates-installing` | App updates | — |
| `updates.svg` | `settings` | `updates-settings` | selector `.settings-about`; `--viewport=1280x1400` | — |

[1] `Activity` and `Google` are `SingleChoice` radio items. SDG 0.3.0 `--click` addresses buttons only. These two states require role-aware fixture preparation before capture; their source scenarios are `coordination-gap` and `accounts`. The default scenario alone does not select that radio item.

SDG 0.3.0 calls the adapter's `ready` hook before `--click` actions and has no post-click readiness hook. For `coordination/unavailable`, browser acceptance waits for `SCENARIO_BOARD_UNAVAILABLE` after `Open board` and captures before retrying. The adapter cannot reproduce that wait. Portrait folded captures also wait for the requested wing's positioned nodes to disappear and orientation to settle after the keyboard action; scenario readiness alone does not cover that transition.

Full-content drawings in `agent-panel/overview`, `coordination/current`, `settings/about`, `settings/display` and `source-panel/history` can exceed the implementation's scroll viewport. Compare captures visible content; inspect the remaining content during browser acceptance. `approval/model-effort` includes portalled picker and menu drawings outside the main dialog shell; the region capture covers the main dialog. Portrait folded states expose their collapse controls through keyboard focus during browser acceptance.

The adapter uses DOM text extraction. Pet preview atlas labels are decorative image content inside `aria-hidden` previews; they are reviewed as shapes in the overlay.

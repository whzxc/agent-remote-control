# Design sources

[UI conventions](ui.md) · [Asset mapping and status](design-assets.md) · [Acceptance](acceptance.md)

TSX sources in `design/` define ARC's visual direction. React implementations follow approved sources. [UI conventions](ui.md) owns behavior, data projection and layout logic.

The [SDG asset rules](https://github.com/whzxc/svg-design-gallery/blob/main/docs/asset-rules.md) govern asset placement, ownership, naming, fixture separation and lifecycle. The [toolkit contract](https://github.com/whzxc/svg-design-gallery/blob/main/docs/design-toolkit.md) governs authoring, rendering, checks and viewer commands. Follow the asset rules when local guidance conflicts. Use the global SDG CLI **>=0.5.0**, as required by `sdg.config.mjs`; ARC does not depend on the toolkit at runtime.

## Presentation forms

ARC uses warm neutral surfaces, restrained semantic tints, rounded shared controls and Lucide icons. `design/tokens.css` owns the palette, typography and dimensions; `ui/tokens.css` is the runtime sheet. Both themes use the same declared forms. Add a token for a value shared or semantically named across sources; keep single-use local dimensions in the owning part. Keep the homepage's ARC mark, earcup connections and topology, and the tile's neutral shell with a separate state tint. Phase labels use shared typography with semantic color on the label span.

The desktop targets are macOS and Windows. Headless Linux has no product UI. Each source uses one representative language; English and Simplified Chinese content follow its mapped fixture. Frame dimensions and capture viewports are declared in TSX. Landscape homepage forms use 1280×800, portrait forms use 640×800, expanded-single-task uses 640×1000, and `homepage-topology-mobile/narrow-two-tasks` uses 390×844. Portrait viewports at most 520 CSS pixels wide omit visible node labels and retain accessible names. Wider portrait forms retain labels. Rails reserve node and quota-ring space; the date/time header stays centered.

The default exports declare the maintained presentations. Apply the toolkit's single-part and multi-part frame naming rules when the owning family is reviewed, updating all references together. Task bubbles retain compact, standard, detailed, row and row-attention; the Board header retains active and idle. Portrait topology retains expanded-empty, expanded-single-task, expanded-two-tasks, sources-compacted, sources-folded and agents-folded. Setup retains standalone and nested flows, including distinct method and ready controls. AX Board retains open, closed and detail forms; detail replaces the list inside the same panel and can scroll beyond the viewport.

## Ownership and project configuration

The configured production order is `components` → `modules` → `surfaces`, using SDG default discovery. Generic controls belong to `components`; feature ownership and remaining migrations are listed in the [mapping](design-assets.md). `modules/model-configuration.tsx` owns model/effort presentation. `modules/quota.tsx` owns quota cards and readings. `modules/task-presentation.tsx` owns TaskBubble, TaskRow, StatePill and TaskMessage. `modules/request.tsx` owns request cards, sheet and inline forms, entry/unavailable states and source routing. `modules/timeline.tsx` owns timeline parts and task-detail presentation; surfaces/task-detail declares the three full-region frames and their captures. `modules/task-relationships.tsx` owns relationship labels, parent navigation, task cards, detail headers and the family composition; `surfaces/task-relationships.tsx` declares its 1140×520 region. `modules/agent-activity.tsx` and `modules/source-activity.tsx` own their task groups and row content; their task groups and row presentations are Reviewed. `modules/onboarding.tsx` owns shared setup shell/fields; `modules/welcome.tsx`, `modules/source-onboarding.tsx` and `modules/connection-onboarding.tsx` own their business presentations. `surfaces/setup.tsx` assembles the 18 full forms and owns their captures. `modules/connection-management.tsx` owns connection cards, provider/method facts and lists; surfaces/connections owns the complete dialog region and capture. `modules/board.tsx` owns Coordination Board rows, sections, recovery feedback, filters and composition; surfaces/coordination owns its four complete regions and captures. `modules/ax.tsx` owns AX status badges, entry rows and detail; surfaces/coordination-ax owns its three complete regions and captures. `fixtures/` owns extracted representative data. `art/` owns artwork and content images, with dimensions and budgets in the mapping. There are no active studies or import-direction opt-outs.

`scenes/topology-screen.tsx` and `scenes/topology.ts` remain outside the source graph and await the topology module/fixture migration. This is the current placement exception; review its helper and type-only dependencies in that scope.

`design/tsconfig.json` resolves generated declarations in ignored `design/.sdg/`. `sdg.config.mjs` owns paths and the browser fixture adapter. Generated output belongs in ignored `output/design/`. `TopologyScene` accepts fixture coordinates inside `data-free`; runtime geometry remains owned by `ui/topology/solve.ts`.

## Review and adoption

Codex proposes and implements each batch. The control source (Claude) reviews ownership, mappings and both-theme renders. The user approves visual changes in the gallery. Claude approves structural-only batches under the pixel and crop/part-frame criteria below. A crop or part frame is structural only when every existing render, including its parent, is pixel-identical in both themes and every differing pixel belongs to one of these classes: (a) imperceptible, channel delta at most 2 with no count limit; (b) antialiasing on shape, glyph or corner edges, below 0.5% of the crop area with maximum channel delta at most 48, only when the part's element, layout and color snapshots match the parent region; (c) boundary bleed from parent-scene content outside the part, including connectors, neighbors or seams, within 2 device pixels of the crop edge; (d) bitmap resampling, any channel delta inside the box of a raster image element (img or SVG image), only when snapshots match and below 0.1% of the crop area. Report per-frame class counts in the comparison output. Any geometry or snapshot mismatch, other difference, shifted box, changed fill or token, or missing or added element inside the part stops the turn with a gallery URL. Otherwise continue. Other visual differences or open decisions go to the user's gallery review. Record current review/adoption status and remaining gaps in the mapping; keep batch history, check results and decision logs outside repository documentation.

Work on one cohesive family, feature module or composed surface at a time. The active scope and queued responsibilities are in the mapping. Before editing, render affected frames from the batch base commit in a disposable copy outside the checkout and report its path. After editing, run `sdg check`, render and inspect every affected frame in both themes, and compare each with its baseline. Token edits include all dependent frames. A structural comparison uses decoded pixel equality, including dimensions. Implementation comparison uses the fixture/capture adapter described in the mapping.

Commit the scoped changes with a single-line Conventional Commits subject and inspect `git show --stat HEAD` for unrelated files. For visual differences or open decisions, open `sdg open <lane>/design --port=<free-port>` and provide the gallery URL; do not use port 4310. Keep review evidence in ignored output or an external disposable directory. Update current mapping/status at each batch boundary. Implementation edits and runtime acceptance require their own assigned scope.

## Implementation checklist

- Size shared controls through their size variables, such as `--icon-button-size`. A width or height override leaves the control's minimum size in place and distorts its shape.
- Make each surface rule win over generic panel rules, such as `.elastic-panel .dialog-header h2`. A text width difference in `compare` usually means a font rule lost.
- Remove redundant base definitions from `ui/tokens.css` when `design/tokens.css` owns the same token. Keep the scoped `data-surface="mcp"` overrides that map semantic tokens to host colors.
- Avoid `font-variant-numeric` and `letter-spacing` values that the source does not use, because they change text widths.
- Panel forms have no stroke. A leftover 1px panel border shifts every text by 1px.
- Review the overlay for shapes, fills, icons and elevation, because `compare` reads text only.
- Delete superseded rules, classes and visual statements in [UI conventions](ui.md) in the same change.

## Migration

- A surface without an approved source keeps its current implementation. Its next visual change starts by writing its source.
- `ui/tokens.css` is the runtime token sheet. Migrating a surface aligns the tokens it uses with `design/tokens.css`.
- Migrating a surface deletes its visual statements from [UI conventions](ui.md) and keeps its behavior statements.

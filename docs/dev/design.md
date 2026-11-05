# Design assets

[UI conventions](ui.md) · [Acceptance](acceptance.md) · [Development](development.md)

SVG assets in `design/` define how ARC looks. React implementations follow them. [UI conventions](ui.md) keeps the behavior, data projection and layout logic that a static asset cannot express.

## Layout

- `design/tokens.css` holds color, type, radius, size and shadow tokens for the light and dark themes. It is the token source for assets and for the runtime sheet.
- `design/components/<name>.svg` holds one shared component. Each top-level `data-component` group in the file is one presentation form.
- `design/surfaces/<name>.svg` holds a panel, dialog or page composed from component instances. Each declared form is a `data-part="frame-<form>"` group whose first component is the surface shell.

## Presentation forms

- The user declares the forms each asset contains, such as the three task-bubble densities.
- Draw only declared forms. Do not add frames for combinations of theme, width, locale or interaction state.
- Themes come from tokens. Every asset renders in both themes without extra frames.
- Each asset shows one representative language.

## Asset format

- Each file is a standalone SVG with numeric `width`, `height` and `viewBox`. A `data-canvas` rect paints `var(--canvas)` behind the content.
- `npm run design -- sync` writes the region between `<!-- design:tokens -->` and `<!-- /design:tokens -->`. Do not edit that region by hand.
- Paint through tokens in `style`, for example `style="fill:var(--surface)"`. Literal colors are allowed only inside a `data-brand` group.
- A tinted surface uses the token color with `fill-opacity`. A group can set `color:var(--token)` so its children paint with `currentColor`.
- Elevation uses `style="filter:var(--elev-md)"`. The sync step derives the `--elev-*` filters from the `--shadow-*` tokens.
- Text `y` is the vertical center, because the token region sets `dominant-baseline: central`. Set `font-size` through a `--text-*` token and `font-weight` in `style`. Add `class="mono"` for monospace text.
- Geometry stays literal. Corner radii and heights follow the radius and size tokens.
- A form or instance is `<g data-component="<name>" data-form="<form>" transform="translate(x y)">` with local coordinates. Its first `rect` child is the container.
- Icons are `<g data-icon="<lucide-name>">` groups with Lucide geometry. They keep a 1.75px rendered stroke.
- Form labels and other annotations use `class="note"` and stay outside component groups.
- An asset may animate with CSS or SMIL to show timing and easing. Interactive behavior stays in [UI conventions](ui.md).

An instance matches its form's container height, radius, fill, stroke and elevation. It uses only text styles that the form uses. Width and content may vary. A form whose container rect carries `data-fluid="height"` may also change height with its content.

## Workflow

1. Start from the user's request and the matching `accept:ui` fixture data.
2. Draw or update the asset. Use `npm run design -- measure` for text widths.
3. Run `npm run design -- check` and fix every problem.
4. Run `npm run design -- render` and review both theme renders.
5. Show the renders to the user and iterate until they approve the asset.
6. Implement with the shared React components and runtime tokens.
7. Run `npm run design -- compare` against the matching fixture and fix the reported differences before reporting.

An asset frame uses the language and text of its fixture, including dates under the fixed 2026-01-01 fixture clock. Generate repetitive geometry with a script kept outside the repository, measure text with `measure`, and copy icon geometry from Lucide. A drafter may propose forms. Approving the renders approves those forms. Drafting, `check`, `render` and implementation may run in a coding lane. `compare` and `accept:ui` run in the main checkout after landing.

## Implementation checklist

- Size shared controls through their size variables, such as `--icon-button-size`. A width or height override leaves the control's minimum size in place and distorts its shape.
- Make each surface rule win over generic panel rules, such as `.elastic-panel .dialog-header h2`. A text width difference in `compare` usually means a font rule lost.
- Remove a runtime token from `ui/tokens.css` when `design/tokens.css` defines the same name, because the runtime sheet loads later and wins.
- Avoid `font-variant-numeric` and `letter-spacing` values that the asset does not use, because they change text widths.
- Panel forms have no stroke. A leftover 1px panel border shifts every text by 1px.
- Review the overlay for shapes, fills, icons and elevation, because `compare` reads text only.
- Delete superseded rules, classes and visual statements in [UI conventions](ui.md) in the same change.

## Commands

```sh
npm run design -- sync
npm run design -- check [asset...]
npm run design -- render [asset...]
npm run design -- gallery
npm run design -- measure "<text>" [--size=14] [--weight=400] [--mono]
npm run design -- compare <asset> --frame=<part> --scenario=<fixture> --region=<name> [--click=<button>...] [--viewport=1280x800]
```

`check` loads every asset in Chromium. It reports stale token regions, literal colors, undefined tokens, overlapping text, text outside the canvas, text overflowing its container, unknown forms and instances that differ from their form. A nonzero exit means the asset is not ready.

`render` writes `output/design/<path>-light.png` and `-dark.png` at 2x. `gallery` writes `output/design/index.html`, which shows every asset with a System, Light and Dark switch.

`compare` renders one asset frame, the `data-part` group named by `--frame`, next to an `accept:ui` fixture in the fixture's theme. `--region` names the implementation region or dialog to capture, and each `--click` activates a button by accessible name first. It reads one text per rendered line, including the placeholders of empty fields, skips text scrolled or clipped outside the region, and pairs texts by content. It reports anchored-edge, vertical-center and width differences above 2px, plus texts missing from either side. It does not compare shapes, so review the overlay as well. `output/design/compare/<asset>-<frame>-<fixture>/index.html` shows the design, the implementation and their overlay. A nonzero exit means the implementation does not match yet. It starts Vite, so it runs only in the main checkout.

## Migration

- A surface without an approved asset keeps its current implementation. Its next visual change starts by drawing its asset.
- `ui/tokens.css` is the runtime token sheet. Migrating a surface aligns the tokens it uses with `design/tokens.css`.
- Migrating a surface deletes its visual statements from [UI conventions](ui.md) and keeps its behavior statements.

## Limits

- Assets name the system font stack. Linux renders use fallback fonts, so final visual review runs on macOS.
- SVG has no layout engine. Positions are explicit, and a geometry change to a form requires updating its instances. `check` lists the instances that no longer match.
- Static assets do not show hover response, focus movement, dragging, springs or interruption.

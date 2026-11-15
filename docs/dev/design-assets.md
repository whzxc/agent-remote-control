# Design asset notes

[Design governance](design.md) · [Implementation bindings](../../design/implementation.json)

`design/implementation.json` is the sole implementation counterpart record. Sources are current or proposed. Current frames represent reachable implementation states; proposed frames name an active review scope.

## Open proposals

- `surfaces/permissions.tsx` / `readiness`: review the permissions workspace composition using the shared centered Panel.

## Retained exceptions

- Component and module specimens may rely on their containing surface's capture. Surface fixtures and capture targets remain declared in TSX; `adg.config.mjs` owns preparation through public controls.
- The model picker menu is portaled outside its dialog capture. Review its overlay separately from the dialog region.
- Browser update fixtures disable the desktop-only update check.
- Pet atlas labels are image content inside an accessibility-hidden preview.

## Known gaps

- Device topology has no retained full-scene asset. A replacement must use current solver geometry and controller disclosure; existing browser scenarios cover the implementation.
- Remaining combined component specimens need review for distinct-appearance coverage.
- Remote task cards have snapshot history. Remote timeline, response forwarding, account/quota inventory and transfer controls remain unavailable.
- Loading, failure, not-found, busy, pagination, Board detail/event rows and populated hosting forms without declared sources need coverage in their owning family.
- Shared controls still have geometry, typography and state differences: Button wrapping, Input error spacing, CopyField masking/loading, SearchInput entered-value color, Notice spacing, CardHeader layout and settings section typography. Reconcile each with the current implementation.
- Theme swatches and isolated AX badges require fidelity review. Shared runtime CSS still contains local dimensions instead of some declared control tokens.
- Feature CSS includes paint and typography owned by shared components. Migrate repeated controls and record exact canvas exceptions in the style policy.

## Image dimensions and budgets

Budgets apply per file in `art/`. Owners downscale raster images before importing them. Brand SVGs may preserve their internal coordinates; display size belongs to the consuming part. These are maintenance limits, not additional presentation forms.

| Class / owner | Files | Display dimensions (CSS px) | Per-file budget | Current gap |
| --- | --- | --- | --- | --- |
| Brand registry / brand icon family | Registry SVGs listed below | BrandMark: 40×40 default; callers use 9, 20, 22, 24, 28, 36 and 38px squares. AgentIcon: 48×48 default; inner mark is round(outer size × 28/48) with rings or × 38/48 without rings. | 12 KiB SVG | Runtime markup mapping and provider states remain in implementation scope. |
| Catalog logos / onboarding | Gemini, Grok, Microsoft Copilot, GitHub Copilot and Qwen Code SVGs | 24×24 | 12 KiB SVG | Onboarding owns their surrounding presentation. |
| Source badge / task presentation, timeline and connection management | `source.svg` | 9×9 inside a 13×13 badge; 12×12 in the timeline source chip; 18×18 in connection identity; 24×24 in the source connector summary | 2 KiB SVG | Connection identity uses the same source artwork; runtime provider mapping remains in implementation scope. |
| Homepage ARC / topology | `arc-mark.svg` | 240×240 default drawing in TopologyMark, scaled by its size | 2 KiB SVG | Current topology artwork. Faults recolor the affected arcs while preserving their geometry and the node fills. |
| Setup ARC / welcome | `setup-arc.svg` | 64×64 | 2 KiB SVG | Welcome owns its surrounding presentation; current module. |
| Pet previews / pets | `pet-clawd.svg`, `pet-codex.svg`, `pet-synthetic1.svg`, `pet-synthetic2.svg`, `pet-synthetic3.svg` | 72×72; intrinsic viewBox 192×192 | 4 KiB SVG | Review with pets module. |
| Grok Bot / connection onboarding | `grok-bot.png` | 24×24; raster 48×48 for 2× density | 8 KiB PNG | 3,996 bytes; within budget. |

### Artwork inventory

Each file inherits its display rule and per-file budget from its class above. Intrinsic dimensions below are SVG viewBox coordinates or raster pixel dimensions, not display dimensions. Display rules are tracked in the class table.

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

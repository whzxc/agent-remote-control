# Layer placement and sizing proposal

Status: approved

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

[UI conventions](ui.md) · [Design sources](design.md) · [Portrait layout](portrait-layout.md)

## Problem

Panels, dialogs and popovers decide their own position, size, motion and dismissal. The same kind of interaction opens near its trigger, at the viewport center or against a window edge, depending on which component opened it. Sizes come from per-surface literals, so short content can fill the window while dense content can open small. This proposal replaces those local decisions with one layer model.

## Current implementation

Landscape forms at 1280×800. `ElasticPanel` (`ui/components/ElasticPanel.tsx`) implements every panel and dialog form; the workspace sheet lives in `App`.

| Surface | Opened from | Position | Width | Height |
| --- | --- | --- | --- | --- |
| Settings, Devices | Navigation capsule | Sheet against the left edge | 720 | Full window |
| Relay hosting | Navigation capsule | Sheet against the left edge | 744 | Full window |
| Platforms, Permissions, Pets, MCP hub | Navigation capsule | Sheet against the left edge | 960 | Full window |
| Connections, Setup, Welcome | Hub arc, hub dot, automatic | Viewport center, morphs from the trigger | 680 | Content; setup steps morph the shell |
| Agents management | Hub dot | Viewport center, morphs from the dot, draggable | 720 | Content |
| Coordination Board | Board header | Viewport center, draggable | 820 | Content |
| Hub recovery | Hub arc | Viewport center | 380 | Content |
| Agent, platform and task panels | Agent-side node | Right edge, vertical center follows the node | Remaining scene width, at least 400, no maximum | Content, or full available height for task details |
| Source and connector panels | Source-side node | Left edge, vertical center follows the node | Same as Agent panels | Same as Agent panels |
| Child dialogs of a panel or sheet | Button inside the parent | Parent center, clamped to the viewport; the parent is hidden; draggable | 440 to 720 | Content |
| Connector removal, MCP removal, tool list | Button inside the parent | Viewport or parent center | 800 (unset default) | Content |
| Add connection from Setup | Setup | Viewport center; parent scaled and lifted behind it | 680 | Content |
| Add connection from Connections | Connections | Replaces Connections, which reopens with a new morph afterwards | 680 | Content |
| OAuth approval | Automatic for any pending request | Viewport center, draggable | 440 | Content |
| Update | Navigation capsule | Popover above the capsule | Up to 520 | Up to 650 |
| Global feedback | Any caller of `notify` | Top center | Up to 760 | Content |

Related defects:

- Morphing depends on the trigger: centered dialogs and dialogs opened from `.graph-node`, `.hub-entry` or `[data-timeline-anchor]` morph from it, while the rest fade in.
- A pointer release on a backdrop over a panel anchor closes the layer and then clicks that anchor.
- Mutual exclusion is spread across independent stores and effects, including `agentPanel`, `ingressPanel`, `onboarding`, `connectionSetup`, `connectionSwitch`, `navigation`, `boardOpen` with `centerReturn`, `updates.panelOpen` and component-local flags.
- Motion uses two duration tokens and one easing token, while CSS and `ElasticPanel` hard-code durations from 140ms to 420ms, five easing curves and an overshoot curve.

## Layer model

- ARC MUST classify every overlay as exactly one kind: panel, dialog, transient or toast.
- A panel is nonmodal working space: workspaces and node panels.
- A dialog is a modal task: confirmation, edit form or multi-step flow.
- A transient layer is a popover, menu, select list, tooltip or hover preview.
- A toast is a short message about something outside the current layer.
- At most one panel MUST be open.
- Opening a panel MUST replace the open panel.
- Navigation from one panel to another MUST keep a Back control to the previous panel instead of closing and reopening surfaces.
- At most two dialogs MUST be stacked.
- A child dialog MUST stack on its parent and MUST NOT unmount it.
- A stacked parent MUST stay visible under the scrim and MUST NOT move, scale or hide.
- Only a user action MAY open a panel or dialog.
- System events MUST surface as Board attention, a capsule badge or a native notification.
- Welcome MAY open automatically when there are no sources and no other panel or dialog is open.
- A flow the user started MAY advance to its next step automatically, including OAuth approval inside that flow.
- External navigation from the tray or a deep link MUST NOT discard an open dialog; its target becomes attention until the dialog closes.

## Placement

- Placement MUST depend only on the layer kind, the panel side and the viewport.
- The trigger position MUST NOT change where a panel or dialog appears.
- The top line is the window's top inset: 48px on desktop windows and 20px in the browser.
- The side margin is 16px.
- The left panel slot MUST hold source-side node panels, starting at the side margin and the top line.
- The right panel slot MUST hold Agent-side node panels and task details, ending at the side margin and starting at the top line.
- The center panel slot MUST hold workspaces: Settings, Platforms, Permissions, Pets, Relay hosting, Devices, MCP hub, Connections, Coordination Board and Agents management.
- The center panel slot MUST be horizontally centered and start at the top line.
- Node panels MUST NOT follow the vertical position of their node.
- Dialogs MUST be horizontally centered on the viewport.
- A dialog's top edge MUST sit at `max(top line, 12vh)`.
- A stacked child dialog MUST use the same slot as its parent dialog.
- A dialog opened from a panel MUST use the dialog slot, not the panel's center.
- Transient layers MUST anchor to their trigger with collision handling.
- Only transient layers MAY be positioned by their trigger.
- Toasts MUST appear in one fixed region at the top center below the top line.
- Panels and dialogs MUST NOT be draggable.
- A layer MAY move after opening only when the viewport resizes.
- Below 760px wide and in portrait layouts, all panel slots MUST collapse into one full-width slot at the top line, and dialogs MUST span the viewport width minus both side margins.

## Sizing

- Panel and dialog widths MUST come from a size class token.
- Per-surface width literals MUST NOT be used.
- `--layer-s` is 400px for confirmations, single-field edits, recovery and approval.
- `--layer-m` is 560px for forms, multi-step flows and node panels, including task details.
- `--layer-l` is 720px for list workspaces: Settings, Platforms, Permissions, Pets, Relay hosting, Devices, Connections and Agents management.
- `--layer-xl` is 960px for dense workspaces: Coordination Board and MCP hub.
- Panels MAY expand to the viewport width minus both side margins through an explicit width toggle.
- Dialogs MUST NOT expand.
- Widths MUST be capped at the viewport width minus both side margins.
- Height MUST fit content.
- Height MUST be capped at the space between the layer's top edge and the bottom margin.
- Layers MUST NOT stretch to the available height when content is shorter.
- Headers and footers MUST stay fixed while the body scrolls at the cap.
- A panel's height SHOULD NOT shrink while it stays open, so filters, tabs and refreshes do not move its bottom edge.
- A view change that replaces the whole panel content MAY reset the height.
- Opening MAY wait up to 200ms for the first required data, as it does today.

## Motion

- Motion tokens MUST own every duration and easing outside the topology animator.
- `--motion-fast` is 120ms for hover, press, tooltip and toast.
- `--motion-base` is 160ms for dialog and transient entry and for content swaps.
- `--motion-panel` is 180ms for panel entry and height changes.
- Exit durations MUST be at most their entry durations.
- `--ease-enter` and `--ease-exit` MUST be the only easing curves outside the topology springs.
- A panel MUST enter with a fade and an 8px movement, and a dialog with a fade and a 6px movement.
- The movement MUST point from the trigger's center toward the layer's slot, so the layer arrives from the direction of the click.
- A layer opened without a trigger, such as by external navigation, MUST move upward from below.
- The trigger MUST only set the entry direction and MUST NOT change the final position or size.
- Transient layers MUST enter with a fade.
- Content swaps inside one layer MUST crossfade without changing the shell position.
- Trigger morphing, visual copies of triggers, automatic shell morphing on content change and overshoot curves MUST be removed.
- Infinite animations MUST only indicate a running state, with at most one per element.
- Reduced motion MUST remove movement and keep instant opacity changes.

## Dismissal, focus and feedback

- Pointer input outside a panel, dialog or transient layer MUST produce a visible response.
- Escape MUST act only on the topmost layer and MUST follow the same rules as outside pointer input.
- Outside input MUST close a layer that holds no edited input and no running work.
- Outside input on a layer with edited input MUST show a discard confirmation instead of closing.
- Edited input means changes not yet submitted; a submitted value whose attempt has finished, with any result, is clean until the user edits it again.
- Outside input on a layer with running work MUST show that work's state instead of closing.
- When running work can be cancelled, that state MUST offer to stop the work and close.
- When running work cannot be cancelled, that state MUST say that the layer closes after the work finishes.
- Running-work states MUST offer to keep the layer open, and a layer whose close was requested MUST close when its work finishes unless the user chose to keep it open.
- Confirmations and running-work states MUST appear inside the layer, replacing its footer actions, without opening another layer.
- The confirmation MUST focus the action that keeps the layer open.
- Close and Cancel controls MUST close clean or dirty layers directly.
- Close and Cancel controls on a layer with running work MUST show the same running-work state as outside input, focus Keep open, offer Stop and close when cancellable, and close when the work finishes unless Keep open withdraws the close request.
- Dismissal MUST NOT activate the element under the pointer.
- Closing a layer MUST restore focus to its trigger, falling back to the layer below it.
- Field errors MUST stay with their fields.
- The result of an action MUST appear inside the layer that started it.
- A toast MUST only report a background event or the result of an action whose layer has closed.
- A success toast MUST disappear after 4 seconds.
- An error toast MUST stay until dismissed, and an actionable error MUST also appear in Board attention.
- Copy confirmation MUST use one shared control state.
- Help on hover MUST use the shared Tooltip, not native `title`.

## Ownership

- `ui/state/layers.ts` MUST own open layers, their kind, stacking, Escape, outside dismissal and focus restoration.
- Components MUST open and close layers through that store, and existing cross-store exclusion effects MUST be deleted.
- A pure `layerFrame(kind, size, side, viewport)` function MUST own slot geometry, so it can carry `Property` tests.
- `ElasticPanel` MUST be split into Panel and Dialog shells, and `panelMorph` MUST be deleted.
- `design/tokens.css` MUST own the size class and motion tokens.
- A layer-slot surface in `design/surfaces/` MUST show the slots and representative occupants at 1280×800 and 640×800.
- Visual differences MUST go through gallery approval under [Design sources](design.md).
- After adoption, the accepted rules MUST move into [UI conventions](ui.md), superseded statements there MUST be deleted, and this file MUST be removed.

## Increments

1. Design: size class and motion tokens, the layer-slot surface, and updated panel and dialog frames.
2. Shells: `layers` store, `layerFrame`, Panel and Dialog split; every dialog moves to the dialog slot and a size class; drag, morphing and dismissal passthrough are removed.
3. Workspaces: capsule sheets, Connections, Coordination Board and Agents management move to the center panel slot with content-fit height.
4. Node panels: fixed slots and the `--layer-m` width replace node-following alignment and adaptive width, and the solver reserves the fixed width.
5. Interruptions: automatic OAuth approval becomes attention, Board-to-task uses panel Back, Add connection stacks on Connections, and external navigation respects open dialogs.
6. Cleanup: feedback channels, the shared Tooltip, motion literal removal, and the [UI conventions](ui.md) and `AGENTS.md` updates.

## ADG pilot

ARC pilots behavior governance before it moves into ADG.

- `adg check` SHOULD reject width, duration and easing literals on layer shells once the tokens exist.
- Panel and dialog frames SHOULD declare `kind` and `size`, and `adg check` SHOULD verify the rendered width against the size class.
- Compare SHOULD record the bounding box of each open `dialog` role in a fixture and check it against `layerFrame` for that viewport.
- Fixtures SHOULD check that outside pointer input on each open layer either closes it or shows its confirmation or running-work state.
- Flow storyboards that chain frames through transitions remain a later step.

# UI components

The renderer uses React in the Tauri system WebView. Rust owns configuration, connections, tasks, authentication, native windows, and updates. Vite builds the main window and usage rail; both share tokens, preferences, controls, and quota presentation.

## Layout and motion

Home defaults to the standalone ARC mark: source curves gather into a fixed left junction and dark trunk, while a green right trunk branches to Agents. Inactive and utility branches use gray dotted lines. Connection status appears at each node’s lower-right corner; Agent quota rings retain their presentation. Each side adapts its spacing to the available height without moving the junctions. Appearance settings can restore the interactive mascot with its circular hub and individual ports. Source and Agent nodes have persistent 12px secondary names with ellipsis; hover details add runtime information instead of repeating names. The compact power switch retains tactile feedback and a state transition, without lettering, an outer glow, or stars. Quota cards open from Agent nodes. The mascot has no hidden usage or GitHub actions; GitHub is in Settings → About.

Only home source, add-source, Agent, and management nodes morph into their panels. The mascot retains expressions, click effects, resisted dragging, and recoil. Workspace sheets for Tasks, Records, and Settings use a fade and slight displacement of at most 180ms. Their top header places the title on the left and width/close controls on the right. Internal steps and nested dialogs fade content without resizing animations. Back, Escape, and outside dismissal return one level, preserving parent form and scroll state; Close dismisses the current dialog flow and restores trigger focus. Grouped tooltips remain mounted while moving between triggers and animate position and content size. HoverScope uses a shared spring-driven highlight for pointer, keyboard, Radix highlighted state, and native forwarded hover. Quota popovers and rail cards continuously follow their trigger; rail docking geometry settles directly. Reduced motion removes nonessential transitions.

Tasks use compact rows with a title, project, timestamp, plain-text preview, and only running/error status. Model and reasoning effort appear in details. Details render headings, fenced code, inline code, and lists as React nodes; raw HTML is never executed. Records show time, available source names, tools/operations, and recorded outcomes. Known service messages are localized. Consecutive successful requests with the same recorded ingress and operation are grouped with a count; missing ingress identity prevents grouping. The recent count refers to the raw bounded log snapshot. Missing source names and outcomes remain unknown; logs do not supply request duration.

The macOS application menu includes Settings (`⌘,`) and Check for updates, using the current UI language. Both bring back the main window when hidden or released; update checks use the existing update dialog.

## Shared controls and styling

`ui/tokens.css` owns semantic colors, typography, spacing, radii, sizing, and shadows. `ui/style.css` styles shared controls, `ui/product.css` owns product layouts, and `ui/subscriptions/bubble.css` owns quota cards. Theme defaults to system appearance; explicit Light/Dark choices override it. Main canvases are opaque white/black. Semantic warning and brand colors remain independent of the accent.

Use the operating-system font stack, 13–14px normal text, 12px metadata, and 14px reading content. IDs and credentials use the shared monospace stack. Functional icons use shared Icon with Lucide at 16/20px and 1.75px strokes; brand marks retain their assets. Icon-only controls have accessible names.

Reuse `ui/components/ui/index.tsx` for buttons, inputs, fields, SingleChoice, switches, Dialog, Tooltip, Popover, menus, progress, notices, tables, pagination, and feedback. Group and Row arrange content only. Radix owns selection, focus, keyboard navigation, dismissal, portals, and modal behavior.

- Every single-choice field uses SingleChoice: up to five options use capsule radios when space permits; larger sets or narrow layouts use a dropdown. Preserve arrow keys, labels, disabled state, and validation.
- Forms use native form semantics, labels above inputs, and a single column except short related fields. Errors associate with fields and focus the first invalid input. Failed saves preserve the form.
- Dialogs have accessible titles, scrollable bodies, and separated footers. Add-source selection has a visible title; its configuration step also has Back and Close controls. Official setup links sit on the right of the Name label. Each provider has one credential link on the right of its first credential label; placeholders describe what to paste. Blank stored-secret fields preserve existing credentials.
- Keyboard focus remains visible. Radix traps dialog focus, dismisses the topmost layer, and restores focus. Busy operations can prevent dismissal.
- Loading, empty, stale, error, disabled, and success states reflect native responses. Missing data must not be fabricated.

## Connections, Agents, and quota

Source selection uses a compact registry picker, supports repeated sources with unique default names, and uses a light hover background. Source details precede editing. Provider, domain, credential, authentication, and tool-policy fields stay visible. Configured domains omit scheme, port, and path; the service builds the MCP URL. Saving configuration and starting the ingress retain their native lifecycle and error behavior. OAuth grants retain explicit Allow/Deny/Revoke and existing authorization boundaries.

Agent management groups installed cards and compact uninstalled rows. Installed cards retain enable switches and drag/arrow-key ordering. Versions are single-line, truncated with full text on hover. Uninstalled rows open details with official links. Discovery refreshes silently unless explicitly requested.

QuotaBubble and QuotaRing share home and rail presentation. Burn-rate labels explicitly state projected exhaustion; reset countdowns use compact units such as `5d 7h` at the right of the quota title row, with the full reset date on hover. The time-format preference applies to projected exhaustion. Meter ticks describe cycle time progress. Cycle estimates are extrapolated values from observed history, not balances or invoices; supporting details retain sample scope and limitations. Relative time follows the selected language. Existing calculations and limitations are described in [Subscription usage](subscriptions.md).

Quota details open on hover, focus, or click and stay within viewport bounds. History triggers retain a short hover delay and leave corridor. Rail secondary popovers clear the primary card when flipping sides and report rounded painted bounds for native hit testing. Native window placement, docking, transparent click-through areas, and OS menus remain Rust-owned and require separate native verification.

## Plugin usage panels

MCP Apps share QuotaBubble, semantic tokens, localized controls, tables, and Recharts trends. Account overview separates quota from local token/cost observations. The task panel groups chronological events by turn, loads original call details on demand, and preserves source limitations: context observations are not cumulative billing; tool bytes are not tokens; ambiguous calls are not assigned to requests. Unknown or partial data stays marked. Hover previews retain continuous positioning, size transitions, and shared moving highlights; disclosure content uses direct layout and simple fades.

## Responsive behavior and verification

Narrow layouts retain the topology, stack settings controls, wrap actions, and constrain dialogs and scrolling to the viewport. Verify light/dark themes, narrow windows, long localized text, keyboard traversal, nested Escape, focus restoration, and field errors. Run existing checks without adding test cases. Browser previews validate renderer behavior; installed WebView, rail, tray, and lifecycle acceptance remain separate.

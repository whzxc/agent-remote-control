# Development conventions

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

- Claude Code CLI dispatch requires explicit user authorization for the task or a clearly defined scope. Review roles, design workflows, skills, MAP entries and dispatch-policy exceptions do not grant it. Continue with the current authorized agent when that authorization is absent.
- Use the MIT license. Maintain public source and desktop artifacts on GitHub. Do not publish a public npm package.
- Assess whether commits and pushes are necessary for the task. No separate authorization is required. Commit and push directly when needed to complete the task. Respect explicit restrictions against committing or pushing, or requests to wait for review. Release tags, uploads, and public Releases require user authorization.
- Unqualified release requests select macOS ARM64 and Windows x64 only. Include both Linux architectures only when the user explicitly requests all platforms or Linux. Use `--platforms mac,windows,linux` for all platforms. Linux builds and native runtime checks run in GitHub Actions at the coordinator's exact source SHA and version. Do not prepare or check Linux tools for default desktop releases. See [Release maintenance](docs/dev/release.md).
- Agent runtimes MUST own canonical sessions, transcripts and history indexes in their native storage. ARC MUST NOT place them in ARC state or partition them by account. This applies to Codex, Claude Code, Pi and every other Agent. ARC may retain credentials, account/task associations, dispatch receipts, approval state and bounded derived observations needed for scheduling. Credential separation MUST NOT change the session store. Login, refresh and startup MUST NOT implicitly migrate or delete existing native session data.
- Codex Desktop's native login is the primary account. Other Codex credentials are secondary accounts even when selected as the default dispatch account. Secondary work MUST use its account's App Server and MUST NOT be explicitly dispatched, opened or handed off to Desktop. All Codex execution processes share the native primary home; external-token authentication remains process-local.
- Support macOS and Windows desktops and headless Linux x86_64/aarch64. Business code MUST NOT depend on other projects or personal environments. Use Tauri and Rust for the native desktop. Node/npm are build tools only. The product owns local Tunnel Client installation, configuration, and lifecycle. Use official Tunnel identity registration and servers.
- Use Git worktrees only when the dispatching task explicitly assigns a lane, and only via `npm run wt`. A lane belongs to its assigned task. Never check out, commit from, clean or remove another task's lane. After every lane commit, run `git show --stat HEAD` and confirm it lists only your own files. Lanes are for editing, building, type-checking and committing. While lanes are active, all coding happens in assigned lanes; the main checkout is only for `wt land` and acceptance. Run the app, installs and dev:isolated only in the main checkout, serially. Land via `npm run wt -- land`. Purposeful one-time state migrations are allowed. Delete old files after migration. Do not retain obsolete aliases, shims, or compatibility layers.
- The control-source MCP tools are frozen as `guide`, `query`, and `act`. Do not rename, remove, or change their parameter structures, including optional additions. Sessions with cached schemas use the query guide op for current contracts. Expose capability changes through catalog ops and guide. Do not add MCP tools or old-tool aliases. Ops may be replaced or removed directly. Errors MUST guide clients to the current contract.
- The MCP event surface is frozen as the single `notification` event with subscription parameters `{op, args}`. Do not rename it or change the outer structure, including optional additions. Disclose event ops and args through guide. The server validates, authorizes, and filters by op. Ops may be replaced or removed. Errors MUST identify the current contract. Do not retain old event names or compatibility aliases.
- Read external data using current native login and upstream responses. Do not add account, credential-expiry, or content-sensitivity checks. Do not reject reads or rewrite results based on local inference. Retain checks required for ARC's own MCP OAuth, ingress authorization, task association, and resource boundaries.
- Allow only `Contract` tests for frozen surfaces (`guide`/`query`/`act`, `notification`, CLI JSON envelopes, error codes and wire formats), `Regression` tests naming a fixing commit or observed failure, and `Property` tests for pure-computation invariants. Every test case MUST carry exactly one `// Contract: ...`, `// Regression: <commit|symptom>` or `// Property: <invariant>` comment, including Rust cases.
- Tests MUST assert observable behavior through MCP ops, CLI, management ops, exported pure functions or accessible roles/names. Never assert class names, DOM shape, computed styles, pixel constants, exact user-facing copy, internal file layouts or mock call counts.
- When an intended product change breaks a test, rewrite it at the behavior level or delete it and report which. Never align expected values with new implementation details. Delete a test that blocks a reasonable refactor instead of working around it.
- `npm test` MUST be the daily test entry point and the only automatic test suite in normal releases. This test step MUST complete within 30 seconds, including policy checks and test startup. Keep native compilation, process recovery, real-time retries and browser layout matrices outside this path. Run `npm run test:extended` or affected native cases only when runtime coverage is needed. Run browser layout fixtures through `npm run accept:ui`.
- Keep a negative case only when it protects a frozen error contract, authorization or data boundary, or reproduces an observed failure. Use one representative per failure mechanism instead of enumerating primitive-type, range and malformed-input permutations. Do not add tests of test diagnostics or timing-report formatting.
- The control source owns `tests/contract/` and `tooling/test-policy-allowlist.json`. Implementation turns MUST NOT modify either unless the dispatch prompt explicitly grants it. Exceptions require an exact file, test name, rule and reason in that allowlist.
- Acceptance MUST default to background; focus-dependent steps MUST try `screen` with `front=auto` first, then MAY use `front=always` after a bounded wait or when avoiding focus is costly, and MUST report the reason. See [Acceptance](docs/dev/acceptance.md).
- Run `npm run check:tests` before targeted tests. Both `npm test` and `npm run test:extended` run it automatically. Visual/layout correctness belongs to `npm run accept:ui` scenarios, not unit tests.
- UI/UX acceptance (layout, visual states, copy, themes, widths, panel interactions) MUST use browser fixtures only (`npm run accept:ui`, `dev:ui ?scenario=`): no `dev:isolated`, no packaged builds. When a state is not covered, add a fixture instead of falling back to a running app. Isolated-instance runtime acceptance is only for behavior fixtures cannot simulate: native windows and focus, replacement/update lifecycle, real Agent dispatch/resume, and notification delivery.
- Before a push, UI changes MUST pass `npm test` and the `accept:ui` fixture families they affect.
- Browser-only fixtures MAY run in the assigned lane with `--lane-fixtures` on a non-default port.
- Run the full `accept:ui` sweep before releases.
- A full `accept:ui` sweep is not required before every push.
- After direct Cargo builds or tests, run `npm run cache:prune` to check the compilation-cache budget.
- Commit messages MUST use Conventional Commits with an English single-line subject: `type(scope): description`. Allowed types are feat, fix, docs, refactor, test, build, ci, chore, perf, and revert. Do not write a body or rewrite history. A required Git trailer may follow one blank line.
- Keep personal paths, project names, accounts, secrets, Tunnel identities, quota details, and real task content out of the repository. Personal dispatch criteria belong in local state configuration.
- Changes to what an `arch/` diagram shows MUST update the diagram before implementation. Behavior changes need user approval of the updated diagram first. See [Architecture assets](docs/dev/arch-assets.md).
- Documentation describes current features, architecture, limits, and procedures. Do not store process records, acceptance results, decision logs, or personal environment details.

## Language and terminology

- Model-facing text and AI-maintainer text MUST be English only. Keep no Chinese copies. This includes every control-source guide and topic, catalog descriptions and signatures, schema descriptions, receipt hints, errors and correction examples, notification/event text, `docs/dev/**`, and this file.
- Product UI, promotional documentation, and end-user onboarding documentation remain localized. Preserve Chinese user input and original upstream evidence.
- Use the fixed vocabulary in [terminology](docs/dev/terminology.md). Define MUST, SHOULD, and MAY once at the top of each guide response. Use one rule per sentence.

## UI design

- TSX sources in `design/` are the visual source of truth. [Design sources](docs/dev/design.md) owns ARC's direction and review procedure; [Asset mapping and status](docs/dev/design-assets.md) owns per-part implementation mappings, adoption, review status, exceptions and remaining gaps.
- Follow the [ADG asset rules](https://github.com/whzxc/agent-design-gallery/blob/main/docs/asset-rules.md) for ownership, layering, frame names, fixtures and lifecycle. They take precedence over conflicting local design guidance. The [toolkit contract](https://github.com/whzxc/agent-design-gallery/blob/main/docs/design-toolkit.md) owns source syntax and checks.
- Layout and behavior changes MAY be implemented directly.
- The owning TSX source SHOULD be updated to match once the user accepts the result.
- New visual directions or redesigns SHOULD start in the owning TSX source.
- The user approves renders of a new visual direction or redesign before implementation.
- Use the global `adg` CLI >=0.5.0.
- `adg check` MUST pass before committing.
- Render new visual directions and redesigns in both themes for user review.
- Keep current mappings and status with each owning batch.
- `design/tokens.css` owns design tokens.
- Approved frames describe the intended result.
- `adg compare` differences are review notes, not a gate.

## UI implementation

- Use React for rendering. Radix owns interaction foundations: focus, keyboard navigation, dismissal layers, portals and modal behavior.
- Implement each design component once in `ui/components/ui/` and reuse it. Business pages MUST NOT restyle or reimplement shared controls.
- Use `SingleChoice` for every single-choice control. It shows pills for at most five options when width permits and a dropdown otherwise. Do not add standalone Select or native `select`. Preserve keyboard navigation, disabled states, and validation.
- `ui/tokens.css` is the runtime token sheet. Migrations align it with `design/tokens.css`. Manage light/dark state in `ui/theme.ts`, following the system by default.
- Use the shared `Icon` wrapper with Lucide. Retain brand-specific assets.
- Reuse `Dialog` for editing. Use native `form` with shared `Field`/`Input`. Associate validation errors with their fields. Focus the first error after failed submission. Restore trigger focus after closing an overlay.
- The homepage keeps the ARC mark, earcup connections and topology. Node panels use fixed M slots and directional fades. Hub toggles stay simple and tactile.
- Workspace panels open and close with fades and slight movement of at most 180ms. Nested views switch content without morphing the whole panel. Related tooltips remain visible while smoothly moving and resizing. Hover highlights use the shared token-driven layer.
- Preserve reduced motion, keyboard navigation, layered Escape, and focus restoration. See [UI](docs/dev/ui.md).
- Use the shared Panel and Dialog shells and the layer registry for stacking, replacement, dismissal and focus restoration. `layerFrame` owns geometry: workspaces use the center XL slot, source nodes use left M, Agent and task nodes use right M, and narrow or portrait viewports collapse the slots. The trigger sets entry direction only.
- Panels fit content, cap at the bottom margin and retain their largest height while open. Headers and footers stay fixed; the body scrolls. Do not add node-following positioning, dragging, shell morphing or trigger copies.
- Capsule entries and topology nodes are panel switchers. Switching replaces clean panels; unsaved input or running work shows the in-footer safe choice. Only the topmost layer handles Escape or outside input, and dismissal consumes the click. A submitted, finished attempt is clean until edited again.
- Only user actions open panels or dialogs, except the empty initial welcome and advancement of a user-started flow. Pending OAuth and deferred external navigation belong in Board attention. Child dialogs keep their parents mounted, visible and stationary; at most two dialogs stack.
- Action results stay inside their initiating layer. Toasts are for background or closed-layer results, success lasts 4 seconds, errors stay until dismissed, and actionable errors also appear in Board attention. Hover help uses shared Tooltip. Design tokens own motion durations and easing; reduced motion removes movement.
- Experimental feature switches MUST only enable or disable features. Enabled features with configuration or interactive controls MUST expose their entry in the shared bottom-left navigation capsule. Keep their configuration and actions behind that entry; do not embed them in Experimental or add separate floating launchers.

## Documentation layers

- Promotional: keep README.md and README.zh-CN.md short and centered on Claude + Codex Loop and ChatGPT Chat + Codex.
- Onboarding and guides: docs/getting-started.md, concepts.md, guides/, auto-setup.md, faq.md, installation.md, and story.md have English primary files and complete matching Chinese versions under docs/zh-CN/. Keep them synchronized.
- Reference: docs/reference/ is English only. It owns precise contracts for tools, Agents, CLI, OAuth, Linux, and subscriptions.
- Maintainer: docs/dev/ is English only. It describes development, releases, architecture, UI and design sources. Internal lifecycle belongs in architecture.
- Organize user guides by task. Use short sentences and lead with actions. Collect real limitations at the end under Limits or the localized equivalent. Avoid repeated defensive explanations.
- Current source, cli help, and cli guide are authoritative. Path changes MUST update internal links, application/CLI URLs, and README Agent prompts. cli guide embeds docs/reference/cli.md.

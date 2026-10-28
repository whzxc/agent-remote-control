# Homepage pets

ARC bundles no pet artwork. The Pets sheet links to community packages and imports them through local management operations. Pets are a homepage topology decoration, on the node stacking layer. Sheets and panels cover them. Task bubbles retain information and task ownership.

## Packages and storage

A Codex Pets package contains `pet.json` and the single image named by `spritesheetPath`. The manifest requires a nonempty `id`. `displayName` and `spriteVersionNumber` are optional; a supplied version must match the image. Cells measure 192 × 208. V1 is 1536 × 1872 (8 × 9); v2 is 1536 × 2288 (8 × 11). Rows 0–8 are idle (6 frames), running right (8), running left (8), waving (4), jumping (5), failed (8), waiting (6), working (6), and review (6). V2 rows 9–10 contain sixteen look directions.

`pets.list`, `pets.asset`, `pets.install`, and `pets.import` are local management operations backed by Core. They do not extend control-source MCP tools or events. Core verifies HTTPS and exact download hosts, rejects redirects, caps transfer and expanded package bytes at 25 MB, decodes the atlas, and requires supported dimensions. ZIP files contain exactly two root files; paths, duplicates, directories and symlinks are rejected. Archives are read in memory and only validated files are written. The import HTTP body allows base64 overhead without changing other request limits.

For codex-pets.net, Core resolves the exact ID through the search API, downloads its ZIP, and compares the package with `validationReport`. For codexpet.top, Core uses the awesome-codex-pet install manifest and verifies both file sizes and SHA-256 digests before reading submission metadata. Other sites, including openpets.dev, use ZIP import. The publisher may update between requests; hash mismatch fails the installation without replacing installed files.

ARC stores content-addressed packages under its state directory's `pets/` folder using staged atomic renames. `source.json` records site, original page URL, author, license, attribution, file SHA-256 values and installation time. Missing publisher metadata stays missing. The UI shows it as unavailable, without inferring rights. Core also validates and lists `~/.codex/pets` read-only. Invalid local packages appear as errors. ARC never writes into the Codex directory.

## Binding and presentation

Show pets defaults off. `arc.pets.show` and `arc.pets.assignments` use existing Core-backed preferences. Binding keys identify control sources and Agents, with optional brand defaults. Claude sources and Claude Code use Claude-maiden by default; ChatGPT and Codex use GPT Dragon Girl; others use Maid DeepSeek Whale and show their participant name. These defaults resolve only installed packages. Sub-accounts have no separate binding.

The sheet reuses shared switches, SingleChoice, inputs and buttons. Previews load only validated local atlases. Recommendations remain links until the user installs them. Asset rights remain with original authors; the UI states personal, non-commercial use.

Topology owns anchor geometry in both orientations. Drag positions exist only in renderer memory, stay below the title strip and never reorder tasks. Clicking a participant waves with a brief line. Dragging uses the waiting row; releasing falls, lands, then returns to the post. Speech is limited to one line per pair per 30 seconds.

Frame animation uses CSS `steps()`, with a slower idle cadence when no task runs. Movement alone schedules animation frames. Hidden/minimized windows suspend motion and reduced motion uses static frames. Native visibility reads are limited to visibility/resize events. Assets are fetched once per renderer and shared by package key.

## Limits

No assets, display mode, sound, package code, automatic downloads or persistent pet positions are included. ZIPs with wrapper directories must be repackaged with the two files at the root. Local Codex packages with unsafe filenames or symlinks are unavailable. Recommendations without installed assets show a generic icon; author and license fields cannot be shown until the publisher supplies them with an installed package. Package deletion uses the owning package directory outside this sheet.

## Relay choreography

`ui/pets/relay.ts` is a pure projection of unified execution states and observed transitions. `PetLayer` reads tracked activities, `taskExecutionModel`, resolved pending interactions and dispatch records. It matches each dispatch to the executing turn and uses `sourceId` for the source participant. Sub-accounts provide launch coordinates, never another pet identity. Task pet clicks call the same task-panel selection as the task bubble. Hidden queue members anchor at their existing aggregate bubble; collapsed branches fall back to the Agent node. Pets never expand queues, rewrite task order or change execution state.

Stable intent identities deduplicate repeated observations. Dispatch waves and throws a card along a bounded arc; the Agent catches it. A new running turn creates a task pet at the executing account node, carries a card to the bubble and uses working row 7. Pending input uses waiting row 6; unknown evidence uses review row 8. A running phase lasting at least 90 seconds produces one urge intent for that phase. Terminal transitions hand the card from the task to the Agent and then back to the source, green for done and red for failed or interrupted. A pass review triggers a jump and thumbs-up; rework sends the card to the Agent again. Unavailable review reads never alter execution evidence. Reviews are read through the existing local endpoint every 15 seconds while pets are enabled, the window is visible and terminal tasks remain tracked; no review or task writes occur.

The newest observed relay pair remains resident, including the latest successful dispatch record after renderer recreation. Other participants and task pets leave after 60 seconds idle, with a two-second return period. Task pets have no independent population cap; existing activity retention still determines available tasks. Drag offsets are transient. Speech cooldown is shared by both participants and all task pets of a source/Agent pair.

`app.snapshot.model.pets` reports `petCount`, `animatedPetCount`, `taskPetCount` and `movingCardCount`. Counts describe mounted pets with available assets and anchors. Hidden or minimized windows and reduced motion report zero animated pets. CSS owns atlas frames; animation frames run only for moving pets or flying cards. Discrete choreography boundaries use timeouts. The atlas must be static PNG or WebP so intrinsic file animation cannot bypass visibility and reduced-motion controls.

Browser scenarios are `pets-idle`, `pets-relay`, `pets-done`, `pets-failed`, `pets-dragged`, `pets-waiting` and `pets-settings`. Fixture code generates geometric v1/v2 atlases on a canvas and supplies local in-memory package metadata. The dragged fixture starts a participant in an offset waiting pose; the production pointer handlers remain available for later interaction checks. Fixtures are development-only and include no third-party artwork. They support later browser acceptance in both topology orientations; native minimization and real downloads require separate explicit runtime verification.

# Release maintenance

[Development](development.md) · [Installation](../installation.md)

Public source and artifacts live in whzxc/agent-remote-control. Formal Git tags and GitHub Releases hold installers, updater archives, latest.json, Homebrew Cask, and checksums. No public npm package is published. Commit/push as authorized; tags, uploads, and Releases require explicit authorization. Building does not require a tag or remote commit.

## Prerequisites and signing

The default release builds macOS ARM64 and both Linux architectures on the Apple Silicon Mac coordinator, plus Windows x64 on the exclusive on-demand worker. GitHub Actions is not used for release builds. The coordinator requires Node.js 24.12+, Rust from rust-toolchain.toml, full Xcode 26+, uv, npm dependencies, and authenticated gh for formal publication. Linux-only builds do not require signing keys.

Updater Minisign keys MUST match desktop/tauri.conf.json's public key. Lookup order:

1. TAURI_SIGNING_PRIVATE_KEY: contents or an existing file path.
2. TAURI_SIGNING_PRIVATE_KEY_FILE: an existing key file.
3. ~/.tauri/agent-remote-control.key.

Encrypted keys also use TAURI_SIGNING_PRIVATE_KEY_PASSWORD. Keys stay outside the repository and on the Mac. Scripts never generate, move, or print them. Releases and rehearsals containing mac or windows require the updater key. Windows builds unsigned NSIS installers and rejects signing secrets; the Mac signs the collected EXE. Authenticode is not configured. Minisign is independent of macOS code signing.

Packaged macOS builds use the fixed self-signed identity from tooling/macos-signing.mjs. APPLE_SIGNING_IDENTITY may select only that identity or its fingerprint. Missing certificate/private key, ad-hoc selection, or another identity fails without selecting a company Team. Package checks validate Desktop/Core/screen-helper certificates and identifiers. Keep the original certificate and private key in the Mac keychain; do not regenerate a same-name certificate or export it to workers or GitHub Secrets. Hardened runtime is enabled; Apple notarization and timestamping are not used. First-launch Gatekeeper restrictions are described in Installation.

Production identifiers are com.whzxc.agent-remote-control, .core, and .screen; development uses .dev. Recheck system permissions after identity changes. Updater signatures do not establish OS code-signing identity.

## Local Linux prerequisites

```sh
npm run release:linux:setup
```

This installs the latest supported major versions of cargo-zigbuild, Zig and Lima under release-artifacts/.linux-tools, verifies Lima's release checksum, installs the two GNU Rust targets for the selected stable toolchain, and creates the project-local Ubuntu 24.04 validation VM. Rosetta must already be installed through macOS; setup does not accept a license. Lima state is under release-artifacts/.l and mounts only release-artifacts/.linux-validation. The VM has x64 glibc cross-runtime libraries and readelf. Linux builds run on the Mac, not inside the VM. The VM runs ARM64 binaries directly and x64 binaries through Rosetta's Linux translator. Version and CLI-help execution checks use the actual compiled ELF binaries. A stopped project VM is started for validation and stopped afterward only if that run started it. An already-running validator is preserved.

Linux uses the same native manifest, locked dependencies, release profile, archive names, executable, LICENSE, skills/arc-setup, licenses, and installer-script inputs as the former CI jobs. cargo-zigbuild targets GNU/Linux with an explicit GLIBC 2.28 baseline; ELF architecture, executable type, required GLIBC symbol versions, actual --version, and CLI help are checked before packaging. This preserves the GNU installer contract and supports an older glibc baseline than Ubuntu 24.04 native linking. Artifact bytes differ from native CI builds; byte-for-byte reproducibility is not claimed. Both architectures run clippy with Zig's C toolchain.

Cargo targets live beneath the real path of the existing target cache: target/linux-x86_64 and target/linux-aarch64. The target symlink/cache configuration remains authoritative, including external SSD placement. Architectures have separate host/build locks so they compile concurrently. Existing cache pruning covers these nested directories. Setup tools, ordinary source clones, and compiler caches persist across rehearsals.

## Tests and passing-result cache

```sh
npm test
```

A successful npm test automatically records a pass outside release. It runs policy checks, the Rust library suite, the Node suites including release logic, and cache pruning before recording. Dirty-source tests still run but never create a reusable pass. A failing command never records a pass.

The cache is keyed by HEAD's Git tree, a clean-worktree check before and after tests, actual Node/npm/Rust/Cargo versions, host/SDK, toolchain and lockfiles, installed dependency lock metadata, compiler environment, and hashed user/project build configuration. A different commit with an identical tree may reuse a pass; any changed input invalidates it. Secrets from configuration are only hashed, never stored in receipts. Tests use the fixed development version 0.0.0 inside and outside release; packaging overrides cannot change the test environment. Artifact validation separately checks the requested release version.

Passes are local JSON receipts under release-artifacts/test-cache/. npm run release automatically skips tests only when the exact inputs already passed. Otherwise it runs and records them. --skip-tests remains an explicit override and never manufactures a pass. Tests and platform builds run concurrently, all settle before verification/publication, and any failure blocks publication. Resume uses its verified publication checkpoint and does not run tests or builds.

## Commands and publication boundaries

```sh
npm run release
npm run release -- --version X.Y.Z
npm run release -- --skip-tests
npm run release -- --platforms mac
npm run release -- --platforms windows,linux
npm run release -- --resume release-artifacts/vX.Y.Z-<suffix>
```

Use a clean main checkout that is not behind its remote. Preflight validates source, signing, branch, and publication permissions and selects a version newer than public releases. ARC_BUILD_VERSION injects it into frontend, Core, Desktop, and installers; source placeholders remain 0.0.0. No version-only commit is created.

The coordinator freezes the same full SHA for all ordinary clean source clones. Windows readiness starts at the beginning of preflight and overlaps tests and local builds. macOS, Windows, and both Linux architectures build concurrently. Source changes during the run fail closed. A unique release-artifacts/v<version>-<suffix> directory holds artifacts and receipts. The coordinator verifies the complete selected platform set, embedded versions, updater signatures, and checksums before tagging or pushing. Formal publication then atomically pushes main/tag, uploads a draft, checks its exact remote inventory and digests, publishes, and reads back public latest.json. A rehearsal never enters these mutation stages.

Windows connection/SCNet checkout declarations come from the installed @whzxc/work profile located through enjoy runtime; fleet connections remain in the Enjoy profile. Before acquisition, check SCNet source locks and require both mutually exclusive workers to be stopped and unowned. Preserve and report an occupied or already-running worker. Use enjoy infra execute with proxmox.worker.start/inspect/stop, target k12, a unique owner, and --fresh. Poll until both ssh_reachable and ready are true before Windows SSH. Check guest SCNet locks and build processes again before building. Shutdown requires this run's initial stopped state and retained ownership, including ambiguous start responses.

Transfer a Git bundle into the dedicated clean ordinary Windows checkout, detach at the exact SHA, and preserve Cargo target/cache. npm ci is skipped only with a successful installation receipt matching package-lock, package.json, Node/npm versions, platform, and architecture, plus installed lock metadata. Failed installs invalidate the receipt. macOS uses the same dependency receipt rule. Windows returns EXE, version/SHA/architecture/SHA-256 receipt, and stage timings. The Mac validates the downloaded digest before signing. Once artifacts are collected, shutdown starts asynchronously; verification and formal uploads may proceed while it shuts down. The coordinator waits for cleanup and reports its result at the end, including failures. Shutdown is excluded from the artifact critical path.

Desktop/Core compile together in one Tauri build using one configuration and dependency graph. The bundler owns external resources; re-signing a Core/helper does not invalidate Rust compilation. Generated frontend files retain their timestamps when bytes are unchanged. Explicit build versions do not watch unrelated Git metadata. Compile, resource signing, bundling, and DMG creation have separate timers. Windows NSIS uses ZLIB instead of solid LZMA to reduce packaging CPU time at the cost of a larger EXE. Runtime content and installation behavior remain unchanged; measure size and upload impact when comparing release timings.

latest.json contains only the selected desktop platforms from this build. Linux archives and install script are separate assets. Missing updater platforms stay on their prior releases. --platforms accepts a nonduplicated subset of mac,windows,linux; partial publication requires its own new version. Never append to or overwrite a public version, substitute old platform bytes, or publish an incomplete selection. No CI release workflow remains.

## Resume

After verification, release-state.json records schema, version, source SHA, selected platforms, and every upload's size and SHA-256. Keep it with the original files. Resume requires a clean main checkout at the original source SHA and matching release tag. Explicit version/platform options must match the checkpoint. It rechecks original artifact bytes/inventory and skips tests, builds, signing, tagging, and pushing. It does not regenerate metadata and needs no signing keys. Dry runs and interrupted builds cannot be resumed for publication; never manufacture or edit a checkpoint.

Initial exact-tag discovery recovers drafts via bounded filtered pages when GitHub's tag endpoint omits them. Duplicate matching drafts stop discovery. Once recorded, the original Release ID owns subsequent reads, upload guards, verification, and recovery; a missing ID never falls back to another draft. Asset metadata requests are asynchronous so they do not block other active transfers. Each upload checks the original ID, tag, and draft state, then streams the binary file through gh api to the release's GitHub upload URL without another tag lookup. Assets upload individually with at most three transfers, ten-minute transfer timeouts, and four attempts using 2/4/8-second backoff. gh transfers disable HTTP/2. Matching uploaded sizes and available digests skip transfer, including after a lost upload response. Mismatched or incomplete draft assets are deleted by asset ID before replacement. Each upload response must match the expected filename, size, state, and available digest. Final verification requires the exact complete inventory, sizes, and SHA-256, downloading/hashing assets when GitHub omits their digest.

The checkpoint saves draft ID and publish intent before publishing. A lost publish response permits read-only recovery only for that original public release. Resume verifies its inventory and public latest.json bytes without mutating public history. Other public versions are rejected. Artifacts and timings survive failures.

## Timings and non-publishing rehearsal

```sh
npm run release -- --dry-run --version X.Y.Z
```

Run twice at the same final clean HEAD and version. The first uncached test run records a pass; the second automatically reuses it. Both build every selected platform, collect receipts, verify Linux runtime behavior, verify Mac package signatures, sign Windows on the Mac, verify updater signatures, and generate the complete local manifest and checksums. No tag, push, draft, release, upload, app installation, or replacement occurs. No publication checkpoint is created. --skip-tests explicitly bypasses tests when requested.

Each stage prints START/END, status, seconds, and timestamped JSONL under release-artifacts/.timings-<suffix>/. Platform wall and platform critical-path timers cover concurrent builds; build/test critical path includes concurrent tests. Worker readiness overlaps preflight/work, and cleanup is a separate background stage. Nested durations must not be added. Overall wall includes final cleanup; formal publication timings include tagging, upload, verification, publish, and readback. Windows sends its detailed dependency/Rust/NSIS timers back to the coordinator. Each asset records separate prepare and upload stages; prepare includes the draft check and any incomplete-asset deletion. Upload records the artifact byte size and, on success, bytesPerSecond measured over the binary HTTP request. Skipped transfers have a skipped upload stage and no transfer rate. These timings distinguish API overhead from transfer time; they do not predict a future network speed. Receipts/timings/test caches are not public assets.

stage/finalize verify existing staged inputs and create metadata. Download URLs, manifest versions, signatures, checksums, and embedded versions must agree. Building is separate from installed-app acceptance.

## Identity migration

The first release from a legacy identity to ARC checks the prior public tag's state-directory definitions and adds one-time manual migration commands to release notes. Later ARC-to-ARC releases omit them. Product and installer do not migrate identities automatically or add compatibility aliases.

Instructions require disabling old login startup and quitting the App before moving production, development, preview, and XDG state. Maintainers also move updater keys. Install the new App afterward. Never overwrite existing destination directories. Windows users move corresponding LOCALAPPDATA directories, remove old login entries, and enable new ones. macOS users reauthorize Screen Recording, Accessibility, Full Disk Access, and login items as prompted.

After cross-identity updates, read connection and permission state from the new installation. macOS/Windows installer registration, executable names, and bundle identities use the new name. Users handle old installations according to release notes.

Prefer archives for old macOS App backups to avoid discoverable duplicate .app identities. If an unpacked copy is necessary, inspect and unregister its LaunchServices entry and register the current installation. Do not delete backups or edit TCC grants. If system toggles disagree with helper preflight, inspect the granted bundle ID and system-log request/writer identities. Never override preflight with old grants. Fully quit System Settings. Only restart the authorization-prompt process when logs prove stale identity retention. The user then authorizes and readback verifies. Ordinary same-identity updates do not use this cleanup.

## Readback

Verify tag/source SHA, workflows, public assets, checksums, updater signatures, latest.json, and embedded versions. Within authorization, verify installed startup, connections, real client tools, and tasks. Source builds, public artifacts, and installed apps are separate evidence layers. State untested layers explicitly. Keep personal paths, accounts, secrets, Tunnel identities, real tasks, and acceptance records outside the repository.

The first migration to guide/query/act requires a one-time client refresh and reauthorization notice. Later capability changes use ops and guide.

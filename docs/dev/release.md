# Release maintenance

[Development](development.md) · [Installation](../installation.md)

Public source and artifacts live in whzxc/agent-remote-control. Formal Git tags and GitHub Releases hold installers, updater archives, latest.json, Homebrew Cask, and checksums. No public npm package is published. Commit/push as authorized; tags, uploads, and Releases require explicit authorization. Building does not require a tag.

## Prerequisites and signing

The Apple Silicon Mac coordinator builds every selected platform locally in isolated clean checkouts (`release-artifacts/.macos-source`, `.windows-source`, `.linux-source`) without external build workers or GitHub Actions runners. An unqualified release selects macOS ARM64 and Windows x64 only; include Linux only when the user explicitly requests all platforms or Linux (`--platforms mac,windows,linux` or `--platforms linux`). The coordinator requires Node.js 24.12+, Go from `go.mod`, full Xcode 26+ (for macOS), local NSIS `makensis` (for Windows cross-packaging, e.g. `brew install makensis`), npm dependencies, and authenticated `gh` for formal publication. Linux-only builds do not require signing keys or Xcode.

Desktop releases publish signed MyGo feeds named `update-darwin-arm64.json` and `update-windows-amd64.json` for the macOS app archive and Windows installed-file archive. They also publish `latest.json` for installed ARC 0.9.53 and 0.9.54 Tauri clients. That feed points to the macOS app archive and raw Windows NSIS EXE with Base64-wrapped Minisign sidecars. All feed payload URLs are version-pinned.

The Mac release coordinator uses the following signing inputs.

- Release preflight compares `ARC_TAURI_UPDATE_PUBLIC_KEY` with the shipped legacy public key pinned in `tooling/release-signing.mjs`. `TAURI_SIGNING_PRIVATE_KEY_FILE` points to its matching external Minisign secret. Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for an encrypted key.
- `ARC_MYGO_UPDATE_PUBLIC_KEY` contains the MyGo Ed25519 public key in Base64. The build embeds the same key in MyGo and ARC's download check. `ARC_MYGO_UPDATE_PRIVATE_KEY_FILE` points to its matching external Base64 Ed25519 secret. An authorized key owner can provision the pair with `mygo keygen`.

The Go verifier checks the corresponding key pairs, verifies cross-compiled Windows PE64 and static Linux ELF64 binaries (`CGO_ENABLED=0`, target architecture, no dynamic loader/GLIBC dependencies, and embedded release version), signs payloads, and verifies both feeds before publication. Keep the legacy feed available at the existing latest-release URL.

Packaged macOS builds use the fixed self-signed identity from tooling/macos-signing.mjs. APPLE_SIGNING_IDENTITY may select only that identity or its fingerprint. Missing certificate/private key, ad-hoc selection, or another identity fails without selecting a company Team. Package checks validate Desktop/Core/screen-helper certificates and identifiers. Keep the original certificate and private key in the Mac keychain; do not regenerate a same-name certificate or export it to GitHub Secrets. Hardened runtime is enabled; Apple notarization and timestamping are not used. First-launch Gatekeeper restrictions are described in Installation.

Production identifiers are com.whzxc.agent-remote-control, .core, and .screen; development uses .dev. Recheck system permissions after identity changes. Updater signatures do not establish OS code-signing identity.

## Linux cross-builds

Select `--platforms mac,windows,linux` for all platforms, or `--platforms linux` for Linux only. Both Linux architectures (`x86_64` and `aarch64`) are built locally on the Mac coordinator in parallel using `CGO_ENABLED=0` Go cross-compilation. The Go verifier inspects each ELF64 binary with `debug/elf` and `debug/buildinfo` to verify architecture, static linkage (no `PT_INTERP`, `DT_NEEDED`, or `GLIBC_` references), and the embedded release version. Each archive includes `arc`, `LICENSE`, `skills`, and `licenses`, using the existing GNU installer names and format, and `linux-receipts.json` records the verified checksums.

## Routine tests

```sh
npm test
```

Normal releases skip `npm run test:extended` by default and run the daily suite (`npm test`, 30-second budget) plus cached desktop UI smoke checks (`npm run accept:ui`) before concurrent local platform builds. Pass `--with-extended` when a release should also run the full Go and native integration suite before preflight. See [Testing](testing.md) for the daily and extended scopes.

Do not run a separate daily suite immediately before release without changing its inputs. Tests use development version 0.0.0 inside and outside release; artifact validation separately checks the requested release version. Any failure or test-budget timeout blocks publication. Resume uses its verified publication checkpoint and does not run tests or builds.

## Commands and publication boundaries

Prepare `release-notes/<version>.json` at the source commit. Each entry has a `section` (`features`, `improvements`, `fixes` or `actions`), an `en` sentence and its `zh-CN` counterpart. Describe what users can do or what changed for them. Include a migration or required action in the release that introduces it. Use an empty list for a maintenance release with no user-facing changes.

Preflight validates the notes for the selected version before compilation. Finalization generates the bilingual GitHub release body and the English `notes` and Chinese `notes_zh_cn` fields in `latest.json`. The release body separates its languages with `<!-- lang:zh-CN -->`. These files share the version's normal publication and readback checks. Resume reuses the finalized artifacts.

```sh
npm run release
npm run release -- --version X.Y.Z
npm run release -- --platforms mac
npm run release -- --platforms mac,windows,linux
npm run release -- --platforms linux
npm run release -- --resume release-artifacts/vX.Y.Z-<suffix>
```

Use a clean main checkout that is not behind its remote. Preflight validates source, signing, branch, and publication permissions and selects a version newer than public releases. ARC_BUILD_VERSION injects it into frontend, Core, Desktop, and installers; source placeholders remain 0.0.0. No version-only commit is created.

The coordinator freezes the same full SHA for each selected platform. Selected macOS, Windows, and Linux builds run concurrently in isolated local checkouts on the Mac coordinator, reusing verified `node_modules` receipts and Go module caches. Source changes during the run fail closed. A unique `release-artifacts/v<version>-<suffix>` directory holds artifacts and receipts. The coordinator verifies the complete selected platform set, PE64/ELF64 headers, static linkage, embedded versions, updater signatures, and checksums before tagging or pushing. Formal publication then atomically pushes `main`/tag, uploads a draft, checks its exact remote inventory and digests, publishes, and reads back the public updater feeds. A rehearsal never enters these mutation stages.

The desktop packager stages the corresponding Go Core and resources, then uses MyGo for the Desktop executable and frontend. macOS keeps the legacy app name, bundle identifier, scheme, executable, native icon and Core/helper paths. Windows NSIS retains current-user installation and the legacy registry and install directory. The macOS package requires macOS 13.0 or later on Apple Silicon.

latest.json contains only the selected desktop platforms from this build. Linux archives and install script are separate assets. Missing updater platforms stay on their prior releases. --platforms accepts a nonduplicated subset of mac,windows,linux; partial publication requires its own new version. Never append to or overwrite a public version, substitute old platform bytes, or publish an incomplete selection. The default selection is mac,windows.

## Resume

After verification, release-state.json records schema, version, source SHA, selected platforms, and every upload's size and SHA-256. Keep it with the original files. Resume requires a clean main checkout at the original source SHA and matching release tag. Explicit version/platform options must match the checkpoint. It rechecks original artifact bytes/inventory and skips tests, builds, signing, tagging, and pushing. It does not regenerate metadata and needs only public updater keys for the selected desktop platforms. Dry runs and interrupted builds cannot be resumed for publication; never manufacture or edit a checkpoint.

Initial exact-tag discovery recovers drafts via bounded filtered pages when GitHub's tag endpoint omits them. Duplicate matching drafts stop discovery. Once recorded, the original Release ID owns subsequent reads, upload guards, verification, and recovery; a missing ID never falls back to another draft. Asset metadata requests are asynchronous so they do not block other active transfers. Each upload checks the original ID, tag, and draft state, then streams the binary file through gh api to the release's GitHub upload URL without another tag lookup. Assets upload individually with at most three transfers, ten-minute transfer timeouts, and four attempts using 2/4/8-second backoff. gh transfers disable HTTP/2. Matching uploaded sizes and available digests skip transfer, including after a lost upload response. Mismatched or incomplete draft assets are deleted by asset ID before replacement. Each upload response must match the expected filename, size, state, and available digest. Final verification requires the exact complete inventory, sizes, and SHA-256, downloading/hashing assets when GitHub omits their digest.

The checkpoint saves draft ID and publish intent before publishing. A lost publish response permits read-only recovery only for that original public release. Resume verifies its inventory and public updater feed bytes without mutating public history. Other public versions are rejected. Artifacts and timings survive failures.

## Local release rehearsal

Use a new private evidence directory outside the checkout. The local path runs the selected platform builds and the same signing, finalization and verifier as the release path. It uses ad hoc macOS code signing, local NSIS cross-packaging, and the four throwaway updater files. It does not call GitHub.

```sh
go run ./tooling/verifier generate-rehearsal-keys /absolute/evidence/test-keys
npm run release -- --dry-run --version X.Y.Z --local-output /absolute/evidence/release --test-keys /absolute/evidence/test-keys
```

`rehearsal.json` binds the final asset inventory and checksums to the source commit. A local rehearsal does not create a publication checkpoint.

## Timings and non-publishing rehearsal

```sh
npm run release -- --dry-run --version X.Y.Z --platforms mac
npm run release -- --dry-run --version X.Y.Z --platforms mac,windows,linux
```

Rehearsals run the daily suite, cached desktop UI smoke checks, and build every selected platform locally, collect receipts, verify macOS package signatures and cross-compiled Windows PE64 / static Linux ELF64 binaries, sign updater payloads, verify updater signatures, and generate the complete local manifest and checksums. No tag, source push, draft, public Release, Release asset upload, app installation, or replacement occurs. No publication checkpoint is created.

Each stage prints START/END, status, seconds, and timestamped JSONL under release-artifacts/.timings-<suffix>/. Platform wall and platform critical-path timers cover concurrent local builds; build/test critical path covers daily tests and desktop UI smoke checks followed by concurrent platform builds. Nested durations must not be added. Formal publication timings include tagging, upload, verification, publish, and readback. Each asset records separate prepare and upload stages; prepare includes the draft check and any incomplete-asset deletion. Upload records the artifact byte size and, on success, bytesPerSecond measured over the binary HTTP request. Skipped transfers have a skipped upload stage and no transfer rate. These timings distinguish API overhead from transfer time; they do not predict a future network speed. Receipts and timings are not public assets.

stage/finalize verify existing staged inputs and create metadata. Download URLs, manifest versions, signatures, checksums, and embedded versions must agree. Building is separate from installed-app acceptance.

## Identity migration

The release that introduced the ARC identity contains the one-time manual migration commands. Product and installer do not migrate identities automatically or add compatibility aliases.

Instructions require disabling old login startup and quitting the App before moving production, development, preview, and XDG state. Maintainers also move updater keys. Install the new App afterward. Never overwrite existing destination directories. Windows users move corresponding LOCALAPPDATA directories, remove old login entries, and enable new ones. macOS users reauthorize Screen Recording, Accessibility, Full Disk Access, and login items as prompted.

After cross-identity updates, read connection and permission state from the new installation. macOS/Windows installer registration, executable names, and bundle identities use the new name. Users handle old installations according to release notes.

Prefer archives for old macOS App backups to avoid discoverable duplicate .app identities. If an unpacked copy is necessary, inspect and unregister its LaunchServices entry and register the current installation. Do not delete backups or edit TCC grants. If system toggles disagree with helper preflight, inspect the granted bundle ID and system-log request/writer identities. Never override preflight with old grants. Fully quit System Settings. Only restart the authorization-prompt process when logs prove stale identity retention. The user then authorizes and readback verifies. Ordinary same-identity updates do not use this cleanup.

## Readback

Verify tag/source SHA, workflows, public assets, checksums, updater signatures, latest.json, and embedded versions. Within authorization, verify installed startup, connections, real client tools, and tasks. Source builds, public artifacts, and installed apps are separate evidence layers. State untested layers explicitly. Keep personal paths, accounts, secrets, Tunnel identities, real tasks, and acceptance records outside the repository.

## Local artifact retention

Local retention keeps the two newest completed package directories per desktop target. Completed formal releases retain payloads from the two newest releases for each selected platform; failed or pending releases keep their payloads. Release metadata, receipts, timings and acceptance evidence remain. `npm run artifacts:prune` previews expired payloads; use `-- --apply` to remove them.

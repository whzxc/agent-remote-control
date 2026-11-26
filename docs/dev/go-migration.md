# Go migration

[Testing](testing.md) · [Worktrees](worktrees.md) · [Architecture](architecture.md)

This document governs the port of ARC's native runtime from Rust and Tauri to Go and [MyGo](https://github.com/egoist/mygo). It applies to every change under `go.mod`, `cmd/`, `internal/` and `shared/core/`, and to Rust changes landed while the port is open. Delete it in the cutover commit.

## Scope

The port replaces the Rust Core (`native/`, binaries `arc` and `contract-fixture`), the Tauri desktop (`desktop/`) and `tooling/verifier`. `ui/`, `relay-worker/`, `design/`, `skills/`, documentation and the Node test and tooling layer remain.

Rust and Tauri remain the shipped product until cutover. Releases, installs and acceptance continue from Rust until then.

The port changes no features, contracts or observable behavior. A Go behavior that differs from Rust is a defect unless this document lists it as an accepted difference.

## Baseline and drift

The port follows Rust at the main commit from which the `go-core` lane was created. Rust commits landed on main after that baseline MUST be ported before cutover. The ledger records each one.

## Layout

- `go.mod` at the repository root declares module `github.com/whzxc/agent-remote-control` and `go 1.27.4`.
- `cmd/arc` builds Core, the front door and the CLI. It MUST NOT import MyGo and MUST build with `CGO_ENABLED=0`.
- `cmd/contract-fixture` mirrors `tests/fixture` and builds only with the `arcfixture` tag.
- `cmd/arc-desktop` builds the MyGo desktop (segment F).
- `internal/core` holds the body of the Rust `arc-core` crate as one Go package. Rust modules reference each other through `crate::*`, and Go rejects import cycles. Port each Rust file to one Go file whose name records its source path, for example `native/src/coordination/bulletin/store.rs` to `internal/core/coordination_bulletin_store.go`.
- Extract a separate package only for leaf code with no dependency on `internal/core`, such as `internal/canonjson` and OS shims under `internal/platform`.
- Shared resources have one copy that both implementations embed. Move `native/src/*.json`, `oauth-page.*` and `relaunch-macos.sh` to `shared/core/`; Rust includes them by relative path and Go embeds them from package `shared/core`.
- Copy guide, catalog, schema, receipt, hint and error text verbatim from Rust when it is not already in a shared file. Never paraphrase it.
- The Rust `test-fixture` feature maps to the Go `arcfixture` build tag. Synthetic hooks MUST NOT compile without the tag.

## Porting conventions

- Register control operations, catalog contributions and management routes in their owning Go files. Use `init()` with the Core registries. Replace the pending registration for your segment when implementing a handler.
- Return errors through the normal dispatcher. Preserve the Rust code, message and recovery data. Operations without a handler return `GO_PORT_PENDING`.
- Use `internal/canonjson` for wire and persisted JSON and for JSON-derived hashes, IDs, cursors and digests.
- Place ported Rust unit cases in the corresponding `_test.go` file. Keep synthetic hooks and their tests under the `arcfixture` tag.

## Compatibility contracts

1. Wire and text surfaces are frozen. This covers MCP tools `guide`, `query` and `act` and the `notification` event; guide, catalog, schema and error text; receipts and error codes; CLI commands, flags, help, output and exit codes; management HTTP routes used by `ui/` and the browser dashboard; OAuth endpoints and pages; device-link ALPN `arc-peer/3` and its routes; the relay-worker protocol; Codex app-server JSON-RPC usage; Claude Code hook and notification formats; and Tunnel client management.
2. JSON bytes match `serde_json`. Every JSON-derived hash, ID, cursor and digest uses `internal/canonjson`.
   - `serde_json::Value` objects serialize with keys in byte order. `#[derive(Serialize)]` structs serialize in field declaration order. Port each site with its Rust order.
   - `<`, `>`, `&`, U+2028 and U+2029 stay unescaped. Control characters use serde's escapes.
   - Floats use `serde_json` formatting as captured in `internal/canonjson/testdata`; `1.0` stays `1.0`.
   - Integers stay integers through decode and encode, including u64 values above 2^53. Never round-trip numbers through float64.
   - Golden tests capture these cases from the Rust implementation.
3. State is read and written in place. Keep state directory resolution, file names, JSON and TOML formats, SQLite schemas and pragmas, file modes (0700 directories, 0600 secrets), Windows ACLs, device-link identity and pairings, OAuth tokens and `dispatch-policy.json`. First Go launch performs no migration.
4. The process model is unchanged: one file-locked Core per state directory, Desktop and CLI leases, build-ID owner exclusion, the front door with the same private IPC endpoint names, detached Codex app-servers and task hosts, and macOS front-door self-update supervision. A Rust build and a Go build MUST NOT share an active owner.
5. Timestamps, UUIDs and duration text match Rust output.
6. Every regular expression behaves as in Rust. Check Unicode classes, case folding and anchors when porting from `regex` to `regexp`.

## Dependency mapping

| Rust | Go |
| --- | --- |
| tokio, hyper, hyper-util, http-body-util | `net/http`, `golang.org/x/net/http2` (server `ReadIdleTimeout`/`PingTimeout` for peer keepalive) |
| rustls, tokio-rustls, ring | `crypto/tls`: TLS 1.3 minimum on peer listeners, `SessionTicketsDisabled`, client certificates with `VerifyPeerCertificate` pinning, `NextProtos` |
| rcgen, x509-parser | `crypto/x509`, `crypto/ecdsa` P-256 |
| reqwest (json, form, stream, socks) | `net/http` with `http.ProxyURL` (socks5 supported) |
| tokio-tungstenite | `github.com/coder/websocket` |
| rusqlite (bundled) | `modernc.org/sqlite` |
| notify | `github.com/fsnotify/fsnotify` |
| mdns-sd, if-addrs, socket2 | a pure-Go DNS-SD library, `net.Interfaces`, `net.KeepAliveConfig`, `golang.org/x/sys` |
| jsonschema | `github.com/santhosh-tekuri/jsonschema/v6`; client-visible error text matches Rust |
| image (png, jpeg, webp, gif) | `image/*`, `golang.org/x/image/webp` |
| zip, flate2 | `archive/zip`, `compress/*` |
| toml | `github.com/pelletier/go-toml/v2` |
| uuid, chrono, url, sha2, base64, regex | `github.com/google/uuid` and the standard library |
| libc, windows-sys | `golang.org/x/sys/unix`, `golang.org/x/sys/windows`, `github.com/Microsoft/go-winio` for named pipes |
| objc2, notify-rust, unicode-normalization (macOS) | `github.com/ebitengine/purego/objc`, `golang.org/x/text/unicode/norm`; MyGo only in `cmd/arc-desktop` |

## Verification

- The native TS suites selected in `tooling/test-suites.mjs` are the parity oracle. `ARC_IMPL=go` makes `npm run test:extended` build `cmd/arc` and `cmd/contract-fixture` instead of Cargo and run the same files through `ARC_TEST_BINARY` and `ARC_TEST_FIXTURE_BINARY`.
- Do not edit test assertions, `tests/contract/` or `tooling/test-policy-allowlist.json`. Report a case that depends on a Rust-only artifact to the control source.
- Port each module's Rust unit tests with the module as Go `_test.go` cases. They follow [Testing](testing.md): Contract, Regression or Property, with one reason tag per case. `check:tests` governs Go tests.
- `npm run test:go` runs `go vet ./...` and `go test ./...`. `test:extended` includes it. Daily `npm test` keeps its 30-second budget.
- Every Go commit cross-compiles with `CGO_ENABLED=0` for darwin/arm64, windows/amd64, linux/amd64 and linux/arm64.
- Unported operations return the single error code `GO_PORT_PENDING`. A check fails if the code remains at cutover.

## Ledger

`tooling/go-port.json` maps every Rust source file under `native/src`, `desktop/src` and `tests/fixture/src` to its segment, Go files and status: `pending`, `ported` or `verified`. It also records each native TS file's result on Go and each post-baseline Rust commit. `verified` requires the module's ported unit tests and its native TS files to pass on Go. A check fails when a Rust file is unmapped.

## Segments

S0 runs alone. Segments A to E run in parallel lanes after S0 lands. F can start once S0's management routes are stable. G and H run last.

| Segment | Rust modules |
| --- | --- |
| S0 Spine | `lib`, `main`, `cli`, `cli_shim`, `runtime`, `service`, `execution`, `control`, `control_sources`, `control_profiles`, `control_metrics`, `core_requests`, `management`, `operations`, `front_door*`, `local_access`, `headless`, `kernel`, `egress`, `rpc`, `transport`, `wait_transport`, `mcp_transport`, `mcp_hub`, `output`, `logs`, `preferences`, `i18n`, `context`, `context_provider`, `resources`, `diagnostics`, `owned_children`, `launches`, `permissions` |
| A Agents and tasks | `agents`, `codex_host`, `codex_progress`, `task_host`, `turn_lifecycle`, `waiter`, `dispatch_queue`, `dispatch_caller`, `task_overview`, `task_summary`, `desktop`, `src_conversations`, `screen`, `images`, `pets`, `browser`, `proxy`, `review`, `respond_tokens`, `interaction_responses`, `writer`, `external_inputs`, `shell_command`, `text_files`, `changes`, `archive_index`, `acceptance_fault`, `cli_acceptance`, `app_env` |
| B Coordination | `coordination`, `task_tracking`, `runtime_metrics` |
| C Notifications and policy | `claude_notify`, `dispatch_policy` |
| D Accounts and setup | `accounts`, `claude_accounts`, `subscriptions`, `oauth`, `sources`, `projects`, `local_gateway`, `setup`, `setup_secret`, `package`, `uninstall`, `skills` |
| E Network | `ingress`, `ingress_observation`, `https`, `https_tunnel`, `cloudflare`, `relay`, `device_link` |
| F Desktop | `desktop/src`: windows, tray, single instance, deep link `agent-remote-control://`, autostart, notifications with activation, window state, permissions, appearance and Windows frame, snapshot, `src_conversations` (WebKit cookies, Chrome Safe Storage), updater. `ui/` replaces `@tauri-apps/*` with generated MyGo bindings behind one bridge module. Bundle identifier, product name and executable name stay unchanged. |
| G Tooling | Build, dev, release, Windows and Linux build scripts, CI, native mutation and cache pruning. |
| H Cutover | Installed acceptance, update handoff from the Tauri updater to the MyGo updater, and one commit that deletes Rust, Cargo files and this document and updates `AGENTS.md` and docs. |

Segment E includes cross-implementation device-link pairing and request tests in both directions (Rust controller with Go member and the reverse). The control source decides at H whether paired devices upgrade together.

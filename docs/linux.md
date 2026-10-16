# Linux headless

Linux x86_64 and aarch64 run the Rust Core directly, without Tauri, a display server, or Codex Desktop. Codex tasks always execute through the installed Codex CLI `app-server`, including `codex_create` and `codex_send`. Install and log in to Codex CLI as the same user that runs Connector. Other Agents retain their own runtime and login requirements.

## Install or build

Install a published release containing Linux tarballs (requires curl, tar, sha256sum):

```sh
curl -fsSL https://raw.githubusercontent.com/whzxc/arc-remote/main/tooling/install-arc-remote.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

The installer selects x86_64/aarch64, checks the release's SHA256SUMS.txt and binary version, and installs to `~/.local/bin`. Set `CLC_VERSION=vX.Y.Z` and/or `CLC_INSTALL_DIR=/absolute/path` on the `sh` process to select a release or destination. Stop Connector before upgrading and restart afterwards. CI tarballs are built on Ubuntu 24.04 (glibc 2.39 or later); build from source on older glibc systems. No Node/npm or GUI libraries are needed to run Core itself.

Build on Linux with stable Rust, a C compiler, linker and Git. SQLite is bundled. Install `unzip` and `tar` for downloaded tunnel components. From the repository root:

```sh
# x86_64
rustup target add x86_64-unknown-linux-gnu
cargo build --manifest-path native/Cargo.toml --locked --release --bin arc-remote --target x86_64-unknown-linux-gnu
install -Dm755 target/x86_64-unknown-linux-gnu/release/arc-remote "$HOME/.local/bin/arc-remote"

# On an aarch64 Linux host, use instead:
rustup target add aarch64-unknown-linux-gnu
cargo build --manifest-path native/Cargo.toml --locked --release --bin arc-remote --target aarch64-unknown-linux-gnu
install -Dm755 target/aarch64-unknown-linux-gnu/release/arc-remote "$HOME/.local/bin/arc-remote"
```

Cross-compiling additionally requires a target C toolchain/sysroot and linker. Neither command builds `desktop/` or the screen helper.

Codex discovery checks executable permissions and searches PATH, `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `~/.npm-global/bin`, `~/.npm/bin`, `~/.bun/bin`, Volta/asdf, npm's `prefix` in `~/.npmrc`, `NPM_CONFIG_PREFIX`/`npm_config_prefix`, `BUN_INSTALL`, `VOLTA_HOME` and nvm's installed Node versions. Keep Node on the daemon's PATH if Codex was installed through npm. A missing executable returns `CODEX_NOT_FOUND` with installation guidance; it does not try to launch Desktop.

## Start, configure, connect

```sh
arc-remote start                 # detached daemon; survives the CLI exiting
arc-remote status                # read-only; does not start Core
arc-remote cli help              # complete configuration schemas
```

Configure a loopback MCP listener with a bearer token. This example uses Python 3 only to generate and pass the token without putting it in shell history or process arguments. It saves the token with mode 0600 in the XDG configuration directory. To use an existing token, pass `bearerToken` in a protected JSON file via stdin instead; tokens must contain at least 32 printable ASCII characters.

```sh
python3 - <<'PY' | arc-remote cli ingress add --stdin
import json, os, pathlib, secrets
config = pathlib.Path(os.environ.get('XDG_CONFIG_HOME') or pathlib.Path.home() / '.config') / 'chatgpt-local-connector'
config.mkdir(parents=True, exist_ok=True, mode=0o700)
token = secrets.token_hex(32)
# Exclusive creation prevents accidentally replacing an existing client's token.
with os.fdopen(os.open(config / 'mcp-token', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
    f.write(token)
print(json.dumps({
    'id': 'linux', 'name': 'Linux MCP', 'controlSource': 'custom',
    'transport': 'https', 'auth': 'bearer', 'bearerToken': token, 'enabled': True,
    'config': {'httpsProvider': 'custom', 'httpsHost': '127.0.0.1',
               'httpsPort': 8787, 'httpsUrl': 'https://localhost/mcp', 'autoStart': True}
}))
PY
arc-remote cli ingress start linux
arc-remote cli ingress list
```

The listener is **HTTP `http://127.0.0.1:8787/mcp`**, using stateless Streamable HTTP: POST JSON-RPC with `Content-Type: application/json` and **`Authorization: Bearer <token>`**. The `https` transport name means TLS terminates at a tunnel or reverse proxy, not in Core. `httpsUrl` declares the external HTTPS resource URL; `https://localhost/mcp` above is only a local setup placeholder. For remote use, replace it with your actual HTTPS `/mcp` URL and configure your TLS reverse proxy. The local management API uses a separate random port and private credential; do not expose it.

Change a port or provider using the shared partial-update API:

```sh
printf '%s\n' '{"config":{"httpsPort":8789}}' | arc-remote cli ingress update linux --stdin
# Explicitly replace the local-only listener with a public Cloudflare Quick Tunnel:
printf '%s\n' '{"config":{"httpsProvider":"cloudflare","cloudflareMode":"quick","httpsUrl":""}}' | arc-remote cli ingress update linux --stdin
arc-remote cli ingress list       # read the public URL and actual state
```

Managed quick tunnels use an ephemeral loopback port. `httpsPort` selects the fixed listener port for `custom` and named Cloudflare. Providers: `cloudflare`, `ngrok`, `pinggy`, `localxpose`, `custom`; official OpenAI Tunnel uses `transport: openai-tunnel`, `auth: openai`, `tunnelId` and `apiKey`. Read `cli help` / `cli ingress presets` for provider credentials and modes. Pass credentials only via stdin. Linux downloads select upstream `linux-amd64` / `linux-arm64` assets (Pinggy names x86_64 `linux-x64`), using the provider's binary/archive format. OpenAI Tunnel identity registration remains the official flow.

`arc-remote cli ingress stop linux` stops that MCP connection; `arc-remote stop` shuts down Core and its Connector-owned tasks. It refuses shutdown while another leased local client is using Core. `arc-remote daemon` runs in the foreground. `arc-remote stdio` provides the existing MCP stdio transport; `cli mcp` is the separate local management MCP.

## systemd user service

Install the binary at its permanent location first. Unit generation captures that binary, the state directory, PATH and relevant XDG/Agent path variables; it neither invokes systemctl nor enables linger. PATH entries are deduplicated in their original order. The unit does not set npm prefix variables; npm keeps its own configuration. The EnvironmentFile path is unquoted; XDG_CONFIG_HOME must be an absolute path containing only ASCII letters, digits, `/`, `.`, `_`, `-`, `@` or `+`. Paths containing spaces or other special characters are rejected before writing the unit.

```sh
arc-remote stop
arc-remote systemd install
systemctl --user daemon-reload
systemctl --user enable --now arc-remote.service
systemctl --user status arc-remote.service
journalctl --user -u arc-remote.service -f
# Keep the user service running after logout and start it at boot:
loginctl enable-linger "$USER"
```

Linger may require administrator authorization. A user systemd manager/session bus must be available; containers without systemd can run `arc-remote daemon` under their supervisor. Under systemd, use `systemctl --user stop/restart arc-remote.service` to manage it. Enabled ingresses with `config.autoStart: true` are restored at daemon startup; inspect `cli ingress list` for startup errors independently of daemon status.

The generated unit reads optional `${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-local-connector/environment`. Put proxy environment variables there when needed (mode 0600), then restart the unit. System proxy mode reads `https_proxy` / `HTTPS_PROXY`, `http_proxy` / `HTTP_PROXY`, and both `no_proxy` / `NO_PROXY`; lowercase wins for each proxy URL, bypass lists are combined, and loopback always bypasses the proxy. `direct` ignores proxy variables; `custom` uses the configured URL. Systemd does not automatically inherit your interactive shell's proxy variables.

Core state, ingress configuration/secrets, receipts and subscription settings use `${XDG_STATE_HOME:-$HOME/.local/state}/chatgpt-local-connector`; `CLC_STATE_DIR` overrides the whole store for isolated instances. Cursor native configuration uses `XDG_CONFIG_HOME`, OpenCode credentials use `XDG_DATA_HOME`; upstream Agent-owned locations such as `CODEX_HOME`/`~/.codex` remain unchanged. The unit is written below `XDG_CONFIG_HOME/systemd/user`. Distinct instances need distinct state directories, listener ports and manually named units.

There is no Linux GUI, desktop panel, terminal launcher or screen capture. Terminal/Desktop actions return explicit unsupported errors. `screen` stays in the shared tool catalog and returns `SCREEN_UNSUPPORTED`, preserving one catalog and a clear error for clients. No Omarchy integration is included.

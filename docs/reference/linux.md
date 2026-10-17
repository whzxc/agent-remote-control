# Linux headless Core

[Installation](../installation.md) · [CLI](cli.md)

Linux x86_64 and aarch64 run the Rust Core without Tauri or a display server. Install and log in to Codex CLI as the service user. Codex tasks execute through its App Server; other Agents keep their own runtime/login requirements.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/whzxc/agent-remote-control/main/tooling/install-agent-remote-control.sh | sh
export PATH="$HOME/.local/bin:$PATH"
arc --version
```

The installer needs curl, tar, sha256sum, awk, install, and mktemp. Automatic version selection also needs jq and searches release pages for the newest non-draft, non-prerelease version containing the current architecture’s Linux tarball. Releases for other platforms are skipped. It verifies the release checksum and binary version. Set ARC_VERSION to a v-prefixed tag and ARC_INSTALL_DIR to an absolute destination on the sh process when needed. CI tarballs use Ubuntu 24.04; older glibc systems need a source build. Tunnel downloads also need unzip/tar.

To build on the matching architecture:

```sh
cargo build --locked --manifest-path native/Cargo.toml --release --bin arc --target x86_64-unknown-linux-gnu
npm run cache:prune
install -Dm755 target/x86_64-unknown-linux-gnu/release/arc "$HOME/.local/bin/arc"
mkdir -p "$HOME/.local/bin/skills"
rm -rf "$HOME/.local/bin/skills/arc-setup"
cp -R skills/arc-setup "$HOME/.local/bin/skills/arc-setup"
```

Use aarch64-unknown-linux-gnu on an ARM64 host. Build tools require Rust, a C compiler/linker, Git, and Node for the repository cache helper. Running the installed Core does not need Node/npm. Cross-compilation also needs a target sysroot/linker.

## Start and configure

```sh
arc start
arc status
arc cli help
```

start detaches; daemon runs in the foreground. status is read-only. For a Claude OAuth connection, add an ingress as in [CLI](cli.md#configure-an-ingress), using `arc` instead of the macOS executable variable. OpenAI Tunnel uses transport openai-tunnel, auth openai, and config.tunnelId/apiKey. Supply credentials via protected stdin.

For your own reverse proxy, set httpsProvider custom, httpsHost 127.0.0.1, a distinct httpsPort, and httpsUrl to the public HTTPS `/mcp` address. The local listener speaks HTTP; the proxy terminates TLS. Forward the [OAuth routes](oauth.md#public-routes) for OAuth connections. Keep management on private loopback.

```sh
arc cli ingress list
arc cli ingress start <id>
arc cli ingress doctor <id>
arc cli onboarding
```

Verify from the actual remote client. `arc cli ingress stop <id>` stops one connection; `arc stop` stops Core and its owned Agents, refusing shutdown while another leased client is active.

## systemd user service

Install the binary at its permanent path first:

```sh
arc stop
arc systemd install
systemctl --user daemon-reload
systemctl --user enable --now agent-remote-control.service
systemctl --user status agent-remote-control.service
journalctl --user -u agent-remote-control.service -f
```

For operation after logout/at boot, enable linger if appropriate:

```sh
loginctl enable-linger "$USER"
```

Unit generation writes below XDG_CONFIG_HOME/systemd/user; it does not run systemctl or enable linger. It captures the binary path, state directory, PATH, and relevant XDG/Agent variables. Enabled ingresses with config.autoStart true start with the daemon; read ingress list for their individual status.

The optional `${XDG_CONFIG_HOME:-$HOME/.config}/agent-remote-control/environment` supplies proxy variables. Keep it mode 0600. System proxy mode reads lowercase/uppercase HTTP(S)_PROXY and NO_PROXY; lowercase URL wins, bypass lists combine, and loopback bypasses proxies. A systemd service does not inherit an interactive shell's environment automatically.

## Update and remove

Stop the service or detached daemon, run the installer for the chosen release, then start it again. To remove a user service, disable/stop agent-remote-control.service, remove its generated unit, and reload the user manager. Remove the arc binary and its adjacent skills/arc-setup directory if no longer needed. Keep the state directory unless intentionally discarding it; paths are in [CLI](cli.md#state-and-environment).

## Limits

Linux has no desktop panels, native terminal launcher, or screen capture; those actions return unsupported errors. XDG_CONFIG_HOME for generated EnvironmentFile paths must be absolute and contain only ASCII letters, digits, `/._-@+`. A user systemd manager is required; otherwise run arc daemon under your supervisor. Keep the Agent's runtime on the service PATH.

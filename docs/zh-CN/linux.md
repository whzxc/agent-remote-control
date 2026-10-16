# Linux 无界面运行

支持 Linux x86_64 / aarch64。直接构建、运行 `native/` Rust Core，不需要 Tauri、显示服务器或 Codex Desktop。`codex_create`、`codex_send` 等操作统一通过本机 Codex CLI `app-server` 执行。请使用运行 Connector 的同一个用户安装并登录 Codex CLI；其他 Agent 保留各自的运行环境和登录方式。

## 安装与构建

安装包含 Linux tarball 的发行版：

```sh
curl -fsSL https://raw.githubusercontent.com/whzxc/arc-remote/main/tooling/install-arc-remote.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

安装脚本需要 curl、tar、sha256sum，自动选择架构，校验发行版 SHA256SUMS.txt 和二进制版本，安装到 `~/.local/bin`。可给 `sh` 进程设置 `CLC_VERSION=vX.Y.Z` 或 `CLC_INSTALL_DIR=/绝对路径`。升级前停止 daemon，升级后重新启动。CI 产物使用 Ubuntu 24.04 构建，要求 glibc 2.39 或更新版本；较旧系统可在本机从源码构建。

源码构建需要稳定版 Rust、C 编译器、链接器和 Git；SQLite 随源码构建，不需要 GUI 库或 Node/npm。下载隧道组件时还需要 tar、unzip。在仓库根目录执行：

```sh
# x86_64 Linux
rustup target add x86_64-unknown-linux-gnu
cargo build --manifest-path native/Cargo.toml --locked --release --bin arc-remote --target x86_64-unknown-linux-gnu
install -Dm755 target/x86_64-unknown-linux-gnu/release/arc-remote "$HOME/.local/bin/arc-remote"

# aarch64 Linux 改用：
rustup target add aarch64-unknown-linux-gnu
cargo build --manifest-path native/Cargo.toml --locked --release --bin arc-remote --target aarch64-unknown-linux-gnu
install -Dm755 target/aarch64-unknown-linux-gnu/release/arc-remote "$HOME/.local/bin/arc-remote"
```

跨平台编译还需要目标 C 工具链、sysroot 和链接器。上述命令不构建 `desktop/` 和 screen helper。

Codex 查找包含 PATH、`~/.local/bin`、`/usr/local/bin`、`/usr/bin`、`~/.npm-global/bin`、`~/.npm/bin`、`~/.bun/bin`、Volta/asdf、`~/.npmrc` 的 npm prefix、`NPM_CONFIG_PREFIX` / `npm_config_prefix`、`BUN_INSTALL`、`VOLTA_HOME` 和 nvm 已安装的 Node 版本，并检查可执行权限。通过 npm 安装时，daemon 的 PATH 也需要包含 Node。找不到时返回 `CODEX_NOT_FOUND` 和安装提示，不会尝试启动 Desktop。

## 启动与 MCP 配置

```sh
arc-remote start          # 后台常驻，不随本次 CLI 退出
arc-remote status         # 只读，不会隐式启动 Core
arc-remote cli help       # 完整配置合同
```

以下示例仅监听本机，使用 Bearer token。Python 3 仅用于生成 token 并通过 stdin 传入，token 不进入命令历史或进程参数，保存在 XDG 配置目录下的 0600 文件中。已有 token 可放在受保护 JSON 文件中，以 stdin 传入 `bearerToken`；要求至少 32 个可打印 ASCII 字符。

```sh
python3 - <<'PY' | arc-remote cli ingress add --stdin
import json, os, pathlib, secrets
config = pathlib.Path(os.environ.get('XDG_CONFIG_HOME') or pathlib.Path.home() / '.config') / 'chatgpt-local-connector'
config.mkdir(parents=True, exist_ok=True, mode=0o700)
token = secrets.token_hex(32)
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

本机 MCP 端点为 **`http://127.0.0.1:8787/mcp`**，使用无状态 Streamable HTTP：POST JSON-RPC，请求头 `Content-Type: application/json` 和 **`Authorization: Bearer <token>`**。`https` 表示 TLS 在隧道或反向代理终止，Core 监听器自身是 HTTP。`httpsUrl` 声明对外 HTTPS 资源地址；示例的 `https://localhost/mcp` 仅是本机配置占位。远程访问时改为实际 HTTPS `/mcp` 地址，并配置 TLS 反向代理。本机管理 API 使用另一个随机端口和私有凭据，不要对外暴露。

修改端口、选择服务商均复用现有部分更新接口：

```sh
printf '%s\n' '{"config":{"httpsPort":8789}}' | arc-remote cli ingress update linux --stdin
# 需要公网时，显式切换为 Cloudflare Quick Tunnel：
printf '%s\n' '{"config":{"httpsProvider":"cloudflare","cloudflareMode":"quick","httpsUrl":""}}' | arc-remote cli ingress update linux --stdin
arc-remote cli ingress list
```

运行中的入口更新后会重启。`httpsPort` 适用于 custom 和 Cloudflare named；托管 quick 隧道使用随机回环端口。服务商包括 `cloudflare`、`ngrok`、`pinggy`、`localxpose`、`custom`。官方 OpenAI Tunnel 使用 `transport: openai-tunnel`、`auth: openai`，配置 `tunnelId`、`apiKey`，身份申请仍走官方流程。凭据字段及模式以 `cli help` / `cli ingress presets` 为准，凭据仅通过 stdin 输入。Linux 下载选择上游 `linux-amd64` / `linux-arm64` 资源（Pinggy 的 x86_64 命名为 `linux-x64`），按实际格式解包。

`arc-remote cli ingress stop linux` 只停止该 MCP 入口；`arc-remote stop` 停止 Core 和其持有的任务，其他本地租约客户端还在使用 Core 时会拒绝停止。`arc-remote daemon` 前台运行，适合外部进程管理器。`arc-remote stdio` 提供已有 MCP stdio 入口，`cli mcp` 则是独立的本机管理 MCP。

## systemd 用户服务

先把二进制安装到固定位置。生成器保存当前可执行路径、状态目录、PATH 和相关 XDG/Agent 路径变量，只生成 unit，不自动调用 systemctl 或启用 linger。PATH 保留原顺序去重；unit 不写入 npm prefix 环境变量，npm 沿用自身配置。EnvironmentFile 使用不带引号的绝对路径；XDG_CONFIG_HOME 仅可包含 ASCII 字母、数字及 `/`、`.`、`_`、`-`、`@`、`+`，空格等特殊字符会在写入 unit 前被明确拒绝。

```sh
arc-remote stop
arc-remote systemd install
systemctl --user daemon-reload
systemctl --user enable --now arc-remote.service
systemctl --user status arc-remote.service
journalctl --user -u arc-remote.service -f
# 注销后保持运行，开机启动用户服务：
loginctl enable-linger "$USER"
```

`enable-linger` 可能需要管理员授权。systemd 用户管理器及会话总线必须可用；没有 systemd 的容器可由外部 supervisor 运行 `arc-remote daemon`。启用 systemd 后使用 `systemctl --user stop/restart arc-remote.service` 管理生命周期。daemon 启动会恢复 `enabled: true` 且 `config.autoStart: true` 的入口；daemon 在线不等于隧道就绪，使用 `cli ingress list` 查看各入口状态和启动错误。

unit 读取可选文件 `${XDG_CONFIG_HOME:-$HOME/.config}/chatgpt-local-connector/environment`。需要代理时将环境变量写入该文件（0600），重启服务。system 代理模式读取 `https_proxy` / `HTTPS_PROXY`、`http_proxy` / `HTTP_PROXY` 和 `no_proxy` / `NO_PROXY`，代理 URL 优先小写，旁路列表合并，并始终绕过回环地址。direct 模式忽略代理环境变量；custom 使用配置地址。systemd 不自动继承交互 shell 的代理变量。

Core 状态、入口配置与凭据、回执和订阅设置位于 `${XDG_STATE_HOME:-$HOME/.local/state}/chatgpt-local-connector`，可用 `CLC_STATE_DIR` 覆盖整个存储。Cursor 原生配置使用 `XDG_CONFIG_HOME`，OpenCode 凭据使用 `XDG_DATA_HOME`；上游 Agent 自有的 `CODEX_HOME` / `~/.codex` 等位置保持原样。unit 写入 `XDG_CONFIG_HOME/systemd/user`。多个实例需使用不同状态目录、监听端口及手工命名的 unit。

Linux 没有 GUI、桌面面板、打开终端或截图功能；相关操作明确返回 unsupported。`screen` 保留在共用工具目录中，调用返回 `SCREEN_UNSUPPORTED`，避免维护第二套工具合同；不包含 Omarchy 适配。

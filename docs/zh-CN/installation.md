# 安装与更新

[English](../installation.md) | **简体中文**

本文介绍 **Connector 桌面应用**。只在本机 ChatGPT Desktop 中使用时，请按[独立插件指南](plugin.md)安装，无需 Tunnel 或桌面应用。网页、手机或其他设备访问才需要配置[远程入口](tunnel.md)。

> 本文对应英文版本；若有差异，以[英文版本](../installation.md)为准。

## 下载

从 [GitHub Releases](https://github.com/whzxc/arc-remote/releases/latest) 获取安装包和 `SHA256SUMS.txt`。可下载版本与文件以发布页为准。

| 平台 | 文件 | 支持范围 |
| --- | --- | --- |
| macOS | `ARC.Remote_<版本>_aarch64.dmg` | 仅支持 Apple Silicon |
| Windows x64 | `…-setup.exe` | 需要 Microsoft Store 版 Codex Desktop |

应用不需要用户安装 Node、npm、Rust 或 Cargo。使用前需安装并登录 Codex Desktop；官方模式填写 Tunnel ID/runtime API Key，连接组件在首次开启连接时自动准备；HTTPS MCP 可选择免账号的 Cloudflare 临时体验、固定域名、ngrok 或自备反向代理，所需组件由应用管理，具体配置见 [接入指南](tunnel.md)。两种方式都需在 ChatGPT 添加连接后才可远程使用，详见 [Codex 配置引导](codex-setup.md)。

## macOS 安装

打开 DMG，将 ARC 拖入 Applications，弹出镜像后从应用程序目录启动。不要长期从 DMG 中运行。覆盖安装前从菜单栏退出 ARC，拖入新版替换；配置和 Codex 历史不在 App 内，不会因替换 App 而清空。

本项目暂不使用 Apple Developer ID 签名和公证。首次打开可能被系统阻止。确认文件来自上述发布页并核对 SHA256 后，可在系统设置的「隐私与安全性」中选择「仍要打开」。如果系统报告应用损坏，可仅对已确认来源的此 App 移除隔离标记：

```sh
xattr -rd com.apple.quarantine "/Applications/ARC Remote.app"
```

若提示没有权限，可使用管理员账户处理该 App 的权限；不需要关闭系统整体的 Gatekeeper。若文件哈希不一致，应重新下载，而不是移除隔离标记。

核对下载文件：

```sh
shasum -a 256 ARC.Remote_0.6.2_aarch64.dmg
```

将结果与同版本 `SHA256SUMS.txt` 的对应行比较。

## Homebrew

Release 附带 `arc-remote.rb`，内含实际 DMG 校验值。源码仓库不再充当 Homebrew tap。
首次使用时创建本地 tap（参见 [Homebrew tap 文档](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap)）：

```sh
brew tap-new local/arc-remote
```

将已发布版本的 Cask 下载到该 tap，再安装：

```sh
curl --fail --location https://github.com/whzxc/arc-remote/releases/latest/download/arc-remote.rb \
  --output "$(brew --repository local/arc-remote)/Casks/arc-remote.rb"
brew install --cask local/arc-remote/arc-remote
```

仅包含该附件的 Release 支持此方式；更早版本直接使用 DMG 安装。
Cask 不自动执行 sudo 或清除扩展属性。替换手动安装的同名 App 时，先退出应用，再给安装命令添加 `--force`。

应用内更新可直接使用。通过 Homebrew 更新时，先用上述下载命令刷新 Cask，再执行：

```sh
brew upgrade --cask --greedy local/arc-remote/arc-remote
```

仅执行 `brew update` 不会刷新这份本地配方。旧仓库 tap 的已有安装可继续使用应用内更新，或从本地 tap 重新安装。

## Windows 安装

选择 x64 的 NSIS `.exe`，运行安装器。安装并登录 Microsoft Store 版 Codex Desktop；Connector 通过命名管道连接同一用户的 Desktop，任务会在 Desktop 中打开并执行。未使用 Authenticode 签名，系统可能显示未知发布者；企业策略禁止运行时需要管理员处理，应用不能绕过策略。

PowerShell 校验示例：

```powershell
Get-FileHash .\ARC.Remote_0.6.2_x64-setup.exe -Algorithm SHA256
```

升级时退出 App，使用同一种安装器覆盖安装。配置默认保留，不要求用户先卸载。

## 应用内更新

默认在应用可见时每六小时检查一次，有新版本时显示入口；可在设置中关闭自动检查、手动检查、查看更新说明或跳过某个版本。手动检查会重新显示已跳过的版本。

点击下载并安装后可查看进度，下载阶段可以取消。安装阶段不可取消。应用先下载并验签，再关闭 Connector 连接、替换并重启，恢复更新前的连接状态；不会重启 Codex Desktop 或接管其任务。

更新失败会显示错误，可重试或打开手动下载页。安装失败会尝试恢复原连接；若恢复也失败，显示实际错误。没有可用发行版、离线或无法访问 GitHub 时可能无法检查更新，连接功能仍可使用。

更新包使用本项目独立密钥签名，客户端内置公钥验签；它不替代 Apple/Windows 系统代码签名。

## 登录系统时开启连接

在设置中开启后，应用在当前用户登录系统时启动并连接。Windows 使用当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 启动项，无需管理员权限；macOS 使用当前用户的 LaunchAgent。关闭开关会删除对应启动项。

Windows 安装器在更新时清理旧版登录计划任务，并保留已开启的登录启动设置。清理失败会停止安装；若旧任务需要管理员权限删除，请先在旧版客户端关闭登录启动，或在任务计划程序中清理后重试。正常卸载会删除当前用户启动项。

Windows 登录启动命令（含应用路径和配置目录参数）最长为 260 个 UTF-16 字符；路径过长时无法启用，需要缩短应用路径或配置目录路径。

## 卸载

先在设置关闭登录系统启动，再从菜单栏退出应用，然后删除 App 或使用系统卸载器。Homebrew 用户可执行 `brew uninstall --cask arc-remote`。

Connector 配置默认保留在 macOS 的 `~/.local/state/chatgpt-local-connector` 或 Windows 的 `%LOCALAPPDATA%/chatgpt-local-connector`。只有不再需要 Tunnel 配置、回执与日志时才自行删除该目录；Codex 项目和历史由 Codex 管理。

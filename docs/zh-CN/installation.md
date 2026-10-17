# 安装、更新与卸载

[English](../installation.md) | **简体中文**

从 [Releases](https://github.com/whzxc/agent-remote-control/releases) 选择包含当前平台安装包的最新版本，下载安装包和 `SHA256SUMS.txt`。运行 ARC 不需要 Node、npm 或 Rust。安装并登录要使用的 Agent。

| 平台 | 产物 |
| --- | --- |
| macOS Apple Silicon | `agent-remote-control_<version>_aarch64.dmg` |
| Windows x64 | NSIS `…-setup.exe` |
| Linux x86_64 / aarch64 | 无界面 Core 压缩包；见 [Linux 参考](../reference/linux.md) |

## macOS

打开 DMG，把 ARC 拖入 Applications，推出 DMG，再从 Applications 启动。使用默认 Codex 工作方式时，先安装 Codex Desktop 并登录。

用 `shasum -a 256 <下载的.dmg>` 与发布校验和比较。macOS 拦截时，在**系统设置 → 隐私与安全性 → 仍要打开**处理。已核验下载却提示损坏时：

```sh
xattr -rd com.apple.quarantine "/Applications/Agent Remote Control.app"
```

## Homebrew

仓库把 Cask 作为发布附件提供。从 [Releases](https://github.com/whzxc/agent-remote-control/releases) 选择包含 `agent-remote-control.rb` 的最新版本，再创建本机 tap 并下载对应 Cask：

```sh
release_tag=vX.Y.Z # 替换为选定版本的 tag。
brew tap-new local/agent-remote-control
curl --fail --location "https://github.com/whzxc/agent-remote-control/releases/download/$release_tag/agent-remote-control.rb" \
  --output "$(brew --repository local/agent-remote-control)/Casks/agent-remote-control.rb"
brew install --cask local/agent-remote-control/agent-remote-control
```

通过 Homebrew 更新时，选择包含 Cask 的最新版本，更新 `release_tag` 并重新下载，再执行：

```sh
brew upgrade --cask --greedy local/agent-remote-control/agent-remote-control
```

`brew update` 不会更新这个本机下载的 Cask。替换手动安装版本前先退出；只有明确要覆盖该应用时才加 `--force`。

## Windows

运行 x64 NSIS 安装包。由 Desktop 执行 Codex 任务时，在同一 Windows 用户下安装并登录 Microsoft Store Codex Desktop。通过 `Get-FileHash <安装包.exe> -Algorithm SHA256` 与 `SHA256SUMS.txt` 核对。

## 更新

在**设置 → 关于**中检查更新。ARC 运行时每小时自动检查新版本并下载，下载完成后提示安装。阅读发布说明并确认安装，也可跳过该版本。ARC 校验 updater 签名，重启后恢复原先运行的连接。自动检查和自动下载始终开启。最新发布未包含当前平台时，ARC 停留在上一版，检查结果视为没有更新，不报错。

手动更新时，退出 ARC 后替换应用或运行新版安装包。跨应用标识变更升级前，先阅读该版本迁移说明。通常安装保留本机配置与 Agent 历史。

## 登录时启动

在设置启用**登录时连接**，卸载前关闭。应用标识变化后，为新安装重新启用。

## 卸载

完整清理本机安装可运行安装版 CLI 的 `cli uninstall`（将 App、状态、受管依赖、缓存、登录项及 arc-setup skill 移入废纸篓，先重置 macOS 权限）；`cli uninstall --purge` 则永久删除。

关闭登录启动，退出 ARC，再删除 macOS 应用或运行 Windows 卸载程序。Homebrew 用户可运行 `brew uninstall --cask agent-remote-control`。

手动删除 App 时，在 macOS 的 `~/.local/state/agent-remote-control`、Windows 的 `%LOCALAPPDATA%/agent-remote-control` 保留状态。只有决定丢弃配置、回执和日志时才删除该目录；Agent 历史仍由各自程序管理。自定义位置见 [CLI](../reference/cli.md#state-and-environment)。

## 限制

macOS 安装包面向 Apple Silicon。未签名或未公证的产物可能触发系统提示，组织策略可能需要管理员处理。Linux 没有桌面 UI。Bundle identity 变化后，可能需要重新授予 macOS 屏幕录制、辅助功能、自动化和登录项权限。

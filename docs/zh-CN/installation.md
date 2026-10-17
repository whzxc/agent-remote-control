# 安装、更新与卸载

[English](../installation.md) | **简体中文**

从 [Releases](https://github.com/whzxc/agent-remote-control/releases/latest) 下载安装包和 `SHA256SUMS.txt`。运行 ARC 不需要 Node、npm 或 Rust。安装并登录要使用的 Agent。

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

仓库把 Cask 作为发布附件提供。创建本机 tap 并下载：

```sh
brew tap-new local/agent-remote-control
curl --fail --location https://github.com/whzxc/agent-remote-control/releases/latest/download/agent-remote-control.rb \
  --output "$(brew --repository local/agent-remote-control)/Casks/agent-remote-control.rb"
brew install --cask local/agent-remote-control/agent-remote-control
```

通过 Homebrew 更新时，重新下载 Cask，再执行：

```sh
brew upgrade --cask --greedy local/agent-remote-control/agent-remote-control
```

`brew update` 不会更新这个本机下载的 Cask。替换手动安装版本前先退出；只有明确要覆盖该应用时才加 `--force`。

## Windows

运行 x64 NSIS 安装包。由 Desktop 执行 Codex 任务时，在同一 Windows 用户下安装并登录 Microsoft Store Codex Desktop。通过 `Get-FileHash <安装包.exe> -Algorithm SHA256` 与 `SHA256SUMS.txt` 核对。

## 更新

在**设置 → 更新**中检查版本、阅读发布说明并安装。ARC 校验 updater 签名，重启后恢复原先运行的连接。应用可见时每六小时自动检查，可在设置关闭或跳过某个版本。

手动更新时，退出 ARC 后替换应用或运行新版安装包。跨应用标识变更升级前，先阅读该版本迁移说明。通常安装保留本机配置与 Agent 历史。

## 登录时启动

在设置启用**登录时连接**，卸载前关闭。应用标识变化后，为新安装重新启用。

## 卸载

关闭登录启动，退出 ARC，再删除 macOS 应用或运行 Windows 卸载程序。Homebrew 用户可运行 `brew uninstall --cask agent-remote-control`。

ARC 在 macOS 的 `~/.local/state/agent-remote-control`、Windows 的 `%LOCALAPPDATA%/agent-remote-control` 保留状态。只有决定丢弃配置、回执和日志时才删除该目录；Agent 历史仍由各自程序管理。自定义位置见 [CLI](../reference/cli.md#state-and-environment)。

## 限制

macOS 安装包面向 Apple Silicon。未签名或未公证的产物可能触发系统提示，组织策略可能需要管理员处理。Linux 没有桌面 UI。Bundle identity 变化后，可能需要重新授予 macOS 屏幕录制、辅助功能、自动化和登录项权限。

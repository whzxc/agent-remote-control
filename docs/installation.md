# Install, update, and uninstall

**English** | [简体中文](zh-CN/installation.md)

Choose the newest release containing your platform’s installer and download it with `SHA256SUMS.txt` from [Releases](https://github.com/whzxc/agent-remote-control/releases). ARC runs without Node, npm, or Rust. Install and sign in to the Agent you want to use.

| Platform | Package |
| --- | --- |
| macOS Apple Silicon | `agent-remote-control_<version>_aarch64.dmg` |
| Windows x64 | NSIS `…-setup.exe` |
| Linux x86_64 / aarch64 | Headless Core tarball; [Linux reference](reference/linux.md) |

## macOS

Open the DMG, drag ARC to Applications, eject the DMG, and launch from Applications. For the default Codex workflow, install Codex Desktop and sign in.

Compare `shasum -a 256 <downloaded.dmg>` with the release's checksum. If macOS blocks the app, choose **System Settings → Privacy & Security → Open Anyway**. For a damaged-app warning on a verified download:

```sh
xattr -rd com.apple.quarantine "/Applications/Agent Remote Control.app"
```

## Homebrew

The repository publishes a Cask as a release asset. Choose the newest release containing `agent-remote-control.rb` from [Releases](https://github.com/whzxc/agent-remote-control/releases), then create a local tap and download its Cask:

```sh
release_tag=vX.Y.Z # Replace with the chosen release tag.
brew tap-new local/agent-remote-control
curl --fail --location "https://github.com/whzxc/agent-remote-control/releases/download/$release_tag/agent-remote-control.rb" \
  --output "$(brew --repository local/agent-remote-control)/Casks/agent-remote-control.rb"
brew install --cask local/agent-remote-control/agent-remote-control
```

To update through Homebrew, choose the newest release containing the Cask, update `release_tag`, download it again, and run:

```sh
brew upgrade --cask --greedy local/agent-remote-control/agent-remote-control
```

`brew update` does not refresh this locally downloaded Cask. Quit a manually installed copy before replacing it; use `--force` only when intentionally replacing that app.

## Windows

Run the x64 NSIS installer. For Desktop-owned Codex tasks, install and sign in to Microsoft Store Codex Desktop as the same Windows user. Verify the installer with `Get-FileHash <installer.exe> -Algorithm SHA256` and compare it with `SHA256SUMS.txt`.

## Update

Open **Settings → About** to check for updates. While running, ARC automatically checks every hour and downloads new versions, then prompts you to install. Read the release notes and confirm installation, or skip the version. ARC verifies the updater signature and restores running connections after restarting. Automatic checks and downloads are always enabled. If the latest release does not include your platform, ARC stays on its previous version and treats the check as no update, without an error.

For a manual update, quit ARC and replace the app or run the newer installer. Read the release's migration instructions before upgrading across an identity change. Installation normally retains local configuration and Agent history.

## Start at sign-in

Enable **Connect at sign-in** in Settings. Disable it before uninstalling. After an app identity change, re-enable it for the new installation.

## Uninstall

For full local cleanup, run the installed CLI’s `cli uninstall` (moves the App, state, managed dependencies, caches, login registration and arc-setup skills to Trash; resets macOS permissions first), or `cli uninstall --purge` for permanent deletion.

Disable sign-in startup, quit ARC, then delete the macOS app or use the Windows uninstaller. Homebrew users can run `brew uninstall --cask agent-remote-control`.

Manual App removal leaves ARC state in `~/.local/state/agent-remote-control` on macOS and `%LOCALAPPDATA%/agent-remote-control` on Windows. Remove that directory only when you want to discard its configuration, receipts, and logs. Agent-owned histories remain in their own stores. See [CLI](reference/cli.md#state-and-environment) for custom locations.

## Limits

macOS packages target Apple Silicon. Unsigned or unnotarized packages can trigger OS warnings; organization policy may require administrator action. Linux has no desktop UI. A renamed bundle identity can require new macOS screen-recording, accessibility, automation, and login-item permissions.

#!/bin/sh
# Install a published macOS App or headless Linux Core.
set -eu
platform=$(uname -s)
case "$platform" in Darwin|Linux) ;; *) echo 'Supported platforms: macOS, Linux' >&2; exit 1 ;; esac
case "$(uname -m)" in
  x86_64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo 'Supported architectures: x86_64, aarch64' >&2; exit 1 ;;
esac
checksum=sha256sum
[ "$platform" != Darwin ] || checksum=shasum
for command in curl tar "$checksum" awk install mktemp; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
repo=https://github.com/whzxc/agent-remote-control
version=${ARC_VERSION:-}
if [ -z "$version" ] && [ "$platform" = Darwin ]; then
  latest=$(curl --proto '=https' --proto-redir '=https' -fsSL -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
  version=${latest##*/}
fi
if [ -z "$version" ]; then
  command -v jq >/dev/null || { echo 'Missing command: jq (needed to select a release; or set ARC_VERSION)' >&2; exit 1; }
  page=1
  while :; do
    releases=$(curl --proto '=https' --proto-redir '=https' -fsSL \
      "https://api.github.com/repos/whzxc/agent-remote-control/releases?per_page=100&page=$page")
    version=$(printf '%s' "$releases" | jq -r --arg arch "$arch" '
      first(.[] | select(.draft == false and .prerelease == false)
        | . as $release
        | select(any(.assets[]; .name == ("agent-remote-control-" + $release.tag_name + "-linux-" + $arch + ".tar.gz")))
        | .tag_name) // empty')
    [ -z "$version" ] || break
    printf '%s' "$releases" | jq -e 'length == 100' >/dev/null || {
      echo "No stable release contains a Linux $arch tarball" >&2
      exit 1
    }
    page=$((page + 1))
  done
fi
case "$version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo 'ARC_VERSION must be a v-prefixed release tag' >&2; exit 1 ;; esac
case "$version" in *[!a-zA-Z0-9._-]*) echo 'Invalid release tag' >&2; exit 1 ;; esac
if [ "$platform" = Darwin ]; then
  destination=${ARC_INSTALL_DIR:-/Applications}
  mkdir -p "$destination"
  destination=$(cd "$destination" && pwd -P)
  ARC_STATE_DIR=${ARC_STATE_DIR:-"$HOME/.local/state/agent-remote-control"}
  mkdir -p "$ARC_STATE_DIR"
  ARC_STATE_DIR=$(cd "$ARC_STATE_DIR" && pwd -P)
  export ARC_STATE_DIR
  app="$destination/Agent Remote Control.app"
  cli="$app/Contents/Resources/bin/arc"
  desktop="$app/Contents/MacOS/agent-remote-control-desktop"
  stage=$(mktemp -d "${TMPDIR:-/tmp}/arc-install.XXXXXX")
  trap 'rm -rf "$stage"' EXIT HUP INT TERM
  installed=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || true)
  app_pids() {
    ps -axo pid=,comm= | awk -v executable="$desktop" -v core="${1:-}" \
      -v cli="$cli" -v bundled_cli="$app/Contents/MacOS/../Resources/bin/arc" '{
      pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "");
      if ($0 == executable || (core == "with-core" && ($0 == cli || $0 == bundled_cli))) print pid;
    }'
  }
  if [ "$installed" != "${version#v}" ]; then
    asset=agent-remote-control_${version#v}_${arch}.app.tar.gz
    url=$repo/releases/download/$version
    curl --proto '=https' --proto-redir '=https' -fsSL "$url/$asset" -o "$stage/$asset" || {
      if [ "$arch" = x86_64 ]; then
        echo "Release $version has no downloadable Intel Mac asset ($asset). Use an Apple Silicon Mac or build ARC from source." >&2
      else
        echo "Cannot download $asset from release $version." >&2
      fi
      exit 1
    }
    curl --proto '=https' --proto-redir '=https' -fsSL "$url/SHA256SUMS.txt" -o "$stage/SHA256SUMS.txt"
    awk -v asset="$asset" '$2 == asset {print}' "$stage/SHA256SUMS.txt" > "$stage/checksum"
    [ "$(wc -l < "$stage/checksum" | tr -d ' ')" = 1 ] || { echo 'Missing or duplicate checksum' >&2; exit 1; }
    (cd "$stage" && shasum -a 256 -c checksum) >&2
    tar -xzf "$stage/$asset" -C "$stage"
    [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$stage/Agent Remote Control.app/Contents/Info.plist")" = "${version#v}" ] || { echo 'Version mismatch' >&2; exit 1; }
    pids=$(app_pids)
    if [ -n "$pids" ]; then
      pids=$(app_pids with-core)
      "$cli" cli app quit > "$stage/quit.json"
      # Core releases its final lease after Desktop exits; wait before replacing it.
      for pid in $pids; do
        attempts=0
        while kill -0 "$pid" 2>/dev/null; do
          attempts=$((attempts + 1))
          [ "$attempts" -lt 30 ] || { echo 'ARC did not quit; installation stopped.' >&2; exit 1; }
          sleep 1
        done
      done
    fi
    rm -rf "$app"
    mv "$stage/Agent Remote Control.app" "$app"
    printf 'Installed %s to %s\n' "$version" "$app" >&2
  else
    printf '%s is already installed; skipping download and replacement.\n' "$version" >&2
  fi
  xattr -dr com.apple.quarantine "$app"
  # Mark a fresh Agent bootstrap without choosing a goal on the user's behalf.
  if [ ! -e "$ARC_STATE_DIR/setup.json" ] && [ ! -e "$ARC_STATE_DIR/ingresses/index.json" ]; then
    (umask 077; printf '{"choices":{}}\n' > "$ARC_STATE_DIR/setup.json")
  fi
  if [ -z "$(app_pids)" ]; then
    open -n -a "$app" --args --state-dir "$ARC_STATE_DIR"
  fi
  attempts=0
  until "$cli" cli app status > "$stage/status.json" 2>/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 30 ] || { echo "ARC did not become ready. Check $ARC_STATE_DIR/logs." >&2; exit 1; }
    sleep 1
  done
  # plutil is shipped with macOS; preserve spaces and JSON escaping in paths.
  plutil -create xml1 "$stage/result.plist"
  plutil -insert version -string "${version#v}" "$stage/result.plist"
  plutil -insert cliPath -string "$cli" "$stage/result.plist"
  plutil -insert stateDir -string "$ARC_STATE_DIR" "$stage/result.plist"
  plutil -convert json -o - "$stage/result.plist"
  printf '\n'
  exit 0
fi
destination=${ARC_INSTALL_DIR:-"$HOME/.local/bin"}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
asset=agent-remote-control-$version-linux-$arch.tar.gz
url=$repo/releases/download/$version
curl --proto '=https' --proto-redir '=https' -fsSL "$url/$asset" -o "$stage/$asset" || {
  echo "Release $version has no downloadable $asset; choose a release containing Linux tarballs or build native/Cargo.toml from source." >&2
  exit 1
}
curl --proto '=https' --proto-redir '=https' -fsSL "$url/SHA256SUMS.txt" -o "$stage/SHA256SUMS.txt"
awk -v asset="$asset" '$2 == asset {print}' "$stage/SHA256SUMS.txt" > "$stage/checksum"
[ "$(wc -l < "$stage/checksum" | tr -d ' ')" = 1 ] || { echo 'Missing or duplicate checksum' >&2; exit 1; }
(cd "$stage" && sha256sum -c checksum)
tar -xzf "$stage/$asset" -C "$stage" arc skills/arc-setup
[ "$("$stage/arc" --version)" = "${version#v}" ] || { echo 'Version mismatch' >&2; exit 1; }
mkdir -p "$destination/skills"
rm -rf "$destination/skills/arc-setup"
cp -R "$stage/skills/arc-setup" "$destination/skills/arc-setup"
# Replace via rename so a running executable is never truncated.
staged_binary=$(mktemp "$destination/.agent-remote-control.XXXXXX")
trap 'rm -rf "$stage"; rm -f "$staged_binary"' EXIT HUP INT TERM
install -m 755 "$stage/arc" "$staged_binary"
mv -f "$staged_binary" "$destination/arc"
printf 'Installed %s to %s/arc\nAdd this directory to PATH. Stop the daemon before upgrading; restart it after installation.\n' "$version" "$destination"

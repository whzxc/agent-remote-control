#!/bin/sh
# Install a published headless Linux tarball for the current user.
set -eu
case "$(uname -s)" in Linux) ;; *) echo 'Linux only' >&2; exit 1 ;; esac
case "$(uname -m)" in
  x86_64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo 'Supported architectures: x86_64, aarch64' >&2; exit 1 ;;
esac
for command in curl tar sha256sum awk install mktemp; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
repo=https://github.com/whzxc/agent-remote-control
version=${ARC_VERSION:-}
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

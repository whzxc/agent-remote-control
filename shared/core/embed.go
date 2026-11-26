// Package core contains assets embedded by both ARC runtimes.
package core

import "embed"

// Files contains the protocol descriptors and platform resources.
//
//go:embed *.json oauth-page.* relaunch-macos.sh
var Files embed.FS

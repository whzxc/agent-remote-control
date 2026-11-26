// Package core contains embedded ARC descriptors and platform resources.
package core

import "embed"

// Files contains the protocol descriptors and platform resources.
//
//go:embed *.json oauth-page.* relaunch-macos.sh
var Files embed.FS

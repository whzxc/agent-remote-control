package ui

import "embed"

// OAuthAssets provides the Web UI resources used by the native consent page.
//
//go:embed tokens.css assets/arc/favicon.ico
var OAuthAssets embed.FS

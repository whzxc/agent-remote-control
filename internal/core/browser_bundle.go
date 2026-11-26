//go:build arcbrowser

package core

import (
	"embed"
	"io/fs"
)

// The build stages only the Vite browser entry point and its immutable assets.
//
//go:embed browser_dist/browser.html browser_dist/assets
var browserBundle embed.FS

func init() {
	browserAssets, _ = fs.Sub(browserBundle, "browser_dist")
}

package core

import (
	"os"
	"path/filepath"
)

func cloudflareCredentials(tunnel string) string {
	return filepath.Join(root(), "cloudflare", tunnel+".json")
}

func cloudflareConfigured(config object) bool {
	tunnel := text(config, "cloudflareTunnelId")
	if tunnel == "" {
		return false
	}
	info, err := os.Stat(cloudflareCredentials(tunnel))
	return err == nil && info.Mode().IsRegular()
}

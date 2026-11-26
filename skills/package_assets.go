package skills

import "embed"

// PackageAssets contains the source files that a signed package must ship unmodified.
//
//go:embed arc-setup/SKILL.md arc-setup/playbooks/*.md
var PackageAssets embed.FS

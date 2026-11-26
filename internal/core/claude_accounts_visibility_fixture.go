//go:build arcfixture

package core

import "os"

func init() {
	claudeSessionFixtureEndpoint = func() string { return os.Getenv("ARC_FIXTURE_CLAUDE_API") }
}

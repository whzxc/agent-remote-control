// Package agents embeds the Agent descriptors shared by the native runtimes.
package agents

import _ "embed"

//go:embed builtins.json
var Builtins []byte

//go:embed claude-adapter.json
var ClaudeAdapter []byte

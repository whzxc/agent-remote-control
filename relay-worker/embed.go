// Package relayworker embeds the deployment assets shipped with Core.
package relayworker

import _ "embed"

//go:embed src/worker.ts
var Source []byte

//go:embed wrangler.json
var Config []byte

// Package ingress embeds the ingress descriptor shared by the native runtimes.
package ingress

import _ "embed"

//go:embed config.json
var Descriptor string

//go:build arcfixture

package main

import (
	"os"

	"github.com/whzxc/agent-remote-control/internal/core"
)

func main() {
	os.Exit(core.RunFixture(os.Stdin, os.Stdout, os.Stderr))
}

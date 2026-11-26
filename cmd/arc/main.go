package main

import (
	"os"

	"github.com/whzxc/agent-remote-control/internal/core"
)

func main() {
	os.Exit(core.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

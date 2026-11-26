package core

import (
	"fmt"
	"io"
)

const PortPending = "GO_PORT_PENDING"

func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fmt.Fprintln(stderr, PortPending)
	return 1
}

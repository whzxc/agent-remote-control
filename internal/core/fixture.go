//go:build arcfixture

package core

import (
	"fmt"
	"io"
)

func RunFixture(stdin io.Reader, stdout, stderr io.Writer) int {
	fmt.Fprintln(stderr, PortPending)
	return 1
}

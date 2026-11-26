package core

import (
	"errors"
	"fmt"
	"io"
	"syscall"
)

func outputLine(output io.Writer, value any) error {
	if _, err := fmt.Fprintln(output, value); err != nil {
		if errors.Is(err, syscall.EPIPE) {
			return nil
		}
		return fmt.Errorf("Cannot write standard output: %w", err)
	}
	return nil
}

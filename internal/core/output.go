package core

import (
	"errors"
	"fmt"
	"io"
	"syscall"
)

var outputClosed = errors.New("standard output closed by reader")

func outputLine(output io.Writer, value any) error {
	if _, err := fmt.Fprintln(output, value); err != nil {
		if errors.Is(err, syscall.EPIPE) {
			return outputClosed
		}
		return fmt.Errorf("Cannot write standard output: %w", err)
	}
	return nil
}

package core

import (
	"errors"
	"fmt"
	"io"
	"syscall"
)

var outputClosed = errors.New("standard output closed by reader")

func outputLine(output io.Writer, value any) error {
	if synchronized, ok := output.(*synchronizedOutput); ok {
		synchronized.Lock()
		defer synchronized.Unlock()
		output = synchronized.writer
	}
	line := fmt.Sprintln(value)
	written, err := io.WriteString(output, line)
	if err == nil && written != len(line) {
		err = io.ErrShortWrite
	}
	if err == nil {
		if buffered, ok := output.(interface{ Flush() error }); ok {
			err = buffered.Flush()
		}
	}
	switch {
	case errors.Is(err, syscall.EPIPE), operatingSystem == "windows" && errors.Is(err, syscall.Errno(109)): // ERROR_BROKEN_PIPE
		return outputClosed
	case err != nil:
		return fmt.Errorf("Cannot write standard output: %w", err)
	default:
		return nil
	}
}

package core

import (
	"bufio"
	"bytes"
	"io"
	"strings"
	"syscall"
	"testing"
)

type pipeErrorWriter struct{}

func (pipeErrorWriter) Write([]byte) (int, error) { return 0, syscall.EPIPE }

func TestCommandOutputFlushesEachLineAndClosesCleanlyOnBrokenPipe(t *testing.T) {
	// Contract: streamed output publishes complete lines and a reader closing stdout leaves a successful CLI exit.
	var received bytes.Buffer
	line := "{\"state\":\"ready\"}"
	if err := outputLine(bufio.NewWriter(&received), line); err != nil || received.String() != line+"\n" {
		t.Fatalf("stdout line = %q, error = %v", &received, err)
	}
	var diagnostic bytes.Buffer
	if code := Run([]string{"--version"}, strings.NewReader(""), bufio.NewWriter(pipeErrorWriter{}), &diagnostic); code != 0 || diagnostic.Len() != 0 {
		t.Fatalf("broken pipe exit = %d, stderr = %q", code, &diagnostic)
	}
	if code := Run([]string{"cli", "help"}, strings.NewReader(""), pipeErrorWriter{}, io.Discard); code != 0 {
		t.Fatalf("broken pipe CLI exit = %d", code)
	}
}

package platform

import (
	"context"
	"errors"
	"net"
	"os"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func IPCPath(_, digest, owner string) string {
	return `\\.\pipe\arc-` + digest + "-" + owner
}

func ListenIPC(path string) (net.Listener, error) {
	return winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;OW)"})
}

func DialIPC(ctx context.Context, path string) (net.Conn, error) {
	open, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	conn, err := winio.DialPipeContext(open, path)
	// go-winio retries only ERROR_PIPE_BUSY, and returns the context error
	// when it exhausts the open budget.
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: windows.ERROR_PIPE_BUSY}
	}
	return conn, err
}

func IPCBusy(err error) bool {
	return errors.Is(err, windows.ERROR_PIPE_BUSY)
}

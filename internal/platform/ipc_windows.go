package platform

import (
	"context"
	"net"

	"github.com/Microsoft/go-winio"
)

func IPCPath(_, digest, owner string) string {
	return `\\.\pipe\arc-` + digest + "-" + owner
}

func ListenIPC(path string) (net.Listener, error) {
	return winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;OW)"})
}

func DialIPC(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, path)
}

package platform

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// NormalizeSocketError maps native connect errors to the corresponding
// syscall errno for classification. Callers retain the original diagnostic.
func NormalizeSocketError(err error) error {
	var code syscall.Errno
	if errors.As(err, &code) {
		switch code {
		case windows.WSAECONNREFUSED, windows.ERROR_CONNECTION_REFUSED:
			return syscall.ECONNREFUSED
		case windows.WSAENETUNREACH, windows.ERROR_NETWORK_UNREACHABLE:
			return syscall.ENETUNREACH
		case windows.WSAEHOSTUNREACH, windows.ERROR_HOST_UNREACHABLE:
			return syscall.EHOSTUNREACH
		case windows.WSAEADDRNOTAVAIL, windows.ERROR_ADDRESS_NOT_ASSOCIATED:
			return syscall.EADDRNOTAVAIL
		case windows.WSAEINVAL, windows.ERROR_INVALID_PARAMETER:
			return syscall.EINVAL
		}
	}
	return err
}

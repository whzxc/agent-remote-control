//go:build !windows

package core

import "errors"

func openWindowsNativeAgentLauncher(_, _, _ string) error {
	return errors.New("UNSUPPORTED_PLATFORM")
}

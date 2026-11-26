//go:build darwin || linux

package core

import (
	"errors"
	"golang.org/x/sys/unix"
)

func coordinationProcessAlive(pid uint32) (bool, error) {
	switch err := unix.Kill(int(pid), 0); {
	case err == nil:
		return true, nil
	case errors.Is(err, unix.ESRCH):
		return false, nil
	default:
		return false, errors.New("COVERAGE_GAP: process identity unavailable")
	}
}

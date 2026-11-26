//go:build unix

package platform

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func PrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700)
}

func ReplaceFile(from, to string) error { return os.Rename(from, to) }

func TryLock(file *os.File) (bool, error) { return TryFileLock(file, false) }

func TryFileLock(file *os.File, shared bool) (bool, error) {
	mode := unix.LOCK_EX
	if shared {
		mode = unix.LOCK_SH
	}
	err := unix.Flock(int(file.Fd()), mode|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) {
		return false, nil
	}
	return err == nil, err
}

func Lock(file *os.File, shared bool) error {
	mode := unix.LOCK_EX
	if shared {
		mode = unix.LOCK_SH
	}
	for {
		err := unix.Flock(int(file.Fd()), mode)
		if !errors.Is(err, unix.EINTR) {
			return err
		}
	}
}

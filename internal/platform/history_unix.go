//go:build unix

package platform

import (
	"errors"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func OpenNativeHistory(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		if err != nil {
			return nil, err
		}
		return nil, errors.New("invalid history file")
	}
	if info.Sys().(*syscall.Stat_t).Nlink != 1 {
		_ = file.Close()
		return nil, errors.New("linked history")
	}
	return file, nil
}

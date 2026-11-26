//go:build darwin || linux

package core

import (
	"errors"
	"os"
	"path/filepath"
)

func syncDeviceTransferParent(path string) error {
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

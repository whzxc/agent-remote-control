package core

import "golang.org/x/sys/unix"

func deviceTransferAvailable(path string) (uint64, error) {
	var stat unix.Statfs_t
	err := unix.Statfs(path, &stat)
	return deviceTransferSpace(stat.Bavail, uint64(stat.Bsize)), err
}

func renameNewDeviceTransfer(from, to string) error {
	return unix.RenamexNp(from, to, unix.RENAME_EXCL)
}

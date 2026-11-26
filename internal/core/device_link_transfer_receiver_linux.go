package core

import "golang.org/x/sys/unix"

func deviceTransferAvailable(path string) (uint64, error) {
	var stat unix.Statfs_t
	err := unix.Statfs(path, &stat)
	return deviceTransferSpace(stat.Bavail, uint64(stat.Frsize)), err
}

func renameNewDeviceTransfer(from, to string) error {
	return unix.Renameat2(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_NOREPLACE)
}

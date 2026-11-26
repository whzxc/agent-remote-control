package platform

import (
	"golang.org/x/sys/unix"
	"os"
	"strconv"
)

func NoFileCeiling() (uint64, error) { return 0, nil }
func ChildFileLimits(pid int) (uint64, uint64, error) {
	var lim unix.Rlimit
	err := unix.Prlimit(pid, unix.RLIMIT_NOFILE, nil, &lim)
	return lim.Cur, lim.Max, err
}
func DescriptorCount(pid int) (uint64, error) {
	rows, err := os.ReadDir("/proc/" + strconv.Itoa(pid) + "/fd")
	return uint64(len(rows)), err
}

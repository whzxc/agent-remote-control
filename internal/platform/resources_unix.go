//go:build unix

package platform

import "golang.org/x/sys/unix"

func NoFileLimits() (soft, hard uint64, err error) {
	var lim unix.Rlimit
	err = unix.Getrlimit(unix.RLIMIT_NOFILE, &lim)
	return lim.Cur, lim.Max, err
}
func SetNoFileLimit(soft, hard uint64) error {
	return unix.Setrlimit(unix.RLIMIT_NOFILE, &unix.Rlimit{Cur: soft, Max: hard})
}
func NoFileUnlimited(value uint64) bool { return value == uint64(unix.RLIM_INFINITY) }

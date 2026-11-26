package platform

import (
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func FileIdentity(path string, info os.FileInfo) (*[4]int64, time.Time) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, time.Time{}
	}
	ident := [4]int64{int64(stat.Dev), int64(stat.Ino), stat.Ctim.Sec, stat.Ctim.Nsec}
	var birth time.Time
	var detail unix.Statx_t
	if unix.Statx(unix.AT_FDCWD, path, unix.AT_STATX_DONT_SYNC, unix.STATX_BTIME, &detail) == nil && detail.Mask&unix.STATX_BTIME != 0 {
		birth = time.Unix(detail.Btime.Sec, int64(detail.Btime.Nsec))
	}
	return &ident, birth
}

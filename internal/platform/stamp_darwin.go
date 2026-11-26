package platform

import (
	"os"
	"syscall"
	"time"
)

func FileIdentity(_ string, info os.FileInfo) (*[4]int64, time.Time) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, time.Time{}
	}
	ident := [4]int64{int64(stat.Dev), int64(stat.Ino), stat.Ctimespec.Sec, stat.Ctimespec.Nsec}
	return &ident, time.Unix(stat.Birthtimespec.Sec, stat.Birthtimespec.Nsec)
}

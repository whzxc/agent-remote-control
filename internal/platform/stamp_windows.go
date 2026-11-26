package platform

import (
	"os"
	"syscall"
	"time"
)

func FileIdentity(_ string, info os.FileInfo) (*[4]int64, time.Time) {
	stat, ok := info.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return nil, time.Time{}
	}
	return nil, time.Unix(0, stat.CreationTime.Nanoseconds())
}

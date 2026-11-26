package platform

import (
	"fmt"

	"golang.org/x/sys/unix"
)

func ProcessStart(pid int) string {
	if pid <= 0 {
		return ""
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || info == nil || info.Proc.P_pid != int32(pid) || info.Proc.P_stat == 5 {
		return ""
	}
	start := info.Proc.P_starttime
	return fmt.Sprintf("%d.%d", start.Sec, start.Usec)
}

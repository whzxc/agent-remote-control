package platform

import (
	"strconv"

	"golang.org/x/sys/windows"
)

func ProcessStart(pid int) string {
	if pid <= 0 {
		return ""
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)
	start := liveProcessStart(handle)
	if start == 0 {
		return ""
	}
	return strconv.FormatUint(start, 10)
}

func liveProcessStart(handle windows.Handle) uint64 {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return 0
	}
	// An exited process still has a creation time while a handle pins it.
	if status, err := windows.WaitForSingleObject(handle, 0); err != nil || status != uint32(windows.WAIT_TIMEOUT) {
		return 0
	}
	return filetimeTicks(created)
}

func filetimeTicks(value windows.Filetime) uint64 {
	return uint64(value.HighDateTime)<<32 | uint64(value.LowDateTime)
}

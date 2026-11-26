package core

import (
	"errors"
	"golang.org/x/sys/windows"
)

func coordinationProcessAlive(pid uint32) (bool, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return false, nil
	}
	if err != nil {
		return false, errors.New("COVERAGE_GAP: process identity unavailable")
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false, errors.New("COVERAGE_GAP: process identity unavailable")
	}
	return code == 259, nil
}

package platform

import (
	"os/exec"
	"strconv"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func OwnChild(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}

func SignalTree(pid int, force bool) {
	SignalVerifiedTree(pid, ProcessStart(pid), force)
}

func SignalVerifiedTree(pid int, expectedStart string, _ bool) {
	if pid <= 0 || expectedStart == "" {
		return
	}
	const access = windows.PROCESS_QUERY_LIMITED_INFORMATION | windows.SYNCHRONIZE | windows.PROCESS_TERMINATE
	root, err := windows.OpenProcess(access, false, uint32(pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(root)
	start := liveProcessStart(root)
	if start == 0 || strconv.FormatUint(start, 10) != expectedStart {
		return
	}

	// A parent PID in the snapshot can refer to an older process. Also
	// exclude any PID reused between the snapshot and opening its handle.
	var cutoff windows.Filetime
	windows.GetSystemTimePreciseAsFileTime(&cutoff)
	children := processChildren()
	var stop func(windows.Handle, uint32, uint64)
	stop = func(process windows.Handle, id uint32, parentStart uint64) {
		_ = windows.TerminateProcess(process, 1)
		for _, childID := range children[id] {
			child, err := windows.OpenProcess(access, false, childID)
			if err != nil {
				continue
			}
			childStart := liveProcessStart(child)
			if childStart > parentStart && childStart <= filetimeTicks(cutoff) {
				stop(child, childID, childStart)
			}
			windows.CloseHandle(child)
		}
	}
	stop(root, uint32(pid), start)
}

func processChildren() map[uint32][]uint32 {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{}
	entry.Size = uint32(unsafe.Sizeof(entry))
	children := make(map[uint32][]uint32)
	for err := windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		children[entry.ParentProcessID] = append(children[entry.ParentProcessID], entry.ProcessID)
	}
	return children
}

func KillOwnedGroup(_ int) {}

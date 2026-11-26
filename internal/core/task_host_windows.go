package core

import (
	"unsafe"

	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/sys/windows"
)

func signalTaskHostAgent(pid int, kill bool) { platform.SignalTree(pid, kill) }

func signalVerifiedTaskHostAgent(pid int, start string) {
	platform.SignalVerifiedTree(pid, start, true)
}

func removeTaskHostSocketDirectory(string) {}

func taskHostOwnTree() (func(), error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, taskHostIO(err)
	}
	cleanup := func() { _ = windows.CloseHandle(job) }
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		cleanup()
		return nil, taskHostIO(err)
	}
	if err := windows.AssignProcessToJobObject(job, windows.CurrentProcess()); err != nil {
		cleanup()
		return nil, taskHostIO(err)
	}
	return cleanup, nil
}

func newTaskHostSocket() (string, error) { return `\\.\pipe\arc-task-` + id(), nil }

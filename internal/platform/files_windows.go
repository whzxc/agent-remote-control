package platform

import (
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/sys/windows"
)

var privateDirs = struct {
	sync.Mutex
	protected map[string]bool
}{protected: make(map[string]bool)}

func PrivateDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	privateDirs.Lock()
	defer privateDirs.Unlock()
	if privateDirs.protected[path] {
		return nil
	}
	whoami := exec.Command("whoami.exe", "/user", "/fo", "csv", "/nh")
	whoami.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	result, err := whoami.Output()
	fields := strings.Split(strings.TrimSpace(string(result)), ",")
	sid := strings.Trim(fields[len(fields)-1], "\"")
	if err != nil || !strings.HasPrefix(sid, "S-1-") {
		return errors.New("Cannot determine the local account")
	}
	acl := exec.Command("icacls.exe", path, "/inheritance:r", "/grant:r", "*"+sid+":(OI)(CI)F")
	acl.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	if err := acl.Run(); err != nil {
		return errors.New("Cannot protect the private directory")
	}
	privateDirs.protected[path] = true
	return nil
}

func ReplaceFile(from, to string) error {
	source, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	target, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(source, target, windows.MOVEFILE_REPLACE_EXISTING)
}

func TryLock(file *os.File) (bool, error) {
	err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return false, nil
	}
	return err == nil, err
}

func Lock(file *os.File, shared bool) error {
	var mode uint32
	if !shared {
		mode = windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	return windows.LockFileEx(windows.Handle(file.Fd()), mode, 0, 1, 0, &windows.Overlapped{})
}

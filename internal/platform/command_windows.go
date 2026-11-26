package platform

import (
	"os/exec"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

func ConfigureCommand(command *exec.Cmd) {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}

var multiByteToWide = windows.NewLazySystemDLL("kernel32.dll").NewProc("MultiByteToWideChar")

func DecodeOEM(data []byte) (string, bool) {
	if len(data) == 0 || len(data) > 1<<31-1 {
		return "", false
	}
	wide := make([]uint16, len(data))
	const oemCP = 1
	n, _, _ := multiByteToWide.Call(oemCP, 0, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)),
		uintptr(unsafe.Pointer(&wide[0])), uintptr(len(wide)))
	if n == 0 {
		return "", false
	}
	return string(utf16.Decode(wide[:n])), true
}

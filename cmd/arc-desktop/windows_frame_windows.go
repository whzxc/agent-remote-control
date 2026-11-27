package main

import (
	"unsafe"

	"github.com/egoist/mygo"
	"golang.org/x/sys/windows"
)

const dwmUseImmersiveDarkMode = 20

var (
	dwm    = windows.NewLazySystemDLL("dwmapi.dll")
	dwmSet = dwm.NewProc("DwmSetWindowAttribute")
)

func applyWindowsFrame(window *mygo.Window, dark bool) error {
	window.SetWindowButtonsTheme(windowsButtonsTheme(dark))
	var value uint32
	if dark {
		value = 1
	}
	if hwnd := window.NativeHandle(); hwnd != 0 {
		dwmSet.Call(hwnd, dwmUseImmersiveDarkMode, uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value))
	}
	return nil
}

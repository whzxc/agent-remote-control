package main

import (
	"errors"
	"fmt"
	"unsafe"

	"github.com/egoist/mygo"
	"golang.org/x/sys/windows"
)

type frameRect struct{ left, top, right, bottom int32 }
type frameMargins struct{ left, right, top, bottom int32 }
type titleBarInfo struct {
	size    uint32
	bounds  frameRect
	state   [6]uint32
	buttons [6]frameRect
}

var (
	dwm               = windows.NewLazySystemDLL("dwmapi.dll")
	dwmSet            = dwm.NewProc("DwmSetWindowAttribute")
	dwmGet            = dwm.NewProc("DwmGetWindowAttribute")
	dwmExtend         = dwm.NewProc("DwmExtendFrameIntoClientArea")
	dwmDefault        = dwm.NewProc("DwmDefWindowProc")
	comctl            = windows.NewLazySystemDLL("comctl32.dll")
	setSubclass       = comctl.NewProc("SetWindowSubclass")
	removeSubclass    = comctl.NewProc("RemoveWindowSubclass")
	defSubclass       = comctl.NewProc("DefSubclassProc")
	user32            = windows.NewLazySystemDLL("user32.dll")
	getDPI            = user32.NewProc("GetDpiForWindow")
	metricsDPI        = user32.NewProc("GetSystemMetricsForDpi")
	windowPos         = user32.NewProc("SetWindowPos")
	windowRect        = user32.NewProc("GetWindowRect")
	windowChild       = user32.NewProc("GetWindow")
	redrawWindow      = user32.NewProc("RedrawWindow")
	sendWindowMessage = user32.NewProc("SendMessageW")
	isZoomed          = user32.NewProc("IsZoomed")
	setRegion         = user32.NewProc("SetWindowRgn")
	gdi               = windows.NewLazySystemDLL("gdi32.dll")
	rectRegion        = gdi.NewProc("CreateRectRgn")
	combineRegion     = gdi.NewProc("CombineRgn")
	deleteRegion      = gdi.NewProc("DeleteObject")
	frameCallback     uintptr
	childCallback     uintptr
)

func init() {
	frameCallback = windows.NewCallback(nativeFrame)
	childCallback = windows.NewCallback(nativeChildFrame)
}

const frameSubclassID = 0x415243
const (
	wmSize            = 0x0005
	wmActivate        = 0x0006
	wmSettingChange   = 0x001a
	wmNCDestroy       = 0x0082
	wmNCCalcSize      = 0x0083
	wmNCHitTest       = 0x0084
	wmDPIChanged      = 0x02e0
	wmThemeChanged    = 0x031a
	wmDWMComposition  = 0x031e
	wmDWMColor        = 0x0320
	wmGetTitleBarInfo = 0x033f
	htClient          = 1
	htTop             = 12
	dwmCaptionBounds  = 5
)

func installWindowsFrame(window *mygo.Window) {
	hwnd := window.NativeHandle()
	logError(applyWindowsFrame(window, mygo.Theme.IsDark()))
	windowPos.Call(hwnd, 0, 0, 0, 0, 0, 0x37) // NOMOVE | NOSIZE | NOZORDER | NOACTIVATE | FRAMECHANGED
	child, _, _ := windowChild.Call(hwnd, 5)  // GW_CHILD
	if child != 0 {
		if ok, _, err := setSubclass.Call(child, childCallback, frameSubclassID, hwnd); ok == 0 {
			logError(err)
		}
	}
	clipCaption(hwnd)
}

func applyWindowsFrame(window *mygo.Window, dark bool) error {
	hwnd := window.NativeHandle()
	var mode uintptr
	if dark {
		mode = 1
	}
	if ok, _, err := setSubclass.Call(hwnd, frameCallback, frameSubclassID, mode); ok == 0 {
		return err
	}
	return refreshFrame(hwnd, mode)
}

func refreshFrame(hwnd, dark uintptr) error {
	caption, text := uint32(0xffffff), uint32(0)
	if dark != 0 {
		caption, text = text, caption
	}
	var failure error
	for _, pair := range [][2]uint32{{20, uint32(dark)}, {35, caption}, {36, text}} {
		value := pair[1]
		status, _, _ := dwmSet.Call(hwnd, uintptr(pair[0]), uintptr(unsafe.Pointer(&value)), unsafe.Sizeof(value))
		if int32(status) < 0 {
			failure = errors.Join(failure, fmt.Errorf("DwmSetWindowAttribute(%d) failed: 0x%08X", pair[0], uint32(status)))
		}
	}
	dpi, _, _ := getDPI.Call(hwnd)
	margins := frameMargins{top: int32(38 * dpi / 96)}
	dwmExtend.Call(hwnd, uintptr(unsafe.Pointer(&margins)))
	clipCaption(hwnd)
	redrawWindow.Call(hwnd, 0, 0, 0x401) // FRAME | INVALIDATE
	return failure
}

func clipCaption(hwnd uintptr) {
	child, _, _ := windowChild.Call(hwnd, 5)
	if child == 0 {
		return
	}
	var caption, outer, area frameRect
	result, _, _ := dwmGet.Call(hwnd, dwmCaptionBounds, uintptr(unsafe.Pointer(&caption)), unsafe.Sizeof(caption))
	if int32(result) < 0 {
		return
	}
	if ok, _, _ := windowRect.Call(hwnd, uintptr(unsafe.Pointer(&outer))); ok == 0 {
		return
	}
	if ok, _, _ := windowRect.Call(child, uintptr(unsafe.Pointer(&area))); ok == 0 {
		return
	}
	region, _, _ := rectRegion.Call(0, 0, uintptr(area.right-area.left), uintptr(area.bottom-area.top))
	if region == 0 {
		return
	}
	hole, _, _ := rectRegion.Call(uintptr(outer.left+caption.left-area.left), 0,
		uintptr(outer.left+caption.right-area.left), uintptr(outer.top+caption.bottom-area.top))
	if hole != 0 {
		combineRegion.Call(region, region, hole, 4) // RGN_DIFF
		deleteRegion.Call(hole)
	}
	if ok, _, _ := setRegion.Call(child, region, 1); ok == 0 {
		deleteRegion.Call(region)
	}
}

func nativeChildFrame(hwnd, msg, w, l, id, parent uintptr) uintptr {
	result, _, _ := defSubclass.Call(hwnd, msg, w, l)
	switch msg {
	case wmSize:
		clipCaption(parent)
	case wmNCDestroy:
		removeSubclass.Call(hwnd, childCallback, id)
	}
	return result
}

func nativeFrame(hwnd, msg, w, l, id, dark uintptr) uintptr {
	zoomed, _, _ := isZoomed.Call(hwnd)
	topFrame := func() int32 {
		dpi, _, _ := getDPI.Call(hwnd)
		border, _, _ := metricsDPI.Call(33, dpi) // SM_CYFRAME
		pad, _, _ := metricsDPI.Call(92, dpi)    // SM_CXPADDEDBORDER
		return int32(border + pad)
	}
	if msg == wmNCCalcSize && w != 0 {
		// lParam is Win32's live NCCALCSIZE_PARAMS pointer.
		r := winFrameRect(l)
		top := r.top
		defSubclass.Call(hwnd, msg, w, l)
		r.top = top
		if zoomed != 0 {
			r.top += topFrame()
		}
		return 0
	}
	var result uintptr
	handled, _, _ := dwmDefault.Call(hwnd, msg, w, l, uintptr(unsafe.Pointer(&result)))
	switch msg {
	case wmActivate, wmThemeChanged, wmSettingChange, wmDWMColor, wmDWMComposition, wmDPIChanged:
		if handled == 0 {
			result, _, _ = defSubclass.Call(hwnd, msg, w, l)
		}
		logError(refreshFrame(hwnd, dark))
		return result
	case wmNCDestroy:
		removeSubclass.Call(hwnd, frameCallback, id)
	}
	if handled != 0 {
		return result
	}
	if msg == wmNCHitTest {
		x, y := int32(int16(l)), int32(int16(l>>16))
		if zoomed != 0 {
			info := titleBarInfo{size: uint32(unsafe.Sizeof(titleBarInfo{}))}
			sendWindowMessage.Call(hwnd, wmGetTitleBarInfo, 0, uintptr(unsafe.Pointer(&info)))
			for _, hit := range [][2]int{{2, 8}, {3, 9}, {5, 20}} {
				rect := info.buttons[hit[0]]
				if x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom {
					return uintptr(hit[1])
				}
			}
		}
		result, _, _ = defSubclass.Call(hwnd, msg, w, l)
		if result == htClient && zoomed == 0 {
			var rect frameRect
			windowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect)))
			if y < rect.top+topFrame() {
				return htTop
			}
		}
		return result
	}
	result, _, _ = defSubclass.Call(hwnd, msg, w, l)
	return result
}

//go:nocheckptr
func winFrameRect(lparam uintptr) *frameRect {
	return *(**frameRect)(unsafe.Pointer(&lparam))
}

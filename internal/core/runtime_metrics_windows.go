package core

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var runtimeWindowsMemory = windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo")

func runtimeProcessMetrics() object {
	handle := windows.CurrentProcess()
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return runtimeProcessUnavailable(err)
	}
	var memory struct {
		size, pageFaults                                                                       uint32
		peakWorking, working, peakPaged, paged, peakNonPaged, nonPaged, pageFile, peakPageFile uintptr
	}
	memory.size = uint32(unsafe.Sizeof(memory))
	if ok, _, err := runtimeWindowsMemory.Call(uintptr(handle), uintptr(unsafe.Pointer(&memory)), uintptr(memory.size)); ok == 0 {
		return runtimeProcessUnavailable(err)
	}
	ticks := func(value windows.Filetime) uint64 { return uint64(value.HighDateTime)<<32 | uint64(value.LowDateTime) }
	return object{"state": "available", "cpuTotalMs": float64(ticks(kernel)+ticks(user)) / 10000,
		"residentBytes": memory.working, "physicalFootprintBytes": nil}
}

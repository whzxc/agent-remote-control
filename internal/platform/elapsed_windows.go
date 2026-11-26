package platform

import (
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var clockKernel = windows.NewLazySystemDLL("kernel32.dll")
var queryPerformanceCounter = clockKernel.NewProc("QueryPerformanceCounter")
var performanceFrequency = sync.OnceValue(func() time.Duration {
	var frequency int64
	if ok, _, _ := clockKernel.NewProc("QueryPerformanceFrequency").Call(uintptr(unsafe.Pointer(&frequency))); ok == 0 {
		return 0
	}
	return time.Duration(frequency)
})

func performanceCounter() (int64, bool) {
	var ticks int64
	ok, _, _ := queryPerformanceCounter.Call(uintptr(unsafe.Pointer(&ticks)))
	return ticks, ok != 0
}

// StartElapsed uses the Windows clock used by Rust Instant. Go's tick clock
// can report the same timestamp on both sides of short measured operations.
func StartElapsed() func() time.Duration {
	started := time.Now()
	frequency := performanceFrequency()
	first, ok := performanceCounter()
	return func() time.Duration {
		if frequency > 0 && ok {
			if last, valid := performanceCounter(); valid && last >= first {
				ticks := time.Duration(last - first)
				return ticks/frequency*time.Second + ticks%frequency*time.Second/frequency
			}
		}
		return time.Since(started)
	}
}

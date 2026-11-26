package core

import (
	"errors"
	"os"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
)

var runtimeProcessDarwin = sync.OnceValues(func() (func(int32, int32, unsafe.Pointer) int32, error) {
	library, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_LOCAL)
	if err != nil {
		return nil, err
	}
	symbol, err := purego.Dlsym(library, "proc_pid_rusage")
	if err != nil {
		return nil, err
	}
	var read func(int32, int32, unsafe.Pointer) int32
	purego.RegisterFunc(&read, symbol)
	return read, nil
})

func runtimeProcessMetrics() object {
	read, err := runtimeProcessDarwin()
	if err != nil {
		return runtimeProcessUnavailable(err)
	}
	// Darwin rusage_info_v2 starts with a 16-byte UUID followed by 18 uint64 fields.
	var info struct {
		uuid                                                                                               [16]byte
		user, system, packageIdleWakeups, interruptWakeups, pageIns, wired                                 uint64
		resident, footprint, started, exited                                                               uint64
		childUser, childSystem, childPackageIdleWakeups, childInterruptWakeups, childPageIns, childElapsed uint64
		diskRead, diskWrite                                                                                uint64
	}
	if read(int32(os.Getpid()), 2, unsafe.Pointer(&info)) != 0 {
		return runtimeProcessUnavailable(errors.New("proc_pid_rusage failed"))
	}
	var usage unix.Rusage
	if err := unix.Getrusage(unix.RUSAGE_SELF, &usage); err != nil {
		return runtimeProcessUnavailable(err)
	}
	return object{"state": "available", "cpuTotalMs": float64(usage.Utime.Nano()+usage.Stime.Nano()) / 1e6,
		"residentBytes": info.resident, "physicalFootprintBytes": info.footprint, "diskReadBytes": info.diskRead, "diskWriteBytes": info.diskWrite}
}

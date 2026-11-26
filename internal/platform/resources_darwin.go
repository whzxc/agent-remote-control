package platform

import (
	"errors"
	"fmt"
	"github.com/ebitengine/purego"
	"golang.org/x/sys/unix"
	"sync"
)

func NoFileCeiling() (uint64, error) {
	limit, err := unix.SysctlUint32("kern.maxfilesperproc")
	if err != nil {
		return 0, fmt.Errorf("kern.maxfilesperproc: %w", err)
	}
	if limit == 0 {
		return 0, errors.New("kern.maxfilesperproc returned an invalid limit")
	}
	return uint64(min(limit, 10240)), nil
}
func ChildFileLimits(_ int) (uint64, uint64, error) { return 0, 0, nil }

var procFdSampler = sync.OnceValues(func() (func(int32, int32, uint64, []byte, int32) int32, error) {
	library, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_LOCAL)
	if err != nil {
		return nil, err
	}
	symbol, err := purego.Dlsym(library, "proc_pidinfo")
	if err != nil {
		return nil, err
	}
	var sampler func(int32, int32, uint64, []byte, int32) int32
	purego.RegisterFunc(&sampler, symbol)
	return sampler, nil
})

func DescriptorCount(pid int) (uint64, error) {
	const listFDs = 1
	const recordBytes = 8
	sampler, err := procFdSampler()
	if err != nil {
		return 0, err
	}
	size := sampler(int32(pid), listFDs, 0, nil, 0)
	if size <= 0 {
		return 0, errors.New("fd list is unavailable")
	}
	for range 3 {
		size += 32 * recordBytes
		if size > 16*1024*1024 {
			return 0, errors.New("fd list exceeds sampling budget")
		}
		buffer := make([]byte, size)
		used := sampler(int32(pid), listFDs, 0, buffer, size)
		if used <= 0 {
			return 0, errors.New("fd list is unavailable")
		}
		if used < size {
			return uint64(used / recordBytes), nil
		}
		size *= 2
	}
	return 0, errors.New("fd list changed during sampling")
}

package core

import (
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func runtimeProcessMetrics() object {
	var usage unix.Rusage
	if err := unix.Getrusage(unix.RUSAGE_SELF, &usage); err != nil {
		return runtimeProcessUnavailable(err)
	}
	result := object{"state": "partial", "cpuTotalMs": float64(usage.Utime.Nano()+usage.Stime.Nano()) / 1e6,
		"residentBytes": nil, "physicalFootprintBytes": nil}
	if data, err := os.ReadFile("/proc/self/statm"); err == nil {
		if fields := strings.Fields(string(data)); len(fields) > 1 {
			if pages, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
				result["state"], result["residentBytes"] = "available", pages*uint64(os.Getpagesize())
			}
		}
	}
	return result
}

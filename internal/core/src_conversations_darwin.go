package core

import (
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func srcPlatformSupported() bool {
	version, err := unix.Sysctl("kern.osproductversion")
	if err != nil {
		return false
	}
	major, _, _ := strings.Cut(version, ".")
	release, err := strconv.Atoi(major)
	return err == nil && release >= 14
}

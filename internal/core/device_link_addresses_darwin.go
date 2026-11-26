package core

import (
	"net"
	"strings"
)

func devicePhysicalInterface(nic net.Interface) bool {
	suffix, ok := strings.CutPrefix(nic.Name, "en")
	return ok && suffix != "" && strings.IndexFunc(suffix, func(r rune) bool { return r < '0' || r > '9' }) < 0
}

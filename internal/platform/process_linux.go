package platform

import (
	"os"
	"strconv"
	"strings"
)

func ProcessStart(pid int) string {
	if pid <= 0 {
		return ""
	}
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return ""
	}
	after := strings.LastIndexByte(string(data), ')')
	if after < 0 {
		return ""
	}
	fields := strings.Fields(string(data[after+1:]))
	if len(fields) <= 19 || fields[0] == "Z" {
		return ""
	}
	return fields[19]
}

package core

import (
	"net"
	"os"
	"path/filepath"
)

func devicePhysicalInterface(nic net.Interface) bool {
	_, err := os.Stat(filepath.Join("/sys/class/net", nic.Name, "device"))
	return err == nil
}

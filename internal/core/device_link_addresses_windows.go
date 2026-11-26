package core

import (
	"net"

	"golang.org/x/sys/windows"
)

func devicePhysicalInterface(nic net.Interface) bool {
	row := windows.MibIfRow2{InterfaceIndex: uint32(nic.Index)}
	return windows.GetIfEntry2Ex(windows.MibIfTableNormal, &row) == nil &&
		row.InterfaceAndOperStatusFlags&3 == 1 && row.OperStatus == windows.IfOperStatusUp
}

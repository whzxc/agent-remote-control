package core

import (
	"net"
	"net/netip"
	"slices"
	"testing"
)

func TestDeviceOnlyUpPhysicalLANAddressesRemainInPreferenceOrder(t *testing.T) {
	// Algorithmic core: eligible LAN addresses are unique and ordered by address family and scope.
	private := netip.MustParseAddr("192.168.1.2")
	nic := net.Interface{Name: "en0", Flags: net.FlagRunning | net.FlagUp}
	if !deviceUsableInterface(nic, private) {
		t.Fatal("active private LAN address rejected")
	}
	for _, name := range []string{"utun4", "awdl0", "llw0", "bridge0", "veth5", "docker0", "vmnet1", "vEthernet"} {
		trial := nic
		trial.Name = name
		if deviceUsableInterface(trial, private) {
			t.Fatalf("virtual interface %s accepted", name)
		}
	}
	for _, flags := range []net.Flags{net.FlagUp, net.FlagRunning | net.FlagPointToPoint, net.FlagRunning | net.FlagLoopback} {
		trial := nic
		trial.Flags = flags
		if deviceUsableInterface(trial, private) {
			t.Fatalf("ineligible interface flags %v accepted", flags)
		}
	}
	if deviceUsableInterface(nic, netip.MustParseAddr("8.8.8.8")) || !deviceLANAddress(netip.MustParseAddr("::ffff:192.168.1.2")) {
		t.Fatal("LAN address classification differs by representation")
	}
	v4 := netip.MustParseAddrPort("192.168.1.2:7143")
	ula := netip.MustParseAddrPort("[fd00::1]:7143")
	linkLocal := netip.MustParseAddrPort("[fe80::1%1]:7143")
	if got := deviceSortSockets([]netip.AddrPort{linkLocal, ula, v4, v4}); !slices.Equal(got, []netip.AddrPort{v4, ula, linkLocal}) {
		t.Fatalf("unexpected LAN socket preference: %v", got)
	}
}

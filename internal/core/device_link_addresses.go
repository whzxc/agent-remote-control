package core

import (
	"cmp"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"strings"
)

var deviceVirtualPrefix = []string{
	"utun", "tun", "tap", "awdl", "llw", "bridge", "veth", "docker", "virbr",
	"vmnet", "vbox", "tailscale", "wg", "ipsec", "gif", "stf", "sit", "zt",
	"ham", "vnic", "vethernet", "hyper-v", "virtual", "vpn", "wireguard",
}

func deviceLANAddress(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func deviceUsableInterface(nic net.Interface, ip netip.Addr) bool {
	if nic.Flags&net.FlagRunning == 0 || nic.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 || !deviceLANAddress(ip) {
		return false
	}
	name := strings.ToLower(nic.Name)
	return !slices.ContainsFunc(deviceVirtualPrefix, func(prefix string) bool {
		return strings.HasPrefix(name, prefix)
	})
}

type deviceLANBinding struct {
	nic  net.Interface
	addr netip.AddrPort
}

func deviceLANBindings(port uint16) ([]deviceLANBinding, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	var bindings []deviceLANBinding
	for _, nic := range interfaces {
		if !devicePhysicalInterface(nic) {
			continue
		}
		addresses, err := nic.Addrs()
		if err != nil {
			// The interface may have disappeared since enumerating the list.
			continue
		}
		for _, address := range addresses {
			prefix, err := netip.ParsePrefix(address.String())
			ip := prefix.Addr()
			if err != nil || !deviceUsableInterface(nic, ip) {
				continue
			}
			if ip.Is6() && ip.IsLinkLocalUnicast() {
				ip = ip.WithZone(strconv.Itoa(nic.Index))
			}
			bindings = append(bindings, deviceLANBinding{nic, netip.AddrPortFrom(ip, port)})
		}
	}
	return bindings, nil
}

func deviceAddressRank(ip netip.Addr) int {
	if ip.IsPrivate() {
		if ip.Is4() {
			return 0
		}
		return 1
	}
	return 2
}

func deviceSortSockets(addresses []netip.AddrPort) []netip.AddrPort {
	slices.SortFunc(addresses, func(a, b netip.AddrPort) int {
		if order := cmp.Compare(deviceAddressRank(a.Addr()), deviceAddressRank(b.Addr())); order != 0 {
			return order
		}
		if order := a.Addr().WithZone("").Compare(b.Addr().WithZone("")); order != 0 {
			return order
		}
		if order := cmp.Compare(a.Port(), b.Port()); order != 0 {
			return order
		}
		aScope, _ := strconv.Atoi(a.Addr().Zone())
		bScope, _ := strconv.Atoi(b.Addr().Zone())
		return cmp.Compare(aScope, bScope)
	})
	return slices.Compact(addresses)
}

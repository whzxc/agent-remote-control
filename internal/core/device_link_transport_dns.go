package core

import (
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"

	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

const deviceDNSService = "_arc-peer._tcp.local."
const deviceDNSPort = 5353

type deviceDNSEndpoint struct {
	socket *net.UDPConn
	group  *net.UDPAddr
}

func advertiseDeviceDNS(identity *deviceIdentity, port uint16, bindings []deviceLANBinding) (func(), error) {
	if len(bindings) == 0 {
		return func() {}, nil
	}
	service := dnsmessage.MustNewName(deviceDNSService)
	instance := dnsmessage.MustNewName(identity.id[:32] + "." + deviceDNSService)
	host := dnsmessage.MustNewName("arc-" + identity.id[:32] + ".local.")
	const flush = dnsmessage.ClassINET | 0x8000
	resources := []dnsmessage.Resource{
		{Header: dnsmessage.ResourceHeader{Name: service, Class: dnsmessage.ClassINET, TTL: 4500}, Body: &dnsmessage.PTRResource{PTR: instance}},
		{Header: dnsmessage.ResourceHeader{Name: instance, Class: flush, TTL: 120}, Body: &dnsmessage.SRVResource{Port: port, Target: host}},
		{Header: dnsmessage.ResourceHeader{Name: instance, Class: flush, TTL: 4500}, Body: &dnsmessage.TXTResource{TXT: []string{"id=" + identity.id, "version=3"}}},
	}
	type interfaceFamily struct {
		index int
		ipv6  bool
	}
	opened := map[interfaceFamily]bool{}
	advertised := map[netip.Addr]bool{}
	endpoints := []deviceDNSEndpoint{}
	closeAll := func() {
		for _, endpoint := range endpoints {
			endpoint.socket.Close()
		}
	}
	var lastErr error
	for _, binding := range bindings {
		ip := binding.addr.Addr().WithZone("")
		if !advertised[ip] {
			advertised[ip] = true
			header := dnsmessage.ResourceHeader{Name: host, Class: flush, TTL: 120}
			if ip.Is4() {
				resources = append(resources, dnsmessage.Resource{Header: header, Body: &dnsmessage.AResource{A: ip.As4()}})
			} else {
				resources = append(resources, dnsmessage.Resource{Header: header, Body: &dnsmessage.AAAAResource{AAAA: ip.As16()}})
			}
		}
		family := interfaceFamily{binding.nic.Index, ip.Is6()}
		if opened[family] {
			continue
		}
		opened[family] = true
		endpoint, err := deviceListenDNS(binding.nic, family.ipv6)
		if err != nil {
			lastErr = err
			recordLog("WARN", "Device link mDNS listen skipped: "+err.Error(), nil)
			continue
		}
		endpoints = append(endpoints, endpoint)
	}
	if len(endpoints) == 0 {
		if lastErr != nil {
			return nil, lastErr
		}
		return func() {}, nil
	}
	message := dnsmessage.Message{Header: dnsmessage.Header{Response: true, Authoritative: true}, Answers: resources}
	packet, err := message.Pack()
	if err != nil {
		closeAll()
		return nil, err
	}
	var workers sync.WaitGroup
	active := make([]deviceDNSEndpoint, 0, len(endpoints))
	for _, endpoint := range endpoints {
		if _, err := endpoint.socket.WriteToUDP(packet, endpoint.group); err != nil {
			lastErr = err
			recordLog("WARN", "Device link mDNS announce skipped: "+err.Error(), nil)
			endpoint.socket.Close()
			continue
		}
		active = append(active, endpoint)
		workers.Go(func() { endpoint.respond(message, service, instance, host) })
	}
	if len(active) == 0 {
		workers.Wait()
		if lastErr != nil {
			return nil, lastErr
		}
		return func() {}, nil
	}
	endpoints = active
	return func() {
		goodbye := dnsmessage.Message{Header: message.Header, Answers: append([]dnsmessage.Resource(nil), resources...)}
		for i := range goodbye.Answers {
			goodbye.Answers[i].Header.TTL = 0
		}
		if packet, err := goodbye.Pack(); err == nil {
			for _, endpoint := range endpoints {
				_, _ = endpoint.socket.WriteToUDP(packet, endpoint.group)
			}
		}
		closeAll()
		workers.Wait()
	}, nil
}

func deviceListenDNS(nic net.Interface, useIPv6 bool) (deviceDNSEndpoint, error) {
	network := "udp4"
	group := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: deviceDNSPort}
	if useIPv6 {
		network = "udp6"
		group.IP = net.ParseIP("ff02::fb")
		group.Zone = nic.Name
	}
	socket, err := net.ListenMulticastUDP(network, &nic, group)
	if err != nil {
		return deviceDNSEndpoint{}, err
	}
	if useIPv6 {
		conn := ipv6.NewPacketConn(socket)
		err = errors.Join(conn.SetMulticastInterface(&nic), conn.SetMulticastHopLimit(255), conn.SetHopLimit(255))
	} else {
		conn := ipv4.NewPacketConn(socket)
		err = errors.Join(conn.SetMulticastInterface(&nic), conn.SetMulticastTTL(255), conn.SetTTL(255))
	}
	if err != nil {
		socket.Close()
		return deviceDNSEndpoint{}, err
	}
	return deviceDNSEndpoint{socket, group}, nil
}

func (endpoint deviceDNSEndpoint) respond(response dnsmessage.Message, names ...dnsmessage.Name) {
	buf := make([]byte, 9000)
	for {
		n, sender, err := endpoint.socket.ReadFromUDP(buf)
		if err != nil {
			return
		}
		if !deviceLANAddress(sender.AddrPort().Addr()) {
			continue
		}
		var incoming dnsmessage.Message
		if incoming.Unpack(buf[:n]) != nil || incoming.Response || incoming.OpCode != 0 {
			continue
		}
		dest := endpoint.group
		out := response
		matched := false
		for _, question := range incoming.Questions {
			if question.Class&0x7fff != dnsmessage.ClassINET {
				continue
			}
			for _, name := range names {
				if strings.EqualFold(question.Name.String(), name.String()) {
					matched = true
					if question.Class&0x8000 != 0 || sender.Port != deviceDNSPort {
						dest = sender
					}
				}
			}
		}
		if !matched {
			continue
		}
		if sender.Port != deviceDNSPort {
			out.ID, out.Questions = incoming.ID, incoming.Questions
		}
		if data, err := out.Pack(); err == nil {
			_, _ = endpoint.socket.WriteToUDP(data, dest)
		}
	}
}

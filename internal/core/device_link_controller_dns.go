package core

import (
	"context"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

type deviceResolution struct {
	fullname  string
	addresses []netip.AddrPort
	version   uint16
	expires   time.Time
}

func (c *deviceController) discoveryLoop(ctx context.Context) {
	if runtimeFixture {
		return
	}
	service := dnsmessage.MustNewName(deviceDNSService)
	query, err := (&dnsmessage.Message{Questions: []dnsmessage.Question{{Name: service, Type: dnsmessage.TypePTR, Class: dnsmessage.ClassINET}}}).Pack()
	if err != nil {
		return
	}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		if deviceEnabled() {
			bindings, err := deviceLANBindings(0)
			if err == nil {
				var workers sync.WaitGroup
				opened := map[[2]int]bool{}
				for _, binding := range bindings {
					v6 := binding.addr.Addr().Is6()
					key := [2]int{binding.nic.Index, 4}
					if v6 {
						key[1] = 6
					}
					if opened[key] {
						continue
					}
					opened[key] = true
					workers.Go(func() { c.discoverOnInterface(ctx, binding, v6, query) })
				}
				workers.Wait()
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *deviceController) discoverOnInterface(ctx context.Context, binding deviceLANBinding, v6 bool, query []byte) {
	endpoint, err := deviceListenDNS(binding.nic, v6)
	if err != nil {
		return
	}
	defer endpoint.socket.Close()
	defer context.AfterFunc(ctx, func() { _ = endpoint.socket.Close() })()
	if _, err := endpoint.socket.WriteToUDP(query, endpoint.group); err != nil {
		return
	}
	_ = endpoint.socket.SetReadDeadline(time.Now().Add(time.Second))
	data := make([]byte, 9000)
	for {
		n, addr, err := endpoint.socket.ReadFromUDP(data)
		if err != nil {
			return
		}
		if !deviceLANAddress(addr.AddrPort().Addr()) {
			continue
		}
		var message dnsmessage.Message
		if message.Unpack(data[:n]) != nil || !message.Response {
			continue
		}
		c.discoveredMessage(message, binding.nic.Index)
	}
}

func (c *deviceController) discoveredMessage(message dnsmessage.Message, index int) {
	type serviceRecord struct {
		target string
		port   uint16
		ttl    uint32
	}
	type serviceProperties struct {
		id      string
		version uint16
		valid   bool
	}
	records := map[string]serviceRecord{}
	properties := map[string]serviceProperties{}
	addresses := map[string][]netip.Addr{}
	removed := map[string]bool{}
	for _, recordsSection := range [][]dnsmessage.Resource{message.Answers, message.Additionals} {
		for _, resource := range recordsSection {
			name := strings.ToLower(resource.Header.Name.String())
			switch body := resource.Body.(type) {
			case *dnsmessage.PTRResource:
				if name == deviceDNSService && resource.Header.TTL == 0 {
					removed[strings.ToLower(body.PTR.String())] = true
				}
			case *dnsmessage.SRVResource:
				if strings.HasSuffix(name, "."+deviceDNSService) && body.Port != 0 {
					records[name] = serviceRecord{strings.ToLower(body.Target.String()), body.Port, resource.Header.TTL}
				}
			case *dnsmessage.TXTResource:
				if strings.HasSuffix(name, "."+deviceDNSService) {
					entry := serviceProperties{}
					for _, pair := range body.TXT {
						key, value, _ := strings.Cut(pair, "=")
						switch key {
						case "id":
							entry.id = value
						case "version":
							version, err := strconv.ParseUint(value, 10, 16)
							entry.version, entry.valid = uint16(version), err == nil
						}
					}
					properties[name] = entry
				}
			case *dnsmessage.AResource:
				if resource.Header.TTL != 0 && len(addresses[name]) < 64 {
					addresses[name] = append(addresses[name], netip.AddrFrom4(body.A))
				}
			case *dnsmessage.AAAAResource:
				if resource.Header.TTL != 0 && len(addresses[name]) < 64 {
					ip := netip.AddrFrom16(body.AAAA)
					if ip.IsLinkLocalUnicast() {
						ip = ip.WithZone(strconv.Itoa(index))
					}
					addresses[name] = append(addresses[name], ip)
				}
			}
		}
	}
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	for id, entry := range c.discovered {
		if removed[entry.fullname] || time.Now().After(entry.expires) {
			delete(c.discovered, id)
		}
	}
	for instance, record := range records {
		props := properties[instance]
		if len(props.id) != 64 || !props.valid || record.ttl == 0 || removed[instance] {
			continue
		}
		if _, ok := c.pairedDiscoveryIDs.Load(props.id); !ok {
			continue
		}
		sockets := []netip.AddrPort{}
		for _, address := range addresses[record.target] {
			if deviceLANAddress(address) {
				sockets = append(sockets, netip.AddrPortFrom(address, record.port))
			}
		}
		if old := c.discovered[props.id]; old.fullname == instance && old.version == props.version {
			sockets = append(sockets, old.addresses...)
		}
		sockets = deviceSortSockets(sockets)
		c.discovered[props.id] = deviceResolution{instance, sockets[:min(len(sockets), 64)], props.version, time.Now().Add(time.Duration(record.ttl) * time.Second)}
	}
}

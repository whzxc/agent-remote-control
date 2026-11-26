package core

import (
	"context"
	"maps"
	"net/netip"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

type deviceResolution struct {
	addresses []netip.AddrPort
	version   uint16
}

type deviceDNSKey struct {
	name string
	kind dnsmessage.Type
}

type deviceDNSRecord struct {
	body    dnsmessage.ResourceBody
	expires time.Time
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
	now := time.Now()
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	if c.discovery == nil {
		c.discovery = make(map[int]map[deviceDNSKey][]deviceDNSRecord)
	}
	cache := c.discovery[index]
	if cache == nil {
		cache = make(map[deviceDNSKey][]deviceDNSRecord)
		c.discovery[index] = cache
	}
	for key, records := range cache {
		records = slices.DeleteFunc(records, func(record deviceDNSRecord) bool { return !record.expires.After(now) })
		if len(records) == 0 {
			delete(cache, key)
		} else {
			cache[key] = records
		}
	}
	flushed := make(map[deviceDNSKey]bool)
	for _, section := range [][]dnsmessage.Resource{message.Answers, message.Additionals} {
		for _, record := range section {
			header := record.Header
			if header.Class&0x7fff != dnsmessage.ClassINET {
				continue
			}
			name := strings.ToLower(header.Name.String())
			switch body := record.Body.(type) {
			case *dnsmessage.PTRResource:
				if name == deviceDNSService && header.TTL == 0 {
					fullname := strings.ToLower(body.PTR.String())
					delete(cache, deviceDNSKey{fullname, dnsmessage.TypeSRV})
					delete(cache, deviceDNSKey{fullname, dnsmessage.TypeTXT})
				}
				continue
			case *dnsmessage.SRVResource, *dnsmessage.TXTResource:
				if !strings.HasSuffix(name, "."+deviceDNSService) {
					continue
				}
			case *dnsmessage.AResource, *dnsmessage.AAAAResource:
				if !strings.HasSuffix(name, ".local.") {
					continue
				}
			default:
				continue
			}
			key := deviceDNSKey{name, header.Type}
			if header.TTL == 0 {
				records := slices.DeleteFunc(cache[key], func(recordDNS deviceDNSRecord) bool { return reflect.DeepEqual(recordDNS.body, record.Body) })
				if len(records) == 0 {
					delete(cache, key)
				} else {
					cache[key] = records
				}
				continue
			}
			if header.Class&0x8000 != 0 && !flushed[key] {
				delete(cache, key)
				flushed[key] = true
			}
			records := cache[key]
			if records == nil && len(cache) >= 512 {
				continue
			}
			records = slices.DeleteFunc(records, func(recordDNS deviceDNSRecord) bool { return reflect.DeepEqual(recordDNS.body, record.Body) })
			if len(records) < 64 {
				cache[key] = append(records, deviceDNSRecord{record.Body, now.Add(time.Duration(header.TTL) * time.Second)})
			}
		}
	}
}

func (c *deviceController) deviceDiscovery(id string, now time.Time) (deviceResolution, bool) {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	if _, paired := c.pairedDiscoveryIDs.Load(id); !paired {
		return deviceResolution{}, false
	}
	var result deviceResolution
	found := false
	for _, index := range slices.Sorted(maps.Keys(c.discovery)) {
		cache := c.discovery[index]
		for key, records := range cache {
			if key.kind != dnsmessage.TypeTXT {
				continue
			}
			for _, record := range records {
				if !record.expires.After(now) {
					continue
				}
				properties := record.body.(*dnsmessage.TXTResource)
				var device, protocol string
				for _, property := range properties.TXT {
					name, value, _ := strings.Cut(property, "=")
					switch name {
					case "id":
						device = value
					case "version":
						protocol = value
					}
				}
				version, err := strconv.ParseUint(protocol, 10, 16)
				if device != id || err != nil || found && uint16(version) != result.version {
					continue
				}
				for _, service := range cache[deviceDNSKey{key.name, dnsmessage.TypeSRV}] {
					endpoint := service.body.(*dnsmessage.SRVResource)
					if service.expires.After(now) && endpoint.Port != 0 {
						found, result.version = true, uint16(version)
						target := strings.ToLower(endpoint.Target.String())
						result.addresses = append(result.addresses, deviceDNSAddresses(cache, target, endpoint.Port, index, now)...)
					}
				}
			}
		}
	}
	sockets := deviceSortSockets(result.addresses)
	result.addresses = sockets[:min(len(sockets), 64)]
	return result, found
}

func deviceDNSAddresses(cache map[deviceDNSKey][]deviceDNSRecord, target string, port uint16, index int, now time.Time) []netip.AddrPort {
	addresses := []netip.AddrPort{}
	for _, kind := range []dnsmessage.Type{dnsmessage.TypeA, dnsmessage.TypeAAAA} {
		for _, record := range cache[deviceDNSKey{target, kind}] {
			if !record.expires.After(now) {
				continue
			}
			var address netip.Addr
			switch value := record.body.(type) {
			case *dnsmessage.AResource:
				address = netip.AddrFrom4(value.A)
			case *dnsmessage.AAAAResource:
				address = netip.AddrFrom16(value.AAAA)
				if address.IsLinkLocalUnicast() {
					address = address.WithZone(strconv.Itoa(index))
				}
			}
			if deviceLANAddress(address) {
				addresses = append(addresses, netip.AddrPortFrom(address, port))
			}
		}
	}
	return addresses
}

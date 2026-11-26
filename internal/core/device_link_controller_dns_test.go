package core

import (
	"net/netip"
	"slices"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

func TestDeviceDNSResolvesSplitRecordsAndExpiresReplacedAddresses(t *testing.T) {
	// Contract: only paired DNS-SD identities resolve, across split packets, with scoped addresses, cache flush and goodbye handling.
	controller := &deviceController{}
	device := strings.Repeat("a", 64)
	controller.pairedDiscoveryIDs.Store(device, struct{}{})
	service := dnsmessage.MustNewName(deviceDNSService)
	instance := dnsmessage.MustNewName("fixture." + deviceDNSService)
	target := dnsmessage.MustNewName("fixture.local.")
	submit := func(index int, name dnsmessage.Name, typ dnsmessage.Type, ttl uint32, class dnsmessage.Class, body dnsmessage.ResourceBody) {
		t.Helper()
		controller.discoveredMessage(dnsmessage.Message{Answers: []dnsmessage.Resource{{
			Header: dnsmessage.ResourceHeader{Name: name, Type: typ, Class: class, TTL: ttl}, Body: body,
		}}}, index)
	}
	srv := &dnsmessage.SRVResource{Port: 7143, Target: target}
	txt := &dnsmessage.TXTResource{TXT: []string{"id=" + device, "version=3"}}
	link := &dnsmessage.AAAAResource{AAAA: netip.MustParseAddr("fe80::a").As16()}
	old := &dnsmessage.AResource{A: [4]byte{192, 168, 6, 1}}
	replacement := &dnsmessage.AResource{A: [4]byte{192, 168, 6, 2}}
	class := dnsmessage.ClassINET
	flush := class | 0x8000
	submit(3, instance, dnsmessage.TypeSRV, 120, class, srv)
	submit(3, target, dnsmessage.TypeA, 120, class, old)
	submit(3, target, dnsmessage.TypeAAAA, 120, class, link)
	submit(3, instance, dnsmessage.TypeTXT, 120, class, txt)
	submit(8, instance, dnsmessage.TypeTXT, 120, class, txt)
	submit(8, instance, dnsmessage.TypeSRV, 120, class, srv)
	submit(8, target, dnsmessage.TypeAAAA, 120, class, link)
	if _, found := controller.deviceDiscovery(strings.Repeat("b", 64), time.Now()); found {
		t.Fatal("unpaired DNS identity resolved")
	}
	read := func(want ...string) {
		t.Helper()
		resolved, found := controller.deviceDiscovery(device, time.Now())
		var got []string
		for _, address := range resolved.addresses {
			got = append(got, address.String())
		}
		if !found || resolved.version != deviceProtocolVersion || !slices.Equal(got, want) {
			t.Fatalf("resolved %v, want %v", got, want)
		}
	}
	read("192.168.6.1:7143", "[fe80::a%3]:7143", "[fe80::a%8]:7143")
	submit(3, target, dnsmessage.TypeA, 120, flush, replacement)
	read("192.168.6.2:7143", "[fe80::a%3]:7143", "[fe80::a%8]:7143")
	submit(8, service, dnsmessage.TypePTR, 0, class, &dnsmessage.PTRResource{PTR: instance})
	read("192.168.6.2:7143", "[fe80::a%3]:7143")
	if _, found := controller.deviceDiscovery(device, time.Now().Add(121*time.Second)); found {
		t.Fatal("expired device service records resolved")
	}
}

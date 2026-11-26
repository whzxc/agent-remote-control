package core

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/net/http2"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type deviceChannel struct {
	connection *http2.ClientConn
}

func (c *deviceChannel) close() { _ = c.connection.Close() }

func (c *deviceChannel) request(ctx context.Context, path string, body object, bound time.Duration) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://arc-peer.local"+path, strings.NewReader(wire(body)))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	// ClientConn.RoundTrip submits at most once. Transport.RoundTrip can redial and retry.
	request.GetBody = nil
	response, err := c.connection.RoundTrip(request)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("DEVICE_RESPONSE_LOST: Peer request deadline expired; read query guide.")
		}
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxFrameBytes+1))
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, errors.New("DEVICE_RESPONSE_LOST: Peer request deadline expired; read query guide.")
	}
	if err != nil {
		return nil, err
	}
	if len(data) > maxFrameBytes {
		return nil, errors.New("length limit exceeded")
	}
	var value any
	if err := canonjson.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if field(value, "ok") != true {
		return nil, errors.New(wire(field(value, "error")))
	}
	return field(value, "result"), nil
}

type deviceSession struct {
	mu      sync.Mutex
	channel *deviceChannel
}

func (s *deviceSession) cached() *deviceChannel {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.channel != nil && s.channel.connection.CanTakeNewRequest() {
		return s.channel
	}
	return nil
}

func (s *deviceSession) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.channel != nil {
		s.channel.close()
		s.channel = nil
	}
}

func (s *deviceSession) connect(ctx context.Context, identity *deviceIdentity, id string, addresses []netip.AddrPort) (*deviceChannel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.channel != nil {
		if s.channel.connection.CanTakeNewRequest() {
			return s.channel, nil
		}
		s.channel.close()
		s.channel = nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	config := deviceClientTLS(identity, id)
	type result struct {
		channel *deviceChannel
		failure deviceDialFailure
	}
	attempts := make(chan result)
	addresses = addresses[:min(64, len(addresses))]
	for _, address := range addresses {
		go func() {
			channel, failure := dialDeviceChannel(ctx, config, address)
			select {
			case attempts <- result{channel, failure}:
			case <-ctx.Done():
				if channel != nil {
					channel.close()
				}
			}
		}()
	}
	failures := make([]deviceDialFailure, 0, len(addresses))
	for range addresses {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case current := <-attempts:
			if current.channel != nil {
				s.channel = current.channel
				return current.channel, nil
			}
			failures = append(failures, current.failure)
		}
	}
	return nil, deviceLANDialError(failures)
}

type deviceDialFailure struct {
	address           netip.AddrPort
	refused, dialable bool
	message           string
}

func dialDeviceChannel(ctx context.Context, config *tls.Config, address netip.AddrPort) (*deviceChannel, deviceDialFailure) {
	failure := deviceDialFailure{address: address, dialable: true}
	timer := time.NewTimer(time.Duration(deviceAddressRank(address.Addr())) * 50 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		failure.message = ctx.Err().Error()
		return nil, failure
	case <-timer.C:
	}
	dial, cancel := context.WithTimeout(ctx, 750*time.Millisecond)
	conn, err := (&net.Dialer{}).DialContext(dial, "tcp", address.String())
	expired := errors.Is(dial.Err(), context.DeadlineExceeded)
	cancel()
	if err != nil {
		failure.refused = errors.Is(err, syscall.ECONNREFUSED)
		failure.dialable = !errors.Is(err, syscall.ENETUNREACH) && !errors.Is(err, syscall.EHOSTUNREACH) &&
			!errors.Is(err, syscall.EADDRNOTAVAIL) && !errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOENT)
		switch {
		case expired:
			failure.message = "TCP connect deadline expired"
		case operatingSystem == "darwin" && errors.Is(err, syscall.EHOSTUNREACH):
			failure.message = err.Error() + `; macOS Local Network permission may be blocking ARC. Check System Settings > Privacy & Security > Local Network, then run ` +
				"`arc cli app quit`" + ` and reopen Agent Remote Control with ` + "`open -a \"Agent Remote Control\"`"
		default:
			failure.message = err.Error()
		}
		return nil, failure
	}
	tlsConn := tls.Client(conn, config)
	handshake, cancel := context.WithTimeout(ctx, 1250*time.Millisecond)
	err = tlsConn.HandshakeContext(handshake)
	expired = errors.Is(handshake.Err(), context.DeadlineExceeded)
	cancel()
	if err != nil {
		_ = conn.Close()
		switch {
		case expired:
			failure.message = "DEVICE_TLS_FAILED: Peer handshake deadline expired; query guide for device."
		case strings.Contains(err.Error(), "application protocol"):
			failure.message = "DEVICE_PROTOCOL_MISMATCH: " + err.Error() + "; query guide for device."
		default:
			failure.message = "DEVICE_TLS_FAILED: " + err.Error() + "; query guide for device."
		}
		return nil, failure
	}
	if tlsConn.ConnectionState().NegotiatedProtocol != deviceALPN {
		_ = conn.Close()
		failure.message = "DEVICE_PROTOCOL_MISMATCH: Use matching peer protocol versions; query guide for device."
		return nil, failure
	}
	_ = conn.SetWriteDeadline(time.Now().Add(500 * time.Millisecond))
	channel, err := (&http2.Transport{MaxReadFrameSize: 256 << 10}).NewClientConn(tlsConn)
	_ = conn.SetWriteDeadline(time.Time{})
	if err != nil {
		_ = conn.Close()
		var timeout net.Error
		failure.message = err.Error()
		if errors.As(err, &timeout) && timeout.Timeout() {
			failure.message = "Peer HTTP/2 handshake deadline expired"
		}
		return nil, failure
	}
	return &deviceChannel{channel}, deviceDialFailure{}
}

func (f deviceDialFailure) severity() int {
	switch {
	case strings.Contains(f.message, "DEVICE_PROTOCOL_MISMATCH"):
		return 4
	case strings.Contains(f.message, "DEVICE_TLS_FAILED") || strings.Contains(f.message, "HTTP/2"):
		return 3
	case f.refused:
		return 2
	case strings.Contains(f.message, "deadline expired"):
		return 0
	default:
		return 1
	}
}

func deviceLANDialError(failures []deviceDialFailure) error {
	if len(failures) == 0 {
		return errors.New("DEVICE_LAN_UNAVAILABLE: No known private LAN address is reachable; query devices.")
	}
	best := failures[0]
	dialable, refused := false, true
	for _, f := range failures {
		if f.dialable {
			dialable, refused = true, refused && f.refused
		}
		if f.severity() > best.severity() || f.severity() == best.severity() &&
			(deviceAddressRank(f.address.Addr()) < deviceAddressRank(best.address.Addr()) ||
				deviceAddressRank(f.address.Addr()) == deviceAddressRank(best.address.Addr()) && f.address.Compare(best.address) < 0) {
			best = f
		}
	}
	switch {
	case strings.HasPrefix(best.message, "DEVICE_"):
		return fmt.Errorf("%s (LAN address %s)", best.message, best.address)
	case dialable && refused:
		return fmt.Errorf("DEVICE_CONNECTION_REFUSED: Every currently dialable LAN address refused the connection; %s: %s; query devices.", best.address, best.message)
	default:
		return fmt.Errorf("DEVICE_LAN_UNAVAILABLE: %s: %s; query devices.", best.address, best.message)
	}
}

func deviceRequestBound(op string, args object) time.Duration {
	ms := uintOr(args["timeoutMs"], 1800000)
	if strings.HasSuffix(op, "_wait") || op == "inbox_wait" {
		ms = uintOr(args["timeoutMs"], 30000)
	} else if wait := args["waitMs"]; wait != nil {
		ms = uintOr(wait, 0)
	}
	return time.Duration(min(ms, uint64(math.MaxInt64/time.Millisecond)-30000)+30000) * time.Millisecond
}

func deviceConnectAddresses(addresses []string) ([]netip.AddrPort, error) {
	interfaces, err := deviceLANBindings(0)
	if err != nil {
		return nil, err
	}
	return deviceScopeAddresses(addresses, interfaces, deviceLANAddress)
}

func deviceScopeAddresses(addresses []string, interfaces []deviceLANBinding, allow func(netip.Addr) bool) ([]netip.AddrPort, error) {
	sockets := []netip.AddrPort{}
	for _, candidate := range addresses {
		address, err := netip.ParseAddrPort(candidate)
		if err != nil {
			return nil, errors.New("DEVICE_PAIRING_INVALID: Invalid LAN address; read cli guide.")
		}
		ip := address.Addr()
		if !allow(ip) || address.Port() == 0 {
			continue
		}
		if ip.Is6() && ip.IsLinkLocalUnicast() {
			zone := ip.Zone()
			for _, binding := range interfaces {
				scope := strconv.Itoa(binding.nic.Index)
				if zone == "" || zone == scope {
					sockets = append(sockets, netip.AddrPortFrom(ip.WithZone(scope), address.Port()))
				}
			}
		} else {
			sockets = append(sockets, address)
		}
	}
	return deviceSortSockets(slices.Clip(sockets)), nil
}

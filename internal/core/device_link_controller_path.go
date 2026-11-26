package core

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"time"
)

func (c *deviceController) channel(ctx context.Context, member *deviceMember, heartbeat bool) (*deviceChannel, error) {
	session := &member.business
	if heartbeat {
		session = &member.heartbeat
	}
	if existing := session.cached(); existing != nil {
		return existing, nil
	}
	addresses, err := c.memberAddresses(ctx, member)
	if err != nil {
		return nil, err
	}
	return session.connect(ctx, member.identity, member.peer.DeviceID, addresses)
}

func (c *deviceController) memberAddresses(ctx context.Context, member *deviceMember) ([]netip.AddrPort, error) {
	peer := member.peer
	if peer.AddressOverride != nil {
		return deviceConnectAddresses([]string{*peer.AddressOverride})
	}
	member.mu.RLock()
	facts := member.status.hello
	member.mu.RUnlock()
	if fields, ok := facts["addresses"].([]any); ok {
		return deviceConnectAddresses(deviceStringList(fields))
	}
	return deviceConnectAddresses(peer.Addresses)
}

func deviceStringList(values []any) []string {
	result := []string{}
	for _, value := range values {
		if item, ok := value.(string); ok {
			result = append(result, item)
		}
	}
	return result
}

func (c *deviceController) lanHello(ctx context.Context, member *deviceMember) (object, error) {
	channel, err := c.channel(ctx, member, true)
	if err != nil {
		return nil, err
	}
	result, err := channel.request(ctx, deviceReadPath+"hello", object{"version": deviceProtocolVersion}, time.Second)
	if err != nil {
		return nil, err
	}
	hello := obj(result)
	if err := validateDeviceHello(member, hello); err != nil {
		return nil, err
	}
	if _, err := c.channel(ctx, member, false); err != nil {
		return nil, err
	}
	return hello, nil
}

func validateDeviceHello(member *deviceMember, hello object) error {
	if uintOr(hello["version"], 0) != deviceProtocolVersion {
		return errors.New("DEVICE_PROTOCOL_MISMATCH: Install peer protocol version 3 on both devices; query guide for device.")
	}
	if hello["deviceId"] != member.peer.DeviceID {
		return errors.New("DEVICE_TLS_FAILED: Pinned member identity differs; query guide for device.")
	}
	return nil
}

func (c *deviceController) lanProbe(ctx context.Context, member *deviceMember) (object, error) {
	wait, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cached := member.heartbeat.cached() != nil
	value, err := c.lanHello(wait, member)
	if cached && err != nil && !strings.Contains(err.Error(), "DEVICE_PROTOCOL_MISMATCH") && wait.Err() == nil {
		member.heartbeat.close()
		if len(member.slots) == 0 {
			member.business.close()
		}
		value, err = c.lanHello(wait, member)
	}
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return nil, errors.New("DEVICE_LAN_UNAVAILABLE: LAN heartbeat deadline expired; query devices.")
	}
	return value, err
}

func (c *deviceController) monitor(ctx context.Context, member *deviceMember) {
	ticks := time.NewTicker(10 * time.Second)
	defer ticks.Stop()
	var misses int
	for {
		start := time.Now()
		hello, path, err := c.probe(ctx, member)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			misses++
			member.mu.Lock()
			if misses >= 3 || slices.Contains([]string{"DEVICE_CONNECTION_REFUSED", "DEVICE_PROTOCOL_MISMATCH"}, managementErrorCode(err.Error())) {
				member.status.online = false
			}
			member.status.failure = err.Error()
			member.mu.Unlock()
		} else {
			peer := member.peer
			_, learnErr := gatewayRequest(ctx, "_peer_learn", "POST", object{"deviceId": peer.DeviceID, "publicKey": peer.PublicKey, "hello": hello})
			if learnErr != nil && ctx.Err() == nil {
				recordLog("WARN", learnErr.Error(), nil)
			}
			if ctx.Err() != nil {
				return
			}
			misses = 0
			seen := now()
			ms := time.Since(start).Milliseconds()
			member.mu.Lock()
			member.status = deviceMemberStatus{online: true, path: path, lastSeen: seen, latency: ms, hello: hello}
			member.mu.Unlock()
			if err := c.changeRecords(func(records *deviceRecords) {
				records.Facts[peer.DeviceID] = hello
				records.LastSeen[peer.DeviceID] = seen
			}); err != nil {
				recordLog("WARN", err.Error(), nil)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticks.C:
		}
	}
}

type devicePreparedPath struct {
	lan              *deviceChannel
	tunnelURL, token string
}

func devicePublicTunnelURL(member *deviceMember) string {
	member.mu.RLock()
	hello := member.status.hello
	member.mu.RUnlock()
	if raw, present := hello["tunnelUrl"]; present {
		return peerURL(str(raw))
	}
	return peerURL(deviceOptionalString(member.peer.TunnelURL))
}

func (c *deviceController) prepare(ctx context.Context, member *deviceMember, path string) (devicePreparedPath, error) {
	if path != "tunnel" {
		channel, err := c.channel(ctx, member, false)
		return devicePreparedPath{lan: channel}, err
	}
	base := devicePublicTunnelURL(member)
	if base == "" {
		return devicePreparedPath{}, errors.New("DEVICE_TUNNEL_UNAVAILABLE: No public HTTPS peer URL was learned; restore LAN once and query devices.")
	}
	token, err := member.tunnel.prepare(ctx, member.identity, member.peer.DeviceID, base)
	return devicePreparedPath{tunnelURL: base, token: token}, err
}

func (path devicePreparedPath) send(ctx context.Context, wire object, bound time.Duration) (any, error) {
	if path.lan != nil {
		return path.lan.request(ctx, deviceReadPath+"request", wire, bound)
	}
	deviceTuneForTunnel(obj(wire["body"]))
	return devicePostTunnel(ctx, path.tunnelURL, "request", path.token, wire, bound)
}

func (c *deviceController) tunnelProbe(ctx context.Context, member *deviceMember) (object, error) {
	path, err := c.prepare(ctx, member, "tunnel")
	if err != nil {
		return nil, err
	}
	value, err := devicePostTunnel(ctx, path.tunnelURL, "hello", path.token, object{"version": deviceProtocolVersion}, 4*time.Second)
	if err != nil {
		return nil, err
	}
	hello := obj(value)
	return hello, validateDeviceHello(member, hello)
}

type deviceProbeResult struct {
	hello object
	err   error
}

func (c *deviceController) probe(ctx context.Context, member *deviceMember) (object, string, error) {
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	member.mu.RLock()
	onTunnel := member.status.path == "tunnel"
	member.mu.RUnlock()
	var tunnel chan deviceProbeResult
	if onTunnel {
		tunnel = make(chan deviceProbeResult, 1)
		go func() {
			hello, err := c.tunnelProbe(wait, member)
			tunnel <- deviceProbeResult{hello, err}
		}()
	}
	hello, lanErr := c.lanProbe(wait, member)
	if lanErr == nil {
		return hello, "lan", nil
	}
	member.heartbeat.close()
	if len(member.slots) == 0 {
		member.business.close()
	}
	if devicePublicTunnelURL(member) == "" {
		return nil, "", lanErr
	}
	var tunnelErr error
	if tunnel != nil {
		select {
		case reply := <-tunnel:
			hello, tunnelErr = reply.hello, reply.err
		case <-wait.Done():
			tunnelErr = wait.Err()
		}
	} else {
		hello, tunnelErr = c.tunnelProbe(wait, member)
	}
	if tunnelErr == nil {
		return hello, "tunnel", nil
	}
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		tunnelErr = errors.New("DEVICE_TUNNEL_UNAVAILABLE: Tunnel heartbeat deadline expired; query devices.")
	}
	if strings.Contains(tunnelErr.Error(), "DEVICE_TUNNEL_AUTH") {
		member.tunnel.clear()
	}
	if strings.HasPrefix(lanErr.Error(), "DEVICE_CONNECTION_REFUSED") {
		return nil, "", fmt.Errorf("%v; %v", lanErr, tunnelErr)
	}
	return nil, "", fmt.Errorf("DEVICE_TUNNEL_UNAVAILABLE: %v; %v", lanErr, tunnelErr)
}

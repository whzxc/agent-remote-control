package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"
	"time"
)

const deviceCycle = "DEVICE_PAIRING_CYCLE: Pairing would create a controller/member cycle. Revoke the ancestor relationship locally before pairing; query guide with topic:device."

func (m *deviceManager) rejectCycle(ctx context.Context, id string) error {
	contains, err := m.containsDescendant(ctx, id, []string{})
	if contains {
		return errors.New(deviceCycle)
	}
	return err
}

func (m *deviceManager) containsDescendant(ctx context.Context, id string, visited []string) (bool, error) {
	identity, err := m.currentIdentity()
	if err != nil {
		return false, err
	}
	if identity.id == id {
		return true, nil
	}
	if slices.Contains(visited, identity.id) {
		return false, errors.New(deviceCycle)
	}
	if len(visited) >= 64 {
		return false, errors.New("DEVICE_TOPOLOGY_UNAVAILABLE: Pairing graph exceeds 64 devices in depth; shorten the controller chain and retry.")
	}
	visited = append(slices.Clone(visited), identity.id)
	m.mu.Lock()
	members := maps.Clone(m.stored.Members)
	m.mu.Unlock()
	if _, exists := members[id]; exists {
		return true, nil
	}
	for _, key := range slices.Sorted(maps.Keys(members)) {
		member := members[key]
		result, err := m.topologyProbe(ctx, identity, member, id, visited)
		if errors.Is(err, context.DeadlineExceeded) {
			return false, errors.New("DEVICE_TOPOLOGY_UNAVAILABLE: Pairing graph check timed out. Restore member LAN reachability and retry; query guide with topic:device.")
		}
		if err != nil {
			return false, fmt.Errorf("DEVICE_TOPOLOGY_UNAVAILABLE: Cannot verify member %s: %s. Restore LAN reachability and retry pairing; query guide with topic:device.", member.Name, err)
		}
		contains, ok := field(result, "contains").(bool)
		if !ok {
			return false, errors.New("DEVICE_TOPOLOGY_UNAVAILABLE: Install device-tier support on the member chain before pairing; query guide with topic:device.")
		}
		if contains {
			return true, nil
		}
	}
	return false, nil
}

func (m *deviceManager) topologyProbe(ctx context.Context, identity *deviceIdentity, member devicePeer, id string, visited []string) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var session deviceSession
	defer session.close()
	addresses := member.Addresses
	if member.AddressOverride != nil {
		addresses = []string{*member.AddressOverride}
	}
	sockets, err := m.dialAddresses(addresses)
	if err != nil {
		return nil, err
	}
	channel, err := session.connect(ctx, identity, member.DeviceID, sockets)
	if err != nil {
		return nil, err
	}
	result, err := channel.request(ctx, "/arc-peer/3/topology", object{"version": deviceProtocolVersion, "deviceId": id, "visited": visited}, 9*time.Second)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return result, err
}

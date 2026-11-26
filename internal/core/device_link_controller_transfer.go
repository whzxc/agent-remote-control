package core

import (
	"context"
	"errors"
)

func (c *deviceController) admitTransfer(ctx context.Context, selector string, slot bool) (*deviceTransferLink, func(), error) {
	member, err := c.member(selector)
	if err != nil {
		return nil, nil, err
	}
	member.mu.RLock()
	path, online := member.status.path, member.status.online
	member.mu.RUnlock()
	if !online {
		return nil, nil, deviceOffline()
	}
	release := func() {}
	if slot {
		select {
		case member.slots <- struct{}{}:
			release = func() { <-member.slots }
		default:
			return nil, nil, errors.New("DEVICE_BUSY: Member request capacity reached; wait for an active request.")
		}
	}
	prepared, err := c.prepare(ctx, member, path)
	if err != nil {
		release()
		return nil, nil, err
	}
	return &deviceTransferLink{path: prepared, member: member}, release, nil
}

func (link *deviceTransferLink) refresh(ctx context.Context) error {
	member := link.member
	member.mu.RLock()
	online := member.status.online
	member.mu.RUnlock()
	if !online {
		return deviceOffline()
	}
	if link.path.lan == nil {
		token, err := member.tunnel.prepare(ctx, member.identity, member.peer.DeviceID, link.path.tunnelURL)
		if err != nil {
			return err
		}
		link.path.token = token
	}
	return nil
}

//go:build arcfixture

package core

import (
	"context"
	"net/http"
	"net/netip"
	"net/url"
)

func startFixtureIngressGateway(ctx context.Context, token string, port uint64) (func(), error) {
	owner := &gatewayOwner{bridge: &gatewayBridge{}, token: token, port: port}
	if err := owner.start(ctx); err != nil {
		owner.close()
		return nil, err
	}
	endpoint := newInProcess(owner)
	ctx, cancel := context.WithCancel(ctx)
	listener, err := listenPrivate(ctx, "front-door", token, endpoint, cancel)
	if err != nil {
		cancel()
		owner.close()
		return nil, err
	}
	if _, err := owner.management(ctx, "_restore", http.MethodPost, object{}); err != nil {
		cancel()
		listener.Close()
		owner.close()
		return nil, err
	}
	return func() {
		cancel()
		listener.Close()
		owner.bridge.closeAdmission()
		endpoint.drain()
		owner.close()
	}, nil
}

func init() {
	fixtureRelayWorker = func(address string) bool {
		u, err := url.Parse(address)
		if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return false
		}
		ip, err := netip.ParseAddr(u.Hostname())
		return err == nil && ip.IsLoopback()
	}
	ingressFixtureSourceTransport = func(_ context.Context, s *service, id string, _ object, _ *string) (requestSource, error) {
		return s.fixtureIngress(id)
	}
}

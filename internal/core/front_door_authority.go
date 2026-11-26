package core

import (
	"context"
	"errors"
	"slices"
)

const contextMismatch = "FRONT_DOOR_CONTEXT_MISMATCH"

type authorityHandler func(context.Context, object) (any, error)

var sourceAuthorityHandlers = make(map[string]authorityHandler)
var authorizePeerDevice func(context.Context, string) error
var authenticateIngressPrincipal func(context.Context, *service, string, object, *string) (requestSource, error)
var resolveAuthenticatedMCP func(context.Context, *service, string, string) (requestSource, error)
var validateMCPCredential func(context.Context, string, string, any) error
var currentBrowserKeyDigest func(context.Context) (string, error)
var peerControlRequest func(context.Context, *service, string, object) (any, error)

func registerSourceAuthority(op string, handler authorityHandler) {
	if handler == nil || sourceAuthorityHandlers[op] != nil {
		panic("Invalid or duplicate private authority operation " + op)
	}
	sourceAuthorityHandlers[op] = handler
}

func handleSourceAuthority(ctx context.Context, op string, body object) (any, error) {
	if handler := sourceAuthorityHandlers[op]; handler != nil {
		return handler(ctx, body)
	}
	if slices.Contains([]string{"peer_connect", "peer_revoke", "active_grants", "ingress_retired", "begin_switch", "cancel_switch",
		"candidates", "connect", "connection_state", "control_sources", "disconnect", "ensure_ingress", "for_grant", "get",
		"grant_active", "pending", "remove_connection", "revoke_grants", "update", "validate_claim"}, op) {
		return nil, errors.New(PortPending)
	}
	return nil, errors.New("FRONT_DOOR_AUTHORITY_OPERATION: Use a matching front-door protocol.")
}

func requestSourceAuthority(ctx context.Context, gateway *gatewayBridge, op string, body object) (any, error) {
	if gateway != nil {
		return gateway.call(ctx, newPrivateRequest(ctx, object{"Authority": object{"op": op}}, "Management", body))
	}
	return handleSourceAuthority(ctx, op, body)
}

func validatePrivateAuthority(ctx context.Context, value any) error {
	if str(value) == "Management" {
		return nil
	}
	values := obj(value)
	if len(values) != 1 {
		return errors.New(contextMismatch)
	}
	switch {
	case values["Peer"] != nil:
		device := text(values["Peer"], "device_id")
		if device == "" {
			return errors.New(contextMismatch)
		}
		if authorizePeerDevice == nil {
			return errors.New(PortPending)
		}
		return authorizePeerDevice(ctx, device)
	case values["Browser"] != nil:
		if currentBrowserKeyDigest == nil {
			return errors.New(PortPending)
		}
		expected, err := currentBrowserKeyDigest(ctx)
		if err != nil {
			return err
		}
		if expected == "" || !secureToken(expected, text(values["Browser"], "key_digest")) {
			return errors.New("FRONT_DOOR_BROWSER_UNAUTHORIZED")
		}
		return nil
	case values["Mcp"] != nil:
		authority := obj(values["Mcp"])
		if text(authority, "ingress_id") == "" || text(authority, "source_id") == "" {
			return errors.New(contextMismatch)
		}
		if validateMCPCredential == nil {
			return errors.New(PortPending)
		}
		return validateMCPCredential(ctx, text(authority, "ingress_id"), text(authority, "source_id"), authority["credential"])
	}
	return errors.New(contextMismatch)
}

func privateIngressSource(ctx context.Context, target *service, authority object) (requestSource, error) {
	ingress := text(authority, "ingress_id")
	if ingress == "" || obj(authority["principal"]) == nil {
		return requestSource{}, errors.New(contextMismatch)
	}
	principal := obj(authority["principal"])
	var header *string
	if value, ok := authority["header"].(string); ok {
		header = &value
	}
	if target.fixtureIngress != nil {
		if text(principal, "type") != "ingress" || text(principal, "ingressId") != ingress || header != nil {
			return requestSource{}, errors.New(contextMismatch)
		}
		return target.fixtureIngress(ingress)
	}
	if authenticateIngressPrincipal != nil {
		return authenticateIngressPrincipal(ctx, target, ingress, principal, header)
	}
	if ingress != "default" {
		return requestSource{}, errors.New(PortPending)
	}
	if text(principal, "type") != "ingress" || text(principal, "ingressId") != ingress || header != nil {
		return requestSource{}, errors.New(contextMismatch)
	}
	return target.source, nil
}

func init() {
	registerSourceAuthority("default_policy", func(context.Context, object) (any, error) {
		return defaultPolicy(), nil
	})
}

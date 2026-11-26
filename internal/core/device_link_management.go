package core

import (
	"context"
	"errors"
	"net/http"
	"strings"
)

var deviceActions = []string{"snapshot", "offer", "pending", "approve", "decline", "pair", "cancel-pair", "revoke", "configure", "address", "tasks"}

func deviceManagementCatalog(catalog object) {
	if !deviceEnabled() {
		return
	}
	operations := arr(catalog["operations"])
	for _, action := range deviceActions {
		props, required := object{}, []string{}
		switch action {
		case "pair":
			props["pairingString"] = object{"type": "string", "maxLength": 16384}
			required = []string{"pairingString"}
		case "tasks":
			props["device"] = object{"type": "string", "minLength": 1}
			required = []string{"device"}
		case "address":
			props["device"] = object{"type": "string", "minLength": 1}
			props["address"] = object{"type": []string{"string", "null"}}
			required = []string{"device", "address"}
		case "revoke":
			props["deviceId"] = object{"type": "string", "pattern": "^[a-f0-9]{64}$"}
			required = []string{"deviceId"}
		case "configure":
			props["showUpstreamSources"] = object{"type": "boolean", "default": false}
			props["port"] = object{"type": "integer", "minimum": 1, "maximum": 65535}
			props["name"] = object{"type": "string", "minLength": 1, "maxLength": 120}
		}
		outer := []string{}
		if len(required) > 0 {
			outer = []string{"body"}
		}
		op := object{
			"name": "device." + action, "method": http.MethodPost, "route": "device/" + action, "localOnly": true,
			"description": "Device link local " + action + ". Read cli guide for pairing and transport contracts.",
			"inputSchema": object{"type": "object", "properties": object{"body": object{
				"type": "object", "properties": props, "required": required, "additionalProperties": false,
			}}, "required": outer, "additionalProperties": false},
		}
		operations = append(operations, op)
	}
	catalog["operations"] = operations
}

func init() {
	registerLiveManagementCatalog(deviceManagementCatalog)
	registerRoutePattern(http.MethodPost, `device/(snapshot|offer|pending|approve|decline|pair|cancel-pair|revoke|configure|address)`,
		func(ctx context.Context, _ *service, body object, params []string) (any, error) {
			if !deviceEnabled() {
				return nil, errors.New(deviceUnavailableMessage)
			}
			return gatewayRequest(ctx, "device/"+params[0], http.MethodPost, body)
		})
	registerRoute(http.MethodPost, "device/tasks", func(ctx context.Context, s *service, body object, _ []string) (any, error) {
		if !deviceEnabled() {
			return nil, errors.New(deviceUnavailableMessage)
		}
		if deviceControllerTasks == nil {
			return nil, errors.New(PortPending)
		}
		return deviceControllerTasks(ctx, s, body)
	})
	registerPreferenceChange(func(ctx context.Context, before, after object) error {
		if before["device-link"] != after["device-link"] {
			_, err := gatewayRequest(ctx, "_peer_reconcile", http.MethodPost, object{})
			return err
		}
		return nil
	})
	registerOperation("connector_verify", func(ctx context.Context, r operationRequest) (any, error) {
		ingressID := waitScope(ctx, r.source)
		if _, err := validateVerificationIngress(ingressID); err != nil {
			return nil, err
		}
		return gatewayRequest(ctx, "_connector_verify/"+ingressID, http.MethodPost, object{"code": r.args["code"]})
	}, nil)
}

func validateVerificationIngress(id string) (string, error) {
	if id == "" || id == "local-cli" || strings.HasPrefix(id, "peer:") {
		return "", errors.New("Connector verification requires an ingress.")
	}
	return id, validateIngressID(id)
}

var deviceControllerTasks func(context.Context, *service, object) (any, error)

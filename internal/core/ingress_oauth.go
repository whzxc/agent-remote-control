package core

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
)

func currentGatewayOAuth(_ context.Context, g *gatewayOwner, id string) (*ingressOAuth, string, func(), error) {
	current, ok := networkGateways.Load(g)
	if !ok {
		return nil, "", nil, errors.New("core shutting down")
	}
	ingress, err := current.(*ingressGateway).get(id)
	if err != nil {
		return nil, "", nil, err
	}
	ingress.lifecycle.Lock()
	ingress.mu.RLock()
	retired, auth, resource := ingress.retired, ingress.entry["auth"], ingress.url
	ingress.mu.RUnlock()
	if retired || auth != "oauth" {
		ingress.lifecycle.Unlock()
		if retired {
			return nil, "", nil, errors.New("Connection configuration changed; retry")
		}
		return nil, "", nil, errors.New("OAuth is not enabled for this connection")
	}
	return ingress.oauth, resource, ingress.lifecycle.Unlock, nil
}

func serveIngressOAuth(w http.ResponseWriter, r *http.Request, i *networkIngress, resource string, trace *ingressObservation) {
	i.mu.RLock()
	name := i.entry["name"]
	i.mu.RUnlock()
	i.oauth.writeHTTP(w, r, resource, oauthHTTPContext{
		connectionName: name,
		observeRequest: func(_ context.Context, field string) error { return i.observe(field, now(), true) },
		observeClient:  trace.oauthClient,
		observeFields:  trace.oauthFields,
		audit:          func(level, message string) { recordLog(level, message, &i.id) },
	})
}

func checkIngressTransport(_ context.Context, ingress string, principal object, header *string) error {
	entry, err := loadIngressEntry(ingress)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && ingress == "default" && header == nil &&
			principal["type"] == "ingress" && principal["ingressId"] == ingress {
			return nil
		}
		return err
	}
	if entry["enabled"] != true {
		return errors.New("Connection closed")
	}
	if principal["type"] == "oauth-grant" && entry["auth"] == "oauth" && header != nil {
		store, err := newIngressOAuth(filepath.Join(root(), "ingresses", ingress), nil)
		if err != nil {
			return err
		}
		verified := store.authenticateTransport(*header, store.stored.Resource)
		if verified == nil || verified["grantId"] != principal["grantId"] || verified["clientId"] != principal["clientId"] {
			return errors.New("SOURCE_REVOKED: The OAuth grant is not authorized.")
		}
		return nil
	}
	if principal["type"] != "ingress" || principal["ingressId"] != ingress ||
		!(header != nil && ingressAllowsHeader(entry, *header) ||
			header == nil && (entry["transport"] == "local" || entry["transport"] == "openai-tunnel")) {
		return errors.New(contextMismatch)
	}
	return nil
}

func authorizeIngressNotification(ctx context.Context, _ *service, source requestSource, principal string) (requestSource, notificationEventAccess) {
	row, err := readSourceAuthority(text(source.origin, "sourceId"))
	if err != nil || row["state"] == "revoked" || row["connectionRemoved"] == true {
		return requestSource{}, notificationEventSourceUnavailable
	}
	id := text(row, "ingressId")
	if validateIngressID(id) != nil || text(source.origin, "ingressId") != "" && source.origin["ingressId"] != id {
		return requestSource{}, notificationEventSourceUnavailable
	}
	state, err := gatewayRequest(ctx, "_entry/"+id, http.MethodGet, object{})
	entry := field(state, "entry")
	if err != nil {
		return requestSource{}, notificationEventSourceUnavailable
	}
	if principal == "" || field(entry, "enabled") != true {
		return requestSource{}, notificationEventPrincipalRevoked
	}
	credential := row["credential"]
	if field(entry, "auth") == "oauth" {
		if field(credential, "type") != "oauth-grant" || field(credential, "grantId") != principal {
			return requestSource{}, notificationEventPrincipalRevoked
		}
		active, err := gatewayRequest(ctx, "_event_active/"+id, http.MethodGet, object{"principal": principal})
		if err != nil || active != true {
			return requestSource{}, notificationEventPrincipalRevoked
		}
	} else {
		kind := field(credential, "type")
		config := field(entry, "config")
		current := hash([]byte(wire([]any{id, field(entry, "auth"), field(entry, "bearerToken"), field(config, "tunnelId"), field(config, "apiKey")})))
		if kind != "ingress" && kind != "local" || !secureToken(principal, current) {
			return requestSource{}, notificationEventPrincipalRevoked
		}
	}
	source.profile = row
	source.policy = field(entry, "toolPolicy")
	if field(state, "connected") != true {
		return source, notificationEventDisconnected
	}
	return source, notificationEventConnected
}

func init() {
	notificationEventAuthorize = authorizeIngressNotification
	gatewayOAuthIngress = currentGatewayOAuth
	ingressOAuthHTTP = serveIngressOAuth
	ingressOAuthAuthenticate = func(i *networkIngress, header, resource string) object {
		return i.oauth.transportPrincipal(header, resource)
	}
}

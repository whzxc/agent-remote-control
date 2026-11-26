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

func init() {
	gatewayOAuthIngress = currentGatewayOAuth
	ingressOAuthHTTP = serveIngressOAuth
	ingressOAuthAuthenticate = func(i *networkIngress, header, resource string) object {
		return i.oauth.transportPrincipal(header, resource)
	}
}

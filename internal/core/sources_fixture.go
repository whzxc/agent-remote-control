//go:build arcfixture

package core

import (
	"context"
	"os"
	"path/filepath"
)

func init() {
	registerServiceStartup(func(ctx context.Context, s *service) error {
		previous := s.fixtureIngress
		if previous == nil {
			return nil
		}
		s.fixtureIngress = func(id string) (requestSource, error) {
			original, err := previous(id)
			if err != nil {
				return requestSource{}, err
			}
			id = text(original.origin, "sourceId")
			raw, err := load(filepath.Join(root(), "ingresses", id, "config.json"))
			if err != nil && os.IsNotExist(err) {
				return original, nil
			}
			if err != nil {
				return requestSource{}, err
			}
			entry := obj(raw)
			if entry == nil || entry["id"] != id || entry["transport"] == nil || entry["enabled"] == nil || entry["auth"] == "oauth" {
				return original, nil
			}
			return authenticatedSourceRequest(ctx, s, id, object{"type": "ingress", "ingressId": id}, nil)
		}
		return nil
	})
}

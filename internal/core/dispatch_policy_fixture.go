//go:build arcfixture

package core

import (
	"context"
	"errors"
	"os"
	"time"
)

func dispatchPolicyFixtureActive(s *service) bool {
	return s != nil && s.fixtureIngress != nil && os.Getenv("ARC_FIXTURE_SCRIPT") != "" && os.Getenv("ARC_FIXTURE_BINARY") != ""
}

func init() {
	dispatchFixtureRegistered = func(s *service, agent string) (bool, bool) {
		if !dispatchPolicyFixtureActive(s) {
			return false, false
		}
		// Pi only supplies a policy scope. The fixture runs the TS Codex server.
		return agent == "codex" || agent == "pi", true
	}
	dispatchFixtureFacts = func(_ context.Context, s *service, args object) ([]object, error) {
		if !dispatchPolicyFixtureActive(s) {
			return nil, errors.New(PortPending)
		}
		agent, filtered := args["agent"].(string)
		if filtered && agent != "codex" && agent != "pi" {
			return nil, errors.New("UNKNOWN_AGENT: read query agents for registered IDs")
		}
		if _, ok := args["taskId"].(string); ok {
			if agent == "pi" {
				return nil, errors.New(PortPending)
			}
			return nil, errors.New("TASK_REQUIRES_NON_CODEX_AGENT")
		}
		rows := []object{}
		if !filtered || agent == "codex" {
			rows = append(rows, object{"agent": "codex", "protocol": "codex-native",
				"availability": object{"installed": true, "enabled": true, "available": true, "observedAt": now()}})
		}
		if args["all"] == true && (!filtered || agent == "pi") {
			rows = append(rows, object{"agent": "pi", "protocol": "pi-rpc",
				"availability": object{"installed": false, "enabled": true, "available": false, "observedAt": now()},
				"capabilities": object{"authoritative": false, "unavailable": "agent-catalog-unavailable"}})
		}
		return rows, nil
	}
	dispatchFixtureRPC = func(ctx context.Context, s *service, method string, args any, timeout time.Duration) (any, error) {
		if !dispatchPolicyFixtureActive(s) || (method != "model/list" && method != "account/rateLimits/read") {
			return nil, errors.New(PortPending)
		}
		start, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		connection, err := startRPC(start, os.Getenv("ARC_FIXTURE_BINARY"), os.Getenv("CODEX_HOME"), text(s.metadata, "instance"), rpcObserver{})
		if err != nil {
			return nil, err
		}
		defer connection.close()
		return connection.call(start, method, args, timeout)
	}
}

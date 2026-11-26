package core

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func diagnosticFinding(code, severity, kind string, id any, summary, operation string) object {
	return object{"code": code, "severity": severity, "scope": object{"kind": kind, "id": id}, "observedAt": now(),
		"summary": summary, "nextAction": object{"kind": "user-action", "operation": operation, "target": id}}
}

func ingressDiagnostics(ingress object) object {
	findings := []object{}
	id, name, state := ingress["id"], text(ingress, "id"), text(ingress, "state")
	dependency, controlPlane := obj(ingress["tunnelDependency"]), obj(ingress["controlPlane"])
	finding := func(code, severity, summary, operation string) object {
		row := diagnosticFinding(code, severity, "ingress", id, summary, operation)
		findings = append(findings, row)
		return row
	}
	switch {
	case dependency["state"] == "error":
		row := finding(text(dependency, "code"), "error", text(dependency, "error"), "ingress.dependencies.install")
		row["dependency"] = dependency
		obj(row["nextAction"])["command"] = cliCommandLine([]string{"call", "ingress.dependencies.install", "--stdin"}, object{"id": id, "body": object{"component": "tunnel"}})
	case controlPlane["state"] == "rejected":
		row := finding("RUNTIME_KEY_REJECTED", "error", localized(locale(), "setup.runtime-key-rejected"), "setup.playbook")
		row["dependency"], row["httpStatus"] = dependency, controlPlane["httpStatus"]
		detail := text(ingress, "tunnelError")
		if detail == "" {
			detail = fmt.Sprintf("Tunnel Client control-plane HTTP %s (%s)", wire(controlPlane["httpStatus"]), text(controlPlane, "failureCategory"))
		}
		row["detail"] = detail
		obj(row["nextAction"])["command"] = cliCommandLine([]string{"setup", "playbook", "tunnel-credentials"}, nil)
	case ingress["transport"] == "openai-tunnel" && state != "ready" && text(ingress, "tunnelError") != "":
		row := finding("TUNNEL_CLIENT_ERROR", "error", text(ingress, "tunnelError"), "ingress.restart")
		obj(row["nextAction"])["command"] = cliCommandLine([]string{"ingress", "restart", name}, nil)
	}
	switch {
	case state == "stopped" && ingress["running"] == false:
		finding("INGRESS_STOPPED", "info", "The ingress is stopped. Reading diagnostics does not start it.", "inspect-ingress")
	case state == "error" || text(ingress, "error") != "":
		finding("INGRESS_FAILED", "error", text(ingress, "error"), "inspect-ingress")
	case field(ingress["config"], "configured") == false:
		finding("INGRESS_NOT_CONFIGURED", "info", "Ingress configuration is incomplete.", "configure-ingress")
	}
	inbound := "not_checked"
	verifiedAt := field(ingress["verification"], "challengeVerifiedAt")
	if _, ok := verifiedAt.(string); ok {
		inbound = "verified"
	}
	if state == "ready" && inbound != "verified" {
		finding("INBOUND_NOT_VERIFIED", "warning", "The ingress is ready. The current configuration has no inbound challenge verification evidence.", "verify-inbound")
	}
	auth := "configured-not-verified"
	if ingress["auth"] == "none" {
		auth = "disabled"
		finding("AUTH_DISABLED", "warning", "Authentication is disabled for this ingress.", "inspect-authentication")
	}
	for _, row := range findings {
		next := obj(row["nextAction"])
		if next["command"] == nil {
			next["command"] = cliCommandLine([]string{"ingress", "doctor", name}, nil)
		}
	}
	return object{"findings": findings, "checks": object{"transport": object{"state": state}, "authentication": object{"state": auth},
		"inbound": object{"state": inbound, "observedAt": verifiedAt}, "execution": object{"state": "not_checked"}, "remoteClient": object{"state": "unknown"}},
		"readOnly": true}
}

func statusDiagnostics(status object, ingresses []object) object {
	findings := []object{}
	for _, ingress := range ingresses {
		findings = append(findings, ingressDiagnostics(ingress)["findings"].([]object)...)
	}
	core := obj(status["core"])
	appServer := obj(core["appServer"])
	resources := []any{core["resources"], appServer["resources"]}
	for i, kind := range []string{"core", "appServer"} {
		var code, message string
		switch text(resources[i], "state") {
		case "pressure":
			code = "APP_SERVER_FD_PRESSURE"
			message = "App-server file descriptors have reached 90% of the soft limit. RPC ready only confirms a live communication channel."
		case "degraded":
			code = "APP_SERVER_NOFILE_DEGRADED"
			if i == 0 {
				code = "CORE_NOFILE_DEGRADED"
			}
			message = "The file descriptor limit is below the startup target. Core continues running. Inspect the limit source, startup record, and failure reason."
		default:
			continue
		}
		row := diagnosticFinding(code, "warning", "resources", kind, message, "inspect-resource-limits")
		row["evidence"] = resources[i]
		obj(row["nextAction"])["command"] = cliCommandLine([]string{"status"}, nil)
		findings = append(findings, row)
	}
	for _, endpoint := range []struct{ key, code string }{{"desktop", "DESKTOP_UNAVAILABLE"}, {"appServer", "APP_SERVER_UNAVAILABLE"}} {
		switch text(core[endpoint.key], "state") {
		case "unavailable", "disconnected", "error":
			findings = append(findings, diagnosticFinding(endpoint.code, "warning", "execution-endpoint", endpoint.key,
				"The execution host is unavailable. Read historical evidence availability separately.", "inspect-execution-endpoint"))
		}
	}
	return object{"findings": findings, "checks": object{"app": object{"state": "reachable"},
		"resources": object{"core": resources[0], "appServer": resources[1]}, "execution": object{"state": "not_checked"},
		"remoteClient": object{"state": "unknown"}, "receipts": object{"state": "not_checked", "nextAction": "read-original-requestId; never replay an unconfirmed write"}}, "readOnly": true}
}

func receiptDiagnostics(diagnostics object, records []object, err error) {
	checks := obj(diagnostics["checks"])
	if err != nil {
		checks["receipts"] = object{"state": "unknown", "scope": "codex-task-receipts"}
		return
	}
	count := 0
	findings := diagnostics["findings"].([]object)
	for _, row := range records {
		if row["state"] != "unconfirmed" {
			continue
		}
		count++
		if count > 100 {
			continue
		}
		f := diagnosticFinding("WRITE_UNCONFIRMED", "warning", "request", row["requestId"],
			"The write result is unconfirmed. Read the original requestId and native task without replaying the request.", "read-original-request")
		obj(f["scope"])["ingressId"] = field(row["origin"], "ingressId")
		next := obj(f["nextAction"])
		next["via"], next["op"] = "act", "receipt"
		findings = append(findings, f)
	}
	state := "no-unconfirmed-observed"
	if count != 0 {
		state = "unconfirmed"
	}
	checks["receipts"] = object{"state": state, "scope": "codex-task-receipts", "count": count, "truncated": count > 100}
	diagnostics["findings"] = findings
}

func diagnosticDNS(ctx context.Context, host string) ([]string, bool, error) {
	budget, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIPAddr(budget, host)
	addresses := make([]string, 0, len(ips))
	fake := false
	for _, entry := range ips {
		addresses = append(addresses, entry.IP.String())
		if ip := entry.IP.To4(); ip != nil && ip[0] == 198 && (ip[1] == 18 || ip[1] == 19) {
			fake = true
		}
	}
	return addresses, fake, err
}

func probeIngress(ctx context.Context, summary object, observe func(context.Context, string, object) error) (object, error) {
	address := text(summary, "url")
	checks := object{"transport": summary["state"], "authentication": object{"state": "not_checked"}, "execution": object{"state": "not_checked"}}
	if summary["provider"] == "cloudflare" {
		edges := []object{}
		for _, host := range []string{"region1.v2.argotunnel.com", "region2.v2.argotunnel.com"} {
			ips, fake, err := diagnosticDNS(ctx, host)
			row := object{"host": host, "addresses": ips, "fakeIp": fake}
			if err != nil {
				row = object{"host": host, "state": "dns_failed"}
			}
			edges = append(edges, row)
		}
		checks["edgeDiscovery"], checks["provider"] = edges, summary["health"]
	}
	if parsed, err := url.Parse(address); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		addresses, _, err := diagnosticDNS(ctx, parsed.Hostname())
		checks["dns"] = object{"state": "resolved", "addresses": addresses}
		if err != nil {
			checks["dns"] = object{"state": "failed"}
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, Timeout: 10 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		data := wire(object{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": object{"protocolVersion": "2025-03-26",
			"capabilities": object{}, "clientInfo": object{"name": "connector-doctor", "version": buildVersion}}})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), strings.NewReader(data))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Content-Type", "application/json")
		result, err := client.Do(req)
		if err != nil {
			checks["publicMcp"] = object{"state": "failed", "error": err.Error()}
		} else {
			_ = result.Body.Close()
			state := "failed"
			switch result.StatusCode {
			case 200:
				state = "reachable"
			case 401:
				state = "authentication_required"
			}
			checks["publicMcp"] = object{"state": state, "httpStatus": result.StatusCode, "tls": "verified", "authenticated": false}
		}
		if summary["auth"] == "oauth" {
			metadata := parsed.ResolveReference(&url.URL{Path: "/.well-known/oauth-protected-resource"})
			req, err = http.NewRequestWithContext(ctx, http.MethodGet, metadata.String(), nil)
			if err != nil {
				return nil, err
			}
			result, err = client.Do(req)
			if err != nil {
				checks["oauthMetadata"] = object{"state": "failed", "error": err.Error()}
			} else {
				_ = result.Body.Close()
				state := "failed"
				if result.StatusCode/100 == 2 {
					state = "reachable"
				}
				checks["oauthMetadata"] = object{"state": state, "httpStatus": result.StatusCode}
			}
		}
	} else {
		checks["publicMcp"] = object{"state": "not_available", "reason": "no public HTTPS endpoint"}
	}
	public := text(checks["publicMcp"], "state")
	passed := summary["state"] == "ready" && (public == "reachable" || public == "authentication_required") &&
		(summary["auth"] != "oauth" || field(checks["oauthMetadata"], "state") == "reachable")
	if err := observe(ctx, "lastProbe", object{"observedAt": now(), "url": address, "passed": passed}); err != nil {
		return nil, err
	}
	return object{"ingressId": summary["id"], "observedAt": now(), "checks": checks, "diagnostics": ingressDiagnostics(summary)}, nil
}

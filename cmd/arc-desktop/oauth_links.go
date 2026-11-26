package main

import (
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"

	"github.com/egoist/mygo"
)

func deepLink(raw, scheme string) (*desktopMessage, string) {
	link, err := url.Parse(raw)
	if err != nil || link.Scheme != scheme || link.Opaque != "" ||
		(link.EscapedPath() != "" && link.EscapedPath() != "/") ||
		link.User != nil || strings.Contains(link.Host, ":") || strings.Contains(raw, "#") {
		return nil, ""
	}
	params, err := url.ParseQuery(link.RawQuery)
	if err != nil {
		return nil, ""
	}
	switch link.Host {
	case "ingress":
		if id := params.Get("id"); id != "" {
			return &desktopMessage{"ingress:edit", object{"id": id, "field": params.Get("field")}}, ""
		}
	case "permissions":
		return &desktopMessage{"permissions:open", nil}, ""
	case "setup":
		for _, target := range params["target"] {
			if target == "codex-login" {
				return &desktopMessage{"codex:login", nil}, ""
			}
		}
		setup := false
		for _, target := range params["target"] {
			setup = setup || target == "claude-login" || target == "cloudflare-login"
		}
		if setup {
			for _, values := range params {
				for _, value := range values {
					if value == "claude-login" {
						return nil, "claude-code-ready"
					}
				}
			}
			return nil, "cloudflare-login"
		}
	case "oauth":
		values := params["request"]
		if len(params) == 1 && len(values) == 1 && validOAuthRequest(values[0]) {
			return &desktopMessage{"oauth:open", values[0]}, ""
		}
	}
	return nil, ""
}

func validOAuthRequest(id string) bool {
	if len(id) != 64 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func (s *DesktopService) openLink(raw string) {
	action, step := deepLink(raw, linkScheme)
	if action != nil {
		s.show(action)
	}
	if step != "" {
		s.show(nil)
		go func() {
			_, _ = s.core.Request(s.ctx, "setup/apply", http.MethodPost, object{"stepId": step, "input": object{}})
		}()
	}
}

func (s *DesktopService) notificationActivated(id string) {
	request, ok := strings.CutPrefix(id, "oauth:")
	if ok && validOAuthRequest(request) {
		mygo.RunOnMain(func() { s.show(&desktopMessage{"oauth:open", request}) })
	}
}

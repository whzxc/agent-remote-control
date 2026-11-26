package core

import (
	"net/url"
	"strings"

	"github.com/google/uuid"
)

const srcWebsite = "https://claude.ai"

func srcWebsiteURL(raw string) *url.URL {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Hostname(), "claude.ai") ||
		(u.Port() != "" && u.Port() != "443") || u.User != nil && u.User.String() != "" {
		return nil
	}
	return u
}

func srcURLPath(u *url.URL) string {
	// The native URL parser removes dot segments without decoding escaped slashes.
	parts := strings.Split(u.EscapedPath(), "/")
	canonical := make([]string, 0, len(parts))
	for index, part := range parts {
		switch strings.ToLower(part) {
		case ".", "%2e":
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(canonical) > 1 {
				canonical = canonical[:len(canonical)-1]
			}
		default:
			canonical = append(canonical, part)
			continue
		}
		if index == len(parts)-1 {
			canonical = append(canonical, "")
		}
	}
	return strings.Join(canonical, "/")
}

func srcSessionExpired(raw string) bool {
	u := srcWebsiteURL(raw)
	if u == nil {
		return false
	}
	first, _, _ := strings.Cut(strings.TrimPrefix(srcURLPath(u), "/"), "/")
	switch first {
	case "login", "signin", "sign-in", "sign_in", "auth":
		return true
	default:
		return false
	}
}

func srcURLReference(raw string) object {
	u := srcWebsiteURL(raw)
	if u == nil {
		return nil
	}
	parts := strings.Split(strings.TrimRight(srcURLPath(u), "/"), "/")
	if len(parts) != 3 || parts[0] != "" {
		return nil
	}
	kind, identifier := parts[1], parts[2]
	switch kind {
	case "chat":
		native, err := uuid.Parse(identifier)
		if err != nil || uuid.Validate(identifier) != nil {
			return nil
		}
		identifier = native.String()
	case "cowork":
		suffix, found := strings.CutPrefix(identifier, "cse_")
		if !found || !srcAlphanumeric(suffix) {
			return nil
		}
	default:
		return nil
	}
	return object{"kind": kind, "id": identifier, "url": srcWebsite + "/" + kind + "/" + identifier}
}

func srcAlphanumeric(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range []byte(value) {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9') {
			return false
		}
	}
	return true
}

func srcNotifyReference(target string) object {
	suffix, found := strings.CutPrefix(target, "session_")
	if !found || len(suffix) != 24 || !srcAlphanumeric(suffix) {
		return nil
	}
	return srcURLReference(srcWebsite + "/cowork/cse_" + suffix)
}

func srcOpenURL(raw string) string {
	u := srcWebsiteURL(raw)
	if u == nil || u.ForceQuery || u.RawQuery != "" || strings.Contains(raw, "#") {
		return ""
	}
	if srcURLPath(u) == "/new" {
		return srcWebsite + "/new"
	}
	return text(srcURLReference(raw), "url")
}

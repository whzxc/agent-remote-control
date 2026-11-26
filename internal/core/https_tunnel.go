package core

import (
	"errors"
	"net/url"
	"strings"
	"unicode"
)

func ngrokEndpoint(endpoint string) (string, error) {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return "", errors.New("Enter the fixed ngrok domain")
	}
	address := endpoint
	if !strings.Contains(endpoint, "://") {
		address = "https://" + endpoint
	}
	u, err := url.Parse(address)
	if err != nil || !ingressURLAllowed(u, "https", "/") ||
		u.Port() != "" && u.Port() != "443" || strings.ContainsAny(endpoint, "*#") ||
		strings.ContainsFunc(endpoint, unicode.IsSpace) {
		return "", errors.New("Invalid fixed ngrok domain. Enter a hostname or HTTPS URL without a path.")
	}
	return ingressURLOrigin(u), nil
}

func ingressURLOrigin(u *url.URL) string {
	host := strings.ToLower(u.Host)
	if u.Scheme == "https" {
		host = strings.TrimSuffix(host, ":443")
	} else if u.Scheme == "http" {
		host = strings.TrimSuffix(host, ":80")
	}
	return u.Scheme + "://" + host
}

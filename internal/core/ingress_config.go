package core

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"slices"
	"strings"
	"sync"
	"unicode"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
	ingressAssets "github.com/whzxc/agent-remote-control/native/src/ingress"
)

var ingressDescriptor = sync.OnceValue(func() object {
	var descriptor object
	if err := canonjson.Unmarshal([]byte(ingressAssets.Descriptor), &descriptor); err != nil {
		panic(err)
	}
	return descriptor
})

func ingressDefaults() object {
	result := object{}
	for key, field := range obj(ingressDescriptor()["fields"]) {
		result[key] = obj(field)["default"]
	}
	return result
}

func ingressSecretFields() []string {
	fields := obj(ingressDescriptor()["fields"])
	result := []string{}
	for _, key := range keys(fields) {
		if text(fields[key], "savedFlag") != "" {
			result = append(result, key)
		}
	}
	return result
}

func ingressConfigured(config object) bool {
	switch config["connectionMode"] {
	case "local":
		return true
	case "relay":
		return text(config, "relayUrl") != "" && text(config, "relayInstanceId") != ""
	case "https":
		provider := obj(field(ingressDescriptor()["providers"], text(config, "httpsProvider")))
		if provider == nil {
			return false
		}
		mode := text(provider, "mode")
		named := mode == "" || config[mode] == "named"
		needsToken := provider["tokenRequired"] == "always" || provider["tokenRequired"] == "named" && named
		ready := text(config, text(provider, "credential")) != ""
		if config["httpsProvider"] == "cloudflare" && config["cloudflareAuth"] == "login" {
			ready = cloudflareConfigured(config)
		}
		endpoint := "httpsUrl"
		if config["httpsProvider"] == "ngrok" {
			endpoint = "ngrokEndpoint"
		}
		return (!needsToken || ready) && (!named || text(config, endpoint) != "")
	default:
		return text(config, "tunnelId") != "" && text(config, "apiKey") != ""
	}
}

func ingressBinding(config object) string {
	switch config["connectionMode"] {
	case "relay":
		return hash([]byte(wire([]any{config["relayUrl"], config["relayInstanceId"]})))
	case "https":
		fields := []string{
			"httpsProvider", "cloudflareMode", "cloudflareToken", "cloudflareAuth",
			"cloudflareTunnelId", "ngrokAuthtoken", "ngrokMode", "ngrokEndpoint",
			"pinggyMode", "pinggyToken", "localxposeMode", "localxposeAccessToken",
			"localxposeRegion", "httpsUrl", "httpsHost", "httpsPort",
		}
		values := []any{"https"}
		for _, field := range fields {
			values = append(values, config[field])
		}
		return hash([]byte(wire(values)))
	default:
		return hash([]byte(wire([]any{config["tunnelId"], config["apiKey"]})))
	}
}

func ingressValidateConfig(config object) error {
	if config == nil {
		return errors.New("Invalid configuration format")
	}
	proxyMode, ok := config["proxyMode"].(string)
	if !ok {
		return errors.New("Invalid proxy mode")
	}
	proxyURL, ok := config["proxyUrl"].(string)
	if !ok {
		return errors.New("Invalid proxy address")
	}
	if err := ingressValidateProxy(proxyMode, proxyURL); err != nil {
		return err
	}
	descriptor := ingressDescriptor()
	fields := obj(descriptor["fields"])
	if _, ok := config["autoStart"].(bool); !ok || len(config) != len(fields) {
		return errors.New("Invalid configuration field")
	}
	for _, key := range keys(fields) {
		if max, ok := uintValue(field(fields[key], "maxBytes")); ok {
			value, ok := config[key].(string)
			if !ok {
				return errors.New("Invalid configuration type")
			}
			if uint64(len(value)) > max || strings.ContainsRune(value, 0) {
				return errors.New("Invalid configuration value")
			}
		}
	}
	if !slices.Contains([]string{"tunnel", "https", "relay", "local"}, text(config, "connectionMode")) {
		return errors.New("Invalid connection method")
	}
	if config["connectionMode"] == "relay" {
		if err := relayValidateConfig(config); err != nil {
			return err
		}
	}
	if auth := text(config, "cloudflareAuth"); auth != "token" && auth != "login" {
		return errors.New("Invalid Cloudflare login method")
	}
	if tunnel := text(config, "cloudflareTunnelId"); tunnel != "" {
		if _, err := uuid.Parse(tunnel); err != nil {
			return errors.New("Invalid Cloudflare Tunnel ID")
		}
	}
	providers := obj(descriptor["providers"])
	active := text(config, "httpsProvider")
	if providers[active] == nil {
		return errors.New("Invalid HTTPS provider")
	}
	for _, id := range keys(providers) {
		provider := obj(providers[id])
		if mode := text(provider, "mode"); mode != "" && !slices.Contains(arr(provider["modes"]), config[mode]) &&
			!(id == "localxpose" && config[mode] == "quick" && active != id) {
			return fmt.Errorf("Invalid %s mode", text(provider, "label"))
		}
		if key := text(provider, "credential"); key != "" && strings.ContainsFunc(text(config, key), unicode.IsSpace) {
			return fmt.Errorf("%s Token cannot contain whitespace", text(provider, "label"))
		}
	}
	if active == "ngrok" && config["ngrokMode"] == "named" && config["ngrokEndpoint"] != "" {
		if _, err := ngrokEndpoint(text(config, "ngrokEndpoint")); err != nil {
			return err
		}
	}
	if !slices.Contains([]string{"us", "eu", "ap"}, text(config, "localxposeRegion")) {
		return errors.New("Invalid LocalXpose region")
	}
	if ip, err := netip.ParseAddr(text(config, "httpsHost")); err != nil || ip.Zone() != "" {
		return errors.New("Listener address must be an IP address")
	}
	if port := uintOr(config["httpsPort"], 0); port < 1 || port > 65535 {
		return errors.New("Invalid listener port")
	}
	if raw := text(config, "httpsUrl"); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || !u.IsAbs() || u.Scheme == "https" && u.Hostname() == "" {
			return errors.New("Invalid HTTPS URL")
		}
		if !ingressURLAllowed(u, "https", "/mcp") {
			return errors.New("Enter an HTTPS URL ending in /mcp without credentials or query parameters.")
		}
	}
	if tunnel := text(config, "tunnelId"); tunnel != "" && (!strings.HasPrefix(tunnel, "tunnel_") || !ingressIdentifierChars(tunnel)) {
		return errors.New("Invalid Tunnel ID format")
	}
	return nil
}

func ingressIdentifierChars(value string) bool {
	for _, c := range []byte(value) {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func ingressURLAllowed(u *url.URL, scheme, path string) bool {
	encodedPath := u.EscapedPath()
	if encodedPath == "" {
		encodedPath = "/"
	}
	return u.Scheme == scheme && u.Hostname() != "" && encodedPath == path &&
		u.RawQuery == "" && !u.ForceQuery && u.Fragment == "" && u.User == nil
}

func ingressValidateProxy(mode, address string) error {
	switch mode {
	case "system", "direct":
		if address != "" {
			return errors.New("Only a custom proxy accepts an address")
		}
	case "custom":
		u, err := url.Parse(address)
		if len(address) > 2048 || err != nil || !ingressURLAllowed(u, "http", "/") && !ingressURLAllowed(u, "https", "/") ||
			u.Port() == "0" || strings.Contains(address, "#") {
			return errors.New("Enter an HTTP/HTTPS proxy URL, such as http://127.0.0.1:7890. Embedded credentials are unsupported.")
		}
	default:
		return errors.New("Invalid proxy mode")
	}
	return nil
}

func init() {
	ingressConfigDefaults = ingressDefaults
	ingressConfigSecrets = ingressSecretFields
	validateIngressConfig = ingressValidateConfig
	validateNetworkPreferences = ingressValidateProxy
	registerIngressManagementDescriptor(ingressDescriptor)
}

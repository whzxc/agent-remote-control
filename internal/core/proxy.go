package core

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

var proxyEnvironmentKeys = []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"}

type networkProxy struct {
	http, https *url.URL
	bypass      string
	message     string
}

const proxyAddressError = "Enter an HTTP/HTTPS proxy URL, such as http://127.0.0.1:7890. Embedded credentials are unsupported."

func parseProxyAddress(address string) (*url.URL, error) {
	proxy, err := url.Parse(strings.TrimSpace(address))
	if len(address) > 2048 || err != nil || proxy.Hostname() == "" ||
		(proxy.Scheme != "http" && proxy.Scheme != "https") ||
		(proxy.User != nil && proxy.User.String() != "") ||
		proxy.ForceQuery || proxy.RawQuery != "" || strings.Contains(address, "#") ||
		(proxy.EscapedPath() != "" && proxy.EscapedPath() != "/") {
		return nil, errors.New(proxyAddressError)
	}
	if port := proxy.Port(); port != "" {
		n, err := strconv.ParseUint(port, 10, 16)
		if err != nil || n == 0 {
			return nil, errors.New(proxyAddressError)
		}
		if proxy.Scheme == "http" && n == 80 || proxy.Scheme == "https" && n == 443 {
			proxy.Host = strings.ToLower(strings.TrimSuffix(proxy.Host, ":"+port))
		} else {
			proxy.Host = net.JoinHostPort(strings.ToLower(proxy.Hostname()), strconv.FormatUint(n, 10))
		}
	}
	proxy.Host = strings.ToLower(strings.TrimSuffix(proxy.Host, ":"))
	proxy.Path = "/"
	proxy.User = nil
	return proxy, nil
}

func validateNetworkProxy(mode, address string) error {
	switch mode {
	case "custom":
		_, err := parseProxyAddress(address)
		return err
	case "system", "direct":
		if address != "" {
			return errors.New("Only a custom proxy accepts an address")
		}
		return nil
	default:
		return errors.New("Invalid proxy mode")
	}
}

func environmentProxy(keys []string, relay bool) (*url.URL, error) {
	for _, key := range keys {
		if value := os.Getenv(key); value != "" {
			proxy, err := url.Parse(value)
			if err != nil {
				if relay {
					return nil, errors.New("Invalid relay proxy environment URL")
				}
				return nil, errors.New("Invalid HTTP/HTTPS proxy environment URL")
			}
			schemes := []string{"http", "https"}
			if relay {
				schemes = append(schemes, "socks5", "socks5h")
			}
			if proxy.Hostname() == "" || !slices.Contains(schemes, proxy.Scheme) {
				if relay {
					return nil, errors.New("Unsupported relay proxy environment URL")
				}
				return nil, errors.New("HTTP/HTTPS proxy environment must use http:// or https://")
			}
			if proxy.Path == "" {
				proxy.Path = "/"
			}
			return proxy, nil
		}
	}
	return nil, nil
}

func resolveRelayNetworkProxy(ctx context.Context, settings object) (networkProxy, error) {
	if text(settings, "proxyMode") == "system" {
		https, err := environmentProxy([]string{"https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"}, true)
		if err != nil {
			return networkProxy{}, err
		}
		if https != nil {
			http, err := environmentProxy([]string{"http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"}, true)
			bypass, exists := os.LookupEnv("NO_PROXY")
			if !exists {
				bypass = os.Getenv("no_proxy")
			}
			return networkProxy{http: http, https: https, bypass: bypass + ",localhost,127.0.0.1,::1", message: "Using relay environment proxy"}, err
		}
	}
	return resolveNetworkProxy(ctx, settings)
}

func resolveNetworkProxy(ctx context.Context, settings object) (networkProxy, error) {
	mode, address := text(settings, "proxyMode"), text(settings, "proxyUrl")
	if err := validateNetworkProxy(mode, address); err != nil {
		return networkProxy{}, err
	}
	bypass := []string{}
	for _, key := range []string{"NO_PROXY", "no_proxy"} {
		if value := os.Getenv(key); value != "" {
			bypass = append(bypass, value)
		}
	}
	proxy := networkProxy{
		bypass:  strings.Join(append(bypass, "localhost", "127.0.0.1", "::1"), ","),
		message: "Proxy disabled; connecting directly",
	}
	switch mode {
	case "custom":
		proxy.http, _ = parseProxyAddress(address)
		proxy.https, proxy.message = proxy.http, "Using custom proxy"
	case "system":
		proxy.message = "No system HTTP/HTTPS proxy configured; connecting directly"
		var err error
		switch runtime.GOOS {
		case "darwin":
			err = proxy.detectMacOS(ctx)
		case "windows":
			err = proxy.detectWindows(ctx)
		case "linux":
			proxy.http, err = environmentProxy([]string{"http_proxy", "HTTP_PROXY"}, false)
			if err == nil {
				proxy.https, err = environmentProxy([]string{"https_proxy", "HTTPS_PROXY"}, false)
			}
		}
		if err != nil {
			return networkProxy{}, err
		}
		if proxy.http != nil || proxy.https != nil {
			proxy.message = "Using system HTTP/HTTPS proxy"
		}
	}
	return proxy, nil
}

func (p networkProxy) tunnelProxyURL() string {
	if p.https != nil {
		return p.https.String()
	}
	if p.http != nil {
		return p.http.String()
	}
	return ""
}

func (p networkProxy) apply(command *exec.Cmd) {
	environment := slices.DeleteFunc(command.Environ(), func(entry string) bool {
		key, _, _ := strings.Cut(entry, "=")
		if runtime.GOOS == "windows" {
			key = strings.ToUpper(key)
		}
		return slices.Contains(proxyEnvironmentKeys, key)
	})
	if p.http != nil {
		environment = append(environment, "HTTP_PROXY="+p.http.String(), "http_proxy="+p.http.String())
	}
	if p.https != nil {
		environment = append(environment, "HTTPS_PROXY="+p.https.String(), "https_proxy="+p.https.String())
	}
	command.Env = append(environment, "NO_PROXY="+p.bypass, "no_proxy="+p.bypass)
}

func (p networkProxy) proxyFor(req *http.Request) (*url.URL, error) {
	host := req.URL.Hostname()
	ip, ipErr := netip.ParseAddr(host)
	for bypass := range strings.SplitSeq(p.bypass, ",") {
		bypass = strings.TrimSpace(bypass)
		switch {
		case bypass == "":
			continue
		case bypass == "*":
			return nil, nil
		case ipErr == nil:
			if address, err := netip.ParseAddr(bypass); err == nil && address == ip {
				return nil, nil
			}
			if prefix, err := netip.ParsePrefix(bypass); err == nil && prefix.Contains(ip) {
				return nil, nil
			}
		default:
			domain := strings.TrimPrefix(bypass, ".")
			if host == domain || strings.HasSuffix(host, "."+domain) {
				return nil, nil
			}
		}
	}
	switch req.URL.Scheme {
	case "http":
		return p.http, nil
	case "https":
		return p.https, nil
	default:
		return nil, nil
	}
}

func systemProxyOutput(parent context.Context, binary string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	output, err := commandOutput(ctx, binary, args...)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "", errors.New("System proxy read timed out. Select a custom proxy or no proxy.")
	}
	if err != nil {
		return "", errors.New("Cannot read the system proxy. Select a custom proxy or no proxy.")
	}
	return output, nil
}

const proxyPACError = "System PAC/WPAD is unsupported. Select a custom proxy or no proxy."

func (p *networkProxy) detectMacOS(ctx context.Context) error {
	output, err := systemProxyOutput(ctx, "/usr/sbin/scutil", "--proxy")
	if err != nil {
		return err
	}
	depth := 0
	settings := map[string]string{}
	for line := range strings.SplitSeq(output, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasSuffix(line, "{"):
			depth++
		case line == "}":
			depth = max(0, depth-1)
		case depth == 1:
			if key, value, ok := strings.Cut(line, " : "); ok {
				settings[key] = value
			}
		}
	}
	if settings["ProxyAutoConfigEnable"] == "1" || settings["ProxyAutoDiscoveryEnable"] == "1" {
		return errors.New(proxyPACError)
	}
	for _, item := range []struct {
		scheme string
		target **url.URL
	}{{"HTTP", &p.http}, {"HTTPS", &p.https}} {
		if settings[item.scheme+"Enable"] != "1" {
			continue
		}
		host, found := settings[item.scheme+"Proxy"]
		if !found {
			return errors.New("System proxy address is missing")
		}
		port, err := strconv.ParseUint(settings[item.scheme+"Port"], 10, 16)
		if err != nil || port == 0 {
			return errors.New("Invalid system proxy port")
		}
		*item.target, err = parseProxyAddress("http://" + net.JoinHostPort(host, strconv.FormatUint(port, 10)))
		if err != nil {
			return errors.New("Invalid system proxy address")
		}
	}
	if p.http == nil && p.https == nil && settings["SOCKSEnable"] == "1" {
		return errors.New("SOCKS-only system proxies are unsupported. Specify an HTTP/HTTPS proxy.")
	}
	return nil
}

const windowsProxyScript = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$p=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$c=Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections' -ErrorAction SilentlyContinue
$f=$c.DefaultConnectionSettings
@{ enabled=($p.ProxyEnable -eq 1); server=[string]$p.ProxyServer; auto=([bool]$p.AutoConfigURL -or ($f.Length -gt 8 -and ($f[8] -band 12) -ne 0)) } | ConvertTo-Json -Compress
`

func (p *networkProxy) detectWindows(ctx context.Context) error {
	output, err := systemProxyOutput(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsProxyScript)
	if err != nil {
		return err
	}
	var settings object
	if canonjson.Unmarshal([]byte(strings.TrimPrefix(output, "\ufeff")), &settings) != nil {
		return errors.New("Cannot parse the Windows system proxy")
	}
	if settings["auto"] == true {
		return errors.New(proxyPACError)
	}
	if settings["enabled"] != true {
		return nil
	}
	for item := range strings.SplitSeq(text(settings, "server"), ";") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		scheme, address, split := strings.Cut(item, "=")
		if !split {
			scheme, address = "all", item
		}
		if scheme != "all" && scheme != "http" && scheme != "https" {
			continue
		}
		if !strings.Contains(address, "://") {
			address = "http://" + address
		}
		proxy, err := parseProxyAddress(address)
		if err != nil {
			return err
		}
		if scheme != "https" {
			p.http = proxy
		}
		if scheme != "http" {
			p.https = proxy
		}
	}
	if p.http == nil && p.https == nil {
		return errors.New("No HTTP/HTTPS system proxy is available. Configure a custom proxy.")
	}
	return nil
}

func savedNetworkProxy(ctx context.Context) (networkProxy, error) {
	settings, err := cachedLoad(filepath.Join(root(), "app/preferences.json"))
	if err != nil {
		settings = object{"proxyMode": "system"}
	}
	return resolveNetworkProxy(ctx, obj(settings))
}

func init() {
	validateNetworkPreferences = validateNetworkProxy
	registerDownstreamMCPProxy(func(ctx context.Context) (func(*http.Request) (*url.URL, error), error) {
		proxy, err := savedNetworkProxy(ctx)
		return proxy.proxyFor, err
	})
}

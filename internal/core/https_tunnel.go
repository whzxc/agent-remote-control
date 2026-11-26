package core

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/whzxc/agent-remote-control/internal/platform"
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

var managedTunnelInstallLock sync.Mutex

func providerBinary(provider string) string {
	name := map[string]string{"cloudflare": "cloudflared", "ngrok": "ngrok", "pinggy": "pinggy", "localxpose": "loclx"}[provider]
	if operatingSystem == "windows" && name != "" {
		name += ".exe"
	}
	return name
}

func installManagedTunnel(ctx context.Context, provider string, proxy networkProxy) (string, error) {
	managedTunnelInstallLock.Lock()
	defer managedTunnelInstallLock.Unlock()
	name := providerBinary(provider)
	if name == "" {
		return "", errors.New("Invalid HTTPS provider")
	}
	osName, arch := operatingSystem, runtime.GOARCH
	directory := filepath.Join(root(), "dependencies", provider, osName+"-"+arch)
	if err := platform.PrivateDir(directory); err != nil {
		return "", err
	}
	binary, manifest := filepath.Join(directory, name), filepath.Join(directory, "installed.json")
	if data, err := os.ReadFile(binary); err == nil {
		if meta, err := load(manifest); err == nil && meta != nil && field(meta, "sha256") == hash(data) {
			return binary, nil
		}
	}
	if runtimeFixture {
		return "", errFixtureProviderUnavailable
	}
	client := networkHTTPClient(proxy)
	client.CheckRedirect = nil
	defer client.CloseIdleConnections()
	var address, digest, extension string
	switch provider {
	case "cloudflare", "pinggy":
		var repo, version, assetName string
		if provider == "cloudflare" {
			repo, version = "cloudflare/cloudflared", "latest"
			assetName = "cloudflared-" + osName + "-" + arch
			extension = "binary"
			switch operatingSystem {
			case "windows":
				extension = "exe"
			case "darwin":
				extension = "tgz"
			}
			if extension != "binary" {
				assetName += "." + extension
			}
		} else {
			repo, version, extension = "Pinggy-io/cli-js", "tags/v0.5.8", "binary"
			osLabel := map[string]string{"darwin": "macos", "linux": "linux", "windows": "win"}[osName]
			cpu := map[string]string{"amd64": "x64", "arm64": "arm64"}[arch]
			assetName = "pinggy-" + osLabel + "-" + cpu
			if osName == "windows" {
				assetName += ".exe"
			}
		}
		metadata, err := fetchTunnelAsset(ctx, client, "https://api.github.com/repos/"+repo+"/releases/"+version, 8<<20)
		if err != nil {
			return "", err
		}
		var release object
		if err := decodeObject(metadata, &release); err != nil {
			return "", err
		}
		asset := find(release["assets"], "name", assetName)
		if asset == nil {
			return "", fmt.Errorf("%s has no download for this platform", provider)
		}
		address = text(asset, "browser_download_url")
		if !strings.HasPrefix(address, "https://github.com/"+repo+"/releases/download/") {
			return "", fmt.Errorf("Invalid %s download URL", provider)
		}
		var ok bool
		digest, ok = strings.CutPrefix(text(asset, "digest"), "sha256:")
		if !ok {
			return "", fmt.Errorf("Official %s checksum is missing", provider)
		}
	case "ngrok":
		extension = "zip"
		if osName == "linux" {
			extension = "tgz"
		}
		address = "https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-" + osName + "-" + arch + "." + extension
	case "localxpose":
		if osName == "windows" && arch != "amd64" {
			return "", errors.New("LocalXpose has no download for this platform")
		}
		address, extension = "https://api.localxpose.io/api/v2/downloads/loclx-"+osName+"-"+arch+".zip", "zip"
	}
	data, err := fetchTunnelAsset(ctx, client, address, 128<<20)
	if err != nil {
		return "", err
	}
	if digest != "" && hash(data) != digest {
		return "", fmt.Errorf("%s tunnel component SHA256 verification failed", provider)
	}
	data, err = unpackTunnelBinary(data, name, extension)
	if err != nil {
		return "", err
	}
	stage := filepath.Join(directory, id())
	if err := os.WriteFile(stage, data, 0700); err != nil {
		return "", err
	}
	defer os.Remove(stage)
	if err := platform.ReplaceFile(stage, binary); err != nil {
		return "", err
	}
	return binary, save(manifest, object{"sha256": hash(data)})
}

func unpackTunnelBinary(data []byte, name, extension string) ([]byte, error) {
	switch extension {
	case "exe", "binary":
		return data, nil
	case "zip":
		bundle, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, err
		}
		for _, item := range bundle.File {
			if strings.TrimPrefix(item.Name, "./") == name && item.Mode().IsRegular() {
				reader, err := item.Open()
				if err != nil {
					return nil, err
				}
				defer reader.Close()
				return readTunnelExecutable(reader)
			}
		}
	case "tgz":
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		tarball := tar.NewReader(gz)
		for {
			h, err := tarball.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, err
			}
			if strings.TrimPrefix(h.Name, "./") == name && h.Typeflag == tar.TypeReg {
				return readTunnelExecutable(tarball)
			}
		}
	}
	return nil, errors.New("Component is incomplete")
}

func readTunnelExecutable(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, 512<<20+1))
	if len(data) > 512<<20 {
		return nil, errors.New("Tunnel component download is too large")
	}
	return data, err
}

type managedHTTPSProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
}

func (process *managedHTTPSProcess) stop() {
	select {
	case <-process.done:
	default:
		platform.SignalTree(process.cmd.Process.Pid, true)
		_ = process.cmd.Process.Kill()
		<-process.done
	}
}

type managedTunnel struct {
	ingress                                                *networkIngress
	binary, directory, admin, provider, upstream, selected string
	args, env                                              []string
	settings                                               object
	proxy                                                  networkProxy
	pinggyID, pinggyState                                  string
	named                                                  bool
	process                                                *managedHTTPSProcess
	mu                                                     sync.Mutex
	outputURLs                                             []string
	outputError, ngrokCode                                 string
	url                                                    string
	health                                                 object
	everReady                                              bool
	restartCount, attempts                                 uint64
	degraded, unstable, stableSince                        time.Time
}

func providerCommand(ctx context.Context, binary string, proxy networkProxy, args ...string) *exec.Cmd {
	cmd := nativeCommand(ctx, binary, args...)
	var env []string
	for _, item := range cmd.Environ() {
		name, _, _ := strings.Cut(item, "=")
		if name == "ACCESS_TOKEN" || slices.ContainsFunc([]string{"TUNNEL_", "CLOUDFLARED_", "NGROK_", "PINGGY_", "LX_"}, func(prefix string) bool { return strings.HasPrefix(name, prefix) }) {
			continue
		}
		env = append(env, item)
	}
	cmd.Env = env
	proxy.apply(cmd)
	return cmd
}

func prepareManagedTunnel(ctx context.Context, i *networkIngress, settings object, address string) (*managedTunnel, error) {
	provider := text(settings, "httpsProvider")
	proxy, err := resolveNetworkProxy(ctx, settings)
	if err != nil {
		return nil, err
	}
	binary, err := installManagedTunnel(ctx, provider, proxy)
	if err != nil {
		return nil, err
	}
	hold, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	defer hold.Close()
	directory := filepath.Join(root(), "runs", id())
	if err := platform.PrivateDir(directory); err != nil {
		return nil, err
	}
	built := false
	defer func() {
		if !built {
			_ = os.RemoveAll(directory)
		}
	}()
	tunnel := &managedTunnel{ingress: i, binary: binary, directory: directory, admin: hold.Addr().String(), provider: provider,
		upstream: "http://" + address, settings: settings, proxy: proxy, health: object{}, selected: text(settings, "httpsUrl")}
	config := filepath.Join(directory, "config.yml")
	switch provider {
	case "cloudflare":
		tunnel.named = settings["cloudflareMode"] == "named"
		tunnel.args = []string{"tunnel", "--config", config, "--no-autoupdate", "--protocol", "http2", "--metrics", tunnel.admin}
		conf := object{}
		if tunnel.named && settings["cloudflareAuth"] == "login" {
			if runtimeFixture {
				return nil, errFixtureProviderUnavailable
			}
			id := text(settings, "cloudflareTunnelId")
			parsed, err := url.Parse(tunnel.selected)
			if err != nil {
				return nil, err
			}
			conf = object{"tunnel": id, "credentials-file": cloudflareCredentials(id), "ingress": []object{
				{"hostname": parsed.Hostname(), "service": tunnel.upstream}, {"service": "http_status:404"},
			}}
			tunnel.args = append(tunnel.args, "run", id)
		} else if tunnel.named {
			token := filepath.Join(directory, "tunnel-token")
			if err := saveBytes(token, []byte(text(settings, "cloudflareToken"))); err != nil {
				return nil, err
			}
			tunnel.args = append(tunnel.args, "run", "--token-file", token)
		} else {
			tunnel.args = append(tunnel.args, "--url", tunnel.upstream)
		}
		if err := save(config, conf); err != nil {
			return nil, err
		}
	case "ngrok":
		agent := object{"authtoken": settings["ngrokAuthtoken"], "web_addr": tunnel.admin, "console_ui": false, "inspect_db_size": -1,
			"log_format": "json", "log": "stdout", "update_check": false, "remote_management": false}
		if address := proxy.tunnelProxyURL(); address != "" {
			agent["proxy_url"] = address
		}
		if err := save(config, object{"version": "3", "agent": agent}); err != nil {
			return nil, err
		}
		tunnel.args = []string{"http", tunnel.upstream, "--config", config}
		if settings["ngrokMode"] == "named" {
			endpoint, err := ngrokEndpoint(text(settings, "ngrokEndpoint"))
			if err != nil {
				return nil, err
			}
			tunnel.args = append(tunnel.args, "--url", endpoint)
		}
	case "pinggy":
		tunnel.pinggyID, tunnel.pinggyState = id(), filepath.Join(root(), "dependencies/pinggy/state")
		if err := platform.PrivateDir(tunnel.pinggyState); err != nil {
			return nil, err
		}
		tunnel.env = tunnel.pinggyEnvironment()
		config = filepath.Join(directory, "pinggy.json")
		tunnel.named = settings["pinggyMode"] == "named"
		token, host := "", "free.pinggy.io"
		if tunnel.named {
			token, host = text(settings, "pinggyToken"), "pro.pinggy.io"
		}
		value := object{"version": "1.0", "configId": tunnel.pinggyID, "token": token, "serverAddress": host,
			"forwarding": []object{{"type": "http", "address": address}}, "autoReconnect": false, "optional": object{"noTui": true}}
		if err := save(config, value); err != nil {
			return nil, err
		}
		tunnel.args = []string{"--conf", config}
	case "localxpose":
		tunnel.named = settings["localxposeMode"] == "named"
		tunnel.env = []string{"LX_ACCESS_TOKEN=" + text(settings, "localxposeAccessToken")}
		tunnel.args = []string{"tunnel", "--raw-mode", "http", "--to", address}
		if tunnel.named {
			fixed, err := url.Parse(tunnel.selected)
			if err != nil || fixed.Hostname() == "" {
				return nil, errors.New("Invalid fixed LocalXpose domain")
			}
			tunnel.args = append(tunnel.args, "--reserved-domain", fixed.Hostname())
		} else {
			tunnel.args = append(tunnel.args, "--region", text(settings, "localxposeRegion"))
		}
	}
	hold.Close()
	if err := tunnel.spawn(); err != nil {
		return nil, err
	}
	built = true
	return tunnel, nil
}

func (t *managedTunnel) pinggyEnvironment() []string {
	return []string{"XDG_CONFIG_HOME=" + t.pinggyState, "APPDATA=" + t.pinggyState, "LOCALAPPDATA=" + t.pinggyState, "PINGGY_LOG_LEVEL=error", "NO_COLOR=1"}
}

func (t *managedTunnel) spawn() error {
	cmd := providerCommand(context.Background(), t.binary, t.proxy, t.args...)
	cmd.Env = append(cmd.Env, t.env...)
	cmd.Stdout, cmd.Stderr = &tunnelOutput{tunnel: t}, &tunnelOutput{tunnel: t}
	if err := startOwnedChild(cmd); err != nil {
		return fmt.Errorf("Cannot start %s: %w", t.provider, err)
	}
	process := &managedHTTPSProcess{cmd: cmd, done: make(chan struct{})}
	t.process = process
	go func() { _ = cmd.Wait(); close(process.done) }()
	return nil
}

func (t *managedTunnel) stop() {
	recordIngressObservation(object{"ingressId": t.ingress.id, "provider": t.provider, "pid": t.process.cmd.Process.Pid}, "provider_stop")
	if t.pinggyID != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		cmd := providerCommand(ctx, t.binary, t.proxy, "stop", t.pinggyID)
		cmd.Env = append(cmd.Env, t.pinggyEnvironment()...)
		_ = cmd.Run()
	}
	t.process.stop()
	_ = os.RemoveAll(t.directory)
}

var tunnelANSI = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
var tunnelHTTPSURL = regexp.MustCompile(`https://[^\s<>"']+`)
var tunnelLocalxposeOutput = regexp.MustCompile(`(?:^|\s)([A-Za-z0-9][A-Za-z0-9.-]*)\s*=>\s*\[running\]`)
var tunnelNgrokCode = regexp.MustCompile(`ERR_NGROK_[0-9]+`)

type tunnelOutput struct {
	tunnel *managedTunnel
	line   []byte
	urls   []string
	inURLs bool
}

func (out *tunnelOutput) Write(data []byte) (int, error) {
	for _, b := range data {
		if b == '\n' || b == '\r' {
			out.record(string(out.line))
			out.line = out.line[:0]
		} else if len(out.line) < 16384 {
			out.line = append(out.line, b)
		}
	}
	return len(data), nil
}

func (out *tunnelOutput) record(line string) {
	t := out.tunnel
	line = strings.TrimSpace(tunnelANSI.ReplaceAllString(line, ""))
	t.mu.Lock()
	defer t.mu.Unlock()
	switch t.provider {
	case "ngrok":
		if code := tunnelNgrokCode.FindString(line); code != "" {
			t.ngrokCode = code
		}
	case "cloudflare":
		if line == "" {
			return
		}
		level := "INFO"
		switch {
		case strings.Contains(line, " ERR "):
			level = "ERROR"
		case strings.Contains(line, " WRN "):
			level = "WARN"
		case strings.Contains(line, " DBG "):
			level = "DEBUG"
		}
		t.ingress.logProvider(level, "cloudflare: "+line)
	case "pinggy":
		switch {
		case line == "Remote URLs:":
			out.inURLs, out.urls = true, []string{}
		case out.inURLs && strings.HasPrefix(line, "https://"):
			if address := tunnelPublicURL(tunnelHTTPSURL.FindString(line), false); address != "" && len(out.urls) < 16 && !slices.Contains(out.urls, address) {
				out.urls = append(out.urls, address)
			}
		case out.inURLs && strings.HasPrefix(line, "─"):
			if len(out.urls) != 0 {
				t.outputURLs, t.outputError = out.urls, ""
			}
			out.inURLs = false
		}
		if strings.Contains(line, "Disconnected:") || strings.Contains(line, "Tunnel stopped.") {
			t.outputError = "Pinggy tunnel disconnected. Reconnect."
		}
	case "localxpose":
		if match := tunnelLocalxposeOutput.FindStringSubmatch(line); len(match) == 2 {
			if address := tunnelPublicURL("https://"+match[1], false); address != "" {
				t.outputURLs = []string{address}
			}
		}
	}
}

func tunnelPublicURL(raw string, cloudflare bool) string {
	u, err := url.Parse(raw)
	if err != nil || !ingressURLAllowed(u, "https", "/") || strings.Contains(raw, "#") ||
		cloudflare && !strings.HasSuffix(u.Hostname(), ".trycloudflare.com") {
		return ""
	}
	return ingressURLOrigin(u) + "/mcp"
}

func (t *managedTunnel) probe(ctx context.Context) (bool, error) {
	t.health["readyConnections"], t.health["httpStatus"] = nil, nil
	select {
	case <-t.process.done:
		t.health["processState"] = "exited"
		t.mu.Lock()
		code := t.ngrokCode
		t.mu.Unlock()
		switch {
		case code == "ERR_NGROK_334":
			return false, errors.New("The fixed ngrok domain is in use. Close the connection using it or use another domain (ERR_NGROK_334).")
		case code != "":
			return false, fmt.Errorf("ngrok tunnel startup failed (%s). See https://ngrok.com/docs/errors/%s", code, strings.ToLower(code))
		default:
			return false, fmt.Errorf("%s tunnel process exited. Check credentials, network, concurrent account sessions, and endpoint quotas before retrying.", t.provider)
		}
	default:
		t.health["processState"] = "running"
	}
	if t.provider == "pinggy" || t.provider == "localxpose" {
		t.mu.Lock()
		urls, failure := slices.Clone(t.outputURLs), t.outputError
		t.mu.Unlock()
		if failure != "" {
			return false, errors.New(failure)
		}
		if len(urls) == 0 {
			return false, nil
		}
		selected := urls[0]
		if t.named {
			if !slices.Contains(urls, t.selected) {
				return false, fmt.Errorf("%s public hostname does not match configuration", t.provider)
			}
			selected = t.selected
		}
		if t.url != "" && t.url != selected {
			return false, fmt.Errorf("%s public URL changed. Reconnect.", t.provider)
		}
		t.url = selected
		return true, nil
	}
	transport := &http.Transport{}
	client := &http.Client{Transport: transport, CheckRedirect: relayNoRedirect, Timeout: 2 * time.Second}
	defer client.CloseIdleConnections()
	base := "http://" + t.admin
	route := "/ready"
	if t.provider == "ngrok" {
		route = "/api/endpoints"
	}
	value, _, status, err := relayHTTP(ctx, client, http.MethodGet, base+route, nil, 2*time.Second)
	if status == 0 && err != nil {
		return false, fmt.Errorf("%s tunnel health check failed: %w", t.provider, err)
	}
	t.health["httpStatus"] = status
	if t.provider == "cloudflare" {
		t.health["readyConnections"] = field(value, "readyConnections")
	}
	if status/100 != 2 {
		message := fmt.Sprintf("%s tunnel is not ready (HTTP %d)", t.provider, status)
		if count, ok := uintValue(t.health["readyConnections"]); ok {
			message += fmt.Sprintf(". Available edge connections: %d", count)
		}
		return false, errors.New(message)
	}
	if t.provider == "cloudflare" {
		if t.named {
			t.url = t.selected
			return true, nil
		}
		discovered, _, _, _ := relayHTTP(ctx, client, http.MethodGet, base+"/quicktunnel", nil, 2*time.Second)
		host := text(discovered, "hostname")
		if !strings.HasPrefix(host, "https://") {
			host = "https://" + host
		}
		target := tunnelPublicURL(host, true)
		if target == "" {
			return false, nil
		}
		if t.url == "" {
			t.url = target
		}
		return t.url == target, nil
	}
	for _, endpoint := range arr(field(value, "endpoints")) {
		if strings.TrimRight(text(field(endpoint, "upstream"), "url"), "/") == t.upstream {
			if address := tunnelPublicURL(text(endpoint, "url"), false); address != "" {
				if t.url == "" {
					t.url = address
				}
				return t.url == address, nil
			}
		}
	}
	return false, nil
}

func (i *networkIngress) logProvider(level, message string) {
	message = i.redactNetworkError(message)
	if level == "WARN" || level == "ERROR" {
		i.mu.Lock()
		i.lastError, i.lastErrorAt = message, now()
		i.mu.Unlock()
	}
	recordLog(level, message, &i.id)
}

func (t *managedTunnel) refresh(ctx context.Context) (bool, error) {
	oldState, oldConnections, oldError := t.health["state"], t.health["readyConnections"], text(t.health, "error")
	ready, err := t.probe(ctx)
	state, code, message := "starting", "PROVIDER_UNAVAILABLE", ""
	var downtime any
	if !t.degraded.IsZero() {
		downtime = time.Since(t.degraded).Milliseconds()
	}
	if ready {
		state, code = "ready", "READY"
		t.everReady = true
		t.degraded, t.unstable = time.Time{}, time.Time{}
		if t.stableSince.IsZero() {
			t.stableSince = time.Now()
		} else if time.Since(t.stableSince) >= 120*time.Second {
			t.attempts = 0
		}
		t.health["retryAfterSeconds"], t.health["lastReadyAt"] = nil, now()
		if oldState == "degraded" {
			t.health["recoveredAt"], t.health["lastDowntimeMs"] = now(), downtime
		}
	} else {
		message = t.provider + " tunnel is not ready"
		if err != nil {
			message = err.Error()
		}
		if t.health["processState"] == "exited" {
			code = "PROVIDER_EXITED"
		} else if t.health["readyConnections"] != nil && uintOr(t.health["readyConnections"], 0) == 0 {
			code = "EDGE_UNAVAILABLE"
		}
		t.stableSince = time.Time{}
		if t.degraded.IsZero() {
			t.degraded = time.Now()
		}
		if t.unstable.IsZero() {
			t.unstable = time.Now()
		}
		backoff := time.Duration(min(60<<min(t.attempts, 3), 300)) * time.Second
		if t.everReady {
			state = "degraded"
			if oldState != "degraded" {
				t.health["lastDegradedAt"] = now()
			}
			if t.provider == "cloudflare" && time.Since(t.unstable) >= backoff {
				t.restartCount++
				recordIngressObservation(object{"ingressId": t.ingress.id, "provider": t.provider, "restartCount": t.restartCount, "downtimeMs": downtime}, "provider_restart")
				t.process.stop()
				t.unstable = time.Now()
				t.attempts++
				if err := t.spawn(); err != nil {
					message = "Cloudflare recovery failed: " + err.Error()
				} else {
					message = "Cloudflare is reconnecting and resolving edge addresses again"
					t.ingress.logProvider("WARN", "Cloudflare remained unavailable; restarting provider to refresh edge discovery")
				}
			}
		}
		t.health["retryAfterSeconds"] = int64(max(time.Duration(0), backoff-time.Since(t.unstable)) / time.Second)
	}
	t.health["pid"], t.health["state"], t.health["code"], t.health["error"] = t.process.cmd.Process.Pid, state, code, message
	t.health["observedAt"], t.health["restartAttempts"], t.health["restartCount"] = now(), t.attempts, t.restartCount
	if state != oldState || wire(oldConnections) != wire(t.health["readyConnections"]) {
		recordIngressObservation(object{"ingressId": t.ingress.id, "provider": t.provider, "previousState": oldState,
			"state": state, "previousReadyConnections": oldConnections, "readyConnections": t.health["readyConnections"], "restartCount": t.restartCount, "downtimeMs": downtime}, "provider_health")
	}
	if ready && oldState != "ready" {
		t.ingress.logProvider("INFO", t.provider+" tunnel ready")
	} else if !ready && t.everReady && message != oldError {
		t.ingress.logProvider("WARN", message)
	}
	t.mu.Lock()
	urls := slices.Clone(t.outputURLs)
	t.mu.Unlock()
	if urls == nil {
		urls = []string{}
	}
	t.ingress.mu.Lock()
	t.ingress.managedHealth, t.ingress.managedURLs = clone(t.health), urls
	t.ingress.mu.Unlock()
	return ready, err
}

func startManagedHTTPSIngress(ctx context.Context, i *networkIngress, settings object) error {
	address, err := listenHTTPSIngress(i, settings)
	if err != nil {
		return err
	}
	t, err := prepareManagedTunnel(ctx, i, settings, address)
	if err != nil {
		return err
	}
	started := false
	defer func() {
		if !started {
			t.stop()
		}
	}()
	wait, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	for {
		ready, err := t.refresh(wait)
		if ready {
			break
		}
		if err != nil && (t.health["processState"] == "exited" || t.provider == "pinggy" || t.provider == "localxpose") {
			return err
		}
		timer := time.NewTimer(300 * time.Millisecond)
		select {
		case <-wait.Done():
			timer.Stop()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			message := t.provider + " connection timed out. Check the network"
			switch t.provider {
			case "cloudflare":
				message += ". Cloudflare requires outbound access to port 7844"
			case "ngrok":
				message += ", Authtoken, and the account's tunnel quota"
			}
			return errors.New(message)
		case <-timer.C:
		}
	}
	i.mu.Lock()
	if i.verification["endpoint"] != t.url {
		v := object{"binding": ingressBinding(settings), "endpoint": t.url, "code": id(), "verifiedAt": nil}
		if err := save(filepath.Join(i.directory, "verification.json"), v); err != nil {
			i.mu.Unlock()
			return err
		}
		i.verification = v
	}
	lifetime, stop := context.WithCancel(context.Background())
	done := make(chan struct{})
	i.running, i.url, i.failure = true, t.url, ""
	i.providerStop = func() { stop(); <-done; t.stop() }
	i.mu.Unlock()
	go func() {
		defer close(done)
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-lifetime.Done():
				return
			case <-tick.C:
				_, err := t.refresh(lifetime)
				if err != nil && t.provider != "cloudflare" {
					i.mu.Lock()
					i.running, i.failure = false, err.Error()
					i.mu.Unlock()
				}
			}
		}
	}()
	started = true
	recordLog("INFO", "Local MCP listener started; verify public inbound access from the control source", &i.id)
	return nil
}

func init() { startManagedIngress = startManagedHTTPSIngress }

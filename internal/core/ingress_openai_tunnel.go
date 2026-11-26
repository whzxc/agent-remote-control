package core

import (
	"archive/zip"
	"bytes"
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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const openAITunnelMinimumVersion = "0.0.16"

var openAITunnelVersionPattern = regexp.MustCompile(`(?:^|[\s\p{Z}\x{0085}])v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:\+[0-9A-Za-z.-]+)?(?:[\s\p{Z}\x{0085}]|$)`)
var openAITunnelInstallLock sync.Mutex
var ingressCodexBinary func() string

type officialTunnel struct {
	cmd       *exec.Cmd
	directory string
	done      chan struct{}
}

func (t *officialTunnel) stop() {
	select {
	case <-t.done:
	default:
		platform.SignalTree(t.cmd.Process.Pid, false)
		deadline := time.NewTimer(10 * time.Second)
		defer deadline.Stop()
		select {
		case <-t.done:
		case <-deadline.C:
			platform.SignalTree(t.cmd.Process.Pid, true)
			t.cmd.Process.Kill()
			<-t.done
		}
	}
	_ = os.RemoveAll(t.directory)
}

func officialTunnelCommand(ctx context.Context, binary string, args ...string) *exec.Cmd {
	c := nativeCommand(ctx, binary, args...)
	env := []string{}
	for _, item := range os.Environ() {
		name, _, _ := strings.Cut(item, "=")
		if name == "ALLOW_REMOTE_UI" || name == "OPEN_WEB_UI" || name == "ARC_STATE_DIR" ||
			slices.ContainsFunc([]string{"TUNNEL_CLIENT_", "CONTROL_PLANE_", "HEALTH_", "CLOUDFLARED_", "MCP_", "HARPOON_", "ADMIN_UI_", "LOG_"},
				func(prefix string) bool { return strings.HasPrefix(name, prefix) }) {
			continue
		}
		env = append(env, item)
	}
	c.Env = append(env, "ARC_STATE_DIR="+root())
	return c
}

func officialTunnelVersion(ctx context.Context, binary string) ([3]uint64, error) {
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := officialTunnelCommand(wait, binary, "--version")
	data, err := cmd.Output()
	var version [3]uint64
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return version, errors.New("Tunnel Client --version timed out")
	}
	if err != nil {
		if status := cmd.ProcessState; status != nil {
			return version, fmt.Errorf("Tunnel Client --version exited with %s", status)
		}
		return version, fmt.Errorf("Cannot run Tunnel Client --version: %w", err)
	}
	fields := openAITunnelVersionPattern.FindStringSubmatch(string(data))
	if fields == nil {
		return version, errors.New("Unrecognized Tunnel Client --version output")
	}
	for index := range version {
		n, err := strconv.ParseUint(fields[index+1], 10, 64)
		if err != nil {
			return version, errors.New("Invalid Tunnel Client version")
		}
		version[index] = n
	}
	return version, nil
}

func openAITunnelNames() (string, string) {
	if operatingSystem == "windows" {
		return "tunnel-client.exe", "cloudflared.exe"
	}
	return "tunnel-client", "cloudflared"
}

func (i *networkIngress) setTunnelDependency(dependency object) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.tunnelDependency = dependency
}

func (i *networkIngress) prepareOfficialTunnel(ctx context.Context, config object, force bool) (string, error) {
	binary, err := exec.LookPath(text(config, "tunnelBinary"))
	version := [3]uint64{}
	if err == nil {
		version, err = officialTunnelVersion(ctx, binary)
	}
	var observed, path any
	if binary != "" {
		path = binary
	}
	minVersion := []uint64{0, 0, 16}
	if err == nil {
		observed = fmt.Sprintf("%d.%d.%d", version[0], version[1], version[2])
		if !force && slices.Compare(version[:], minVersion) >= 0 {
			i.setTunnelDependency(object{"path": path, "version": observed, "minimumVersion": openAITunnelMinimumVersion, "state": "ready"})
			return binary, nil
		}
	} else if binary != "" && !force {
		i.setTunnelDependency(object{"path": path, "version": nil, "minimumVersion": openAITunnelMinimumVersion,
			"state": "error", "code": "TUNNEL_VERSION_UNKNOWN", "error": err.Error()})
		return "", err
	}
	i.setTunnelDependency(object{"path": path, "version": observed, "minimumVersion": openAITunnelMinimumVersion, "state": "upgrading"})
	installed, err := installOfficialTunnel(ctx, config)
	if err != nil {
		i.setTunnelDependency(object{"path": path, "version": observed, "minimumVersion": openAITunnelMinimumVersion, "state": "error", "code": "TUNNEL_UPGRADE_FAILED", "error": err.Error()})
		return "", err
	}
	version, err = officialTunnelVersion(ctx, installed)
	if err != nil {
		return "", err
	}
	if slices.Compare(version[:], minVersion) < 0 {
		return "", errors.New("Downloaded Tunnel Client is older than " + openAITunnelMinimumVersion)
	}
	if home, err := os.UserHomeDir(); err == nil && binary == filepath.Join(home, ".local/bin/tunnel-client") {
		if err := save(filepath.Join(root(), "dependencies/legacy-tunnel.json"), object{"path": binary}); err != nil {
			return "", err
		}
	}
	i.mu.Lock()
	next := clone(i.entry)
	obj(next["config"])["tunnelBinary"] = installed
	if err := saveIngressEntry(next); err != nil {
		i.mu.Unlock()
		return "", err
	}
	i.entry = next
	i.mu.Unlock()
	i.setTunnelDependency(object{"path": installed, "version": fmt.Sprintf("%d.%d.%d", version[0], version[1], version[2]),
		"state": "ready", "minimumVersion": openAITunnelMinimumVersion})
	return installed, nil
}

func installOfficialTunnel(ctx context.Context, config object) (string, error) {
	openAITunnelInstallLock.Lock()
	defer openAITunnelInstallLock.Unlock()
	if runtimeFixture {
		return "", errFixtureProviderUnavailable
	}
	parent := filepath.Join(root(), "dependencies/tunnel")
	binaryName, cloudflaredName := openAITunnelNames()
	entries, _ := os.ReadDir(parent)
	var latest [3]uint64
	var existing string
	for _, entry := range entries {
		directory := filepath.Join(parent, entry.Name())
		binary := filepath.Join(directory, binaryName)
		cloud, err := os.Stat(filepath.Join(directory, cloudflaredName))
		if err != nil || !cloud.Mode().IsRegular() {
			continue
		}
		version, err := officialTunnelVersion(ctx, binary)
		if err == nil && slices.Compare(version[:], []uint64{0, 0, 16}) >= 0 && slices.Compare(version[:], latest[:]) > 0 {
			existing, latest = binary, version
		}
	}
	if existing != "" {
		return existing, nil
	}
	tag := "v" + openAITunnelMinimumVersion
	name := "tunnel-client-" + tag + "-" + operatingSystem + "-" + runtime.GOARCH + ".zip"
	base := "https://github.com/openai/tunnel-client/releases/download/" + tag
	proxy, err := resolveNetworkProxy(ctx, config)
	if err != nil {
		return "", err
	}
	client := networkHTTPClient(proxy)
	client.CheckRedirect = nil
	defer client.CloseIdleConnections()
	checksums, err := fetchTunnelAsset(ctx, client, base+"/SHA256SUMS.txt", 1024*1024)
	if err != nil {
		return "", err
	}
	expected := ""
	for _, row := range strings.Split(string(checksums), "\n") {
		fields := strings.Fields(row)
		if len(fields) == 2 && strings.TrimLeft(fields[1], "*") == name {
			expected = strings.ToLower(fields[0])
			break
		}
	}
	if expected == "" {
		return "", errors.New("Official checksum is missing")
	}
	data, err := fetchTunnelAsset(ctx, client, base+"/"+name, 512*1024*1024)
	if err != nil {
		return "", err
	}
	if hash(data) != expected {
		return "", errors.New("SHA256 verification failed")
	}
	return publishTunnelArchive(data, parent, tag, []string{binaryName, cloudflaredName})
}

func fetchTunnelAsset(ctx context.Context, client *http.Client, source string, limit int64) ([]byte, error) {
	wait, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(wait, http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "agent-remote-control")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("HTTP %s", res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err == nil && int64(len(data)) > limit {
		return nil, errors.New("Tunnel download exceeds its byte cap")
	}
	return data, err
}

func publishTunnelArchive(data []byte, parent, tag string, names []string) (string, error) {
	bundle, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	if err := platform.PrivateDir(parent); err != nil {
		return "", err
	}
	temporary := filepath.Join(parent, ".staging-"+id())
	if err := platform.PrivateDir(temporary); err != nil {
		return "", err
	}
	defer os.RemoveAll(temporary)
	seen := map[string]bool{}
	for _, entry := range bundle.File {
		if !slices.Contains(names, entry.Name) || seen[entry.Name] || !entry.Mode().IsRegular() {
			continue
		}
		source, err := entry.Open()
		if err != nil {
			return "", err
		}
		file, err := os.OpenFile(filepath.Join(temporary, entry.Name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			source.Close()
			return "", err
		}
		_, err = io.Copy(file, source)
		if err := errors.Join(err, source.Close(), file.Close()); err != nil {
			return "", err
		}
		seen[entry.Name] = true
	}
	if len(seen) != len(names) {
		return "", errors.New("Component is incomplete")
	}
	directory := filepath.Join(parent, tag)
	if err := platform.PrivateDir(directory); err != nil {
		return "", err
	}
	for _, name := range names {
		if err := platform.ReplaceFile(filepath.Join(temporary, name), filepath.Join(directory, name)); err != nil {
			return "", err
		}
	}
	return filepath.Join(directory, names[0]), nil
}

func startOpenAITunnel(ctx context.Context, i *networkIngress, config object) error {
	configured := text(config, "tunnelBinary")
	if runtimeFixture {
		fixtures := os.Getenv("ARC_FIXTURE_DATA")
		relative, err := filepath.Rel(fixtures, configured)
		physical, physicalErr := filepath.EvalSymlinks(configured)
		fixtureRoot, rootErr := filepath.EvalSymlinks(fixtures)
		physicalRelative, physicalRelErr := filepath.Rel(fixtureRoot, physical)
		if fixtures == "" || err != nil || physicalErr != nil || rootErr != nil || physicalRelErr != nil ||
			!filepath.IsAbs(configured) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
			physicalRelative == ".." || strings.HasPrefix(physicalRelative, ".."+string(filepath.Separator)) {
			return errFixtureProviderUnavailable
		}
	}
	binary, err := i.prepareOfficialTunnel(ctx, config, false)
	if err != nil {
		return err
	}
	proxy, err := resolveNetworkProxy(ctx, config)
	if err != nil {
		return err
	}
	recordLog("INFO", proxy.message, &i.id)

	directory := filepath.Join(root(), "runs", id())
	if err := platform.PrivateDir(directory); err != nil {
		return err
	}
	started := false
	defer func() {
		if !started {
			_ = os.RemoveAll(directory)
		}
	}()
	key := filepath.Join(directory, "api-key")
	if err := saveBytes(key, []byte(text(config, "apiKey"))); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if i.owner.port == 0 {
		return errors.New("Local communication has not started")
	}
	init, cancel := context.WithTimeout(ctx, 30*time.Second)
	cmd := officialTunnelCommand(init, binary, "init", "--sample", "sample_mcp_stdio_local",
		"--profile", "arc", "--profile-dir", directory, "--control-plane-api-key-ref", "file:"+key,
		"--tunnel-id", text(config, "tunnelId"), "--health-listen-addr", "127.0.0.1:0", "--mcp-command", wire(exe)+" stdio")
	proxy.apply(cmd)
	result, err := cmd.CombinedOutput()
	deadline := init.Err()
	cancel()
	if errors.Is(deadline, context.DeadlineExceeded) {
		return errors.New("Tunnel configuration timed out")
	}
	if err != nil {
		return errors.New(i.redactNetworkError("Tunnel init failed: " + string(result)))
	}
	codex := text(config, "codexBinary")
	if ingressCodexBinary != nil {
		if installed := ingressCodexBinary(); installed != "" {
			codex = installed
		}
	}
	cmd = officialTunnelCommand(context.Background(), binary, "run", "--profile", "arc", "--profile-dir", directory,
		"--health.url-file", filepath.Join(directory, "health.url"), "--mcp.connection-max-ttl", "31m")
	proxy.apply(cmd)
	cmd.Env = append(cmd.Env, "TUNNEL_CLIENT_CODEX_APP_SERVER_CMD="+codex, "TUNNEL_CLIENT_CODEX_APP_SERVER_ARGS=app-server",
		"ARC_NATIVE_PORT="+strconv.FormatUint(i.owner.port, 10), "ARC_NATIVE_TOKEN="+i.owner.token, "ARC_INGRESS_ID="+i.id)
	cmd.Stdout, cmd.Stderr = &openAITunnelLog{ingress: i}, &openAITunnelLog{ingress: i}
	if err := startOwnedChild(cmd); err != nil {
		return err
	}
	child := &officialTunnel{cmd: cmd, directory: directory, done: make(chan struct{})}
	i.mu.Lock()
	i.officialTunnel, i.providerStop = child, child.stop
	i.mu.Unlock()
	go func() {
		_ = cmd.Wait()
		close(child.done)
		i.mu.Lock()
		defer i.mu.Unlock()
		if i.officialTunnel == child {
			i.officialTunnel, i.providerStop = nil, nil
			i.running, i.failure = false, "The connection process exited. Reconnect."
			_ = os.RemoveAll(directory)
		}
	}()
	started = true
	recordLog("INFO", "Starting connection", &i.id)
	return nil
}

func (i *networkIngress) redactNetworkError(message string) string {
	i.mu.RLock()
	entry := i.entry
	i.mu.RUnlock()
	if i.owner.token != "" {
		message = strings.ReplaceAll(message, i.owner.token, "[REDACTED]")
	}
	for _, key := range append(ingressSecretFields(), "tunnelId") {
		if value := text(entry["config"], key); value != "" {
			message = strings.ReplaceAll(message, value, "[REDACTED]")
		}
	}
	if value := text(entry, "bearerToken"); value != "" {
		message = strings.ReplaceAll(message, value, "[REDACTED]")
	}
	characters := []rune(message)
	return string(characters[:min(len(characters), 1200)])
}

type openAITunnelLog struct {
	ingress  *networkIngress
	line     []byte
	overflow bool
}

func (log *openAITunnelLog) Write(bytes []byte) (int, error) {
	for _, b := range bytes {
		if b == '\n' {
			if !log.overflow {
				log.record(log.line)
			}
			log.line, log.overflow = log.line[:0], false
		} else if len(log.line) < 65536 {
			log.line = append(log.line, b)
		} else {
			log.overflow = true
		}
	}
	return len(bytes), nil
}

func (log *openAITunnelLog) record(data []byte) {
	var entry object
	if decodeObject(data, &entry) != nil {
		return
	}
	i := log.ingress
	detail := entry["error"]
	if detail == nil {
		detail = entry["err"]
	}
	if status := openAITunnelRejectedLog(str(detail)); status != 0 {
		i.mu.Lock()
		i.providerStatus = object{"state": "rejected", "httpStatus": status}
		i.mu.Unlock()
	}
	level := strings.ToUpper(text(entry, "level"))
	if !slices.Contains([]string{"WARN", "WARNING", "ERROR", "FATAL", "PANIC"}, level) {
		return
	}
	msg := text(entry, "msg")
	if detail != nil {
		msg += ": " + wire(detail)
	}
	msg = i.redactNetworkError(msg)
	i.mu.Lock()
	i.lastError, i.lastErrorAt = msg, now()
	i.mu.Unlock()
	recordLog(level, msg, &i.id)
}

func openAITunnelHealth(snapshot any) object {
	details := field(snapshot, "details")
	status := uintOr(field(details, "http_status"), 0)
	state := "unknown"
	if status == 401 || status == 403 {
		state = "rejected"
	} else if _, ok := field(details, "last_success").(string); ok && field(snapshot, "status") == "ok" {
		state = "authenticated"
	}
	return object{"state": state, "httpStatus": status, "failureCategory": field(details, "failure_category"), "observedAt": field(snapshot, "observed_at")}
}

func openAITunnelRejectedLog(detail string) int {
	if !strings.Contains(detail, "controlplane client:") {
		return 0
	}
	for _, code := range []int{401, 403} {
		if strings.Contains(detail, "unexpected status "+strconv.Itoa(code)) {
			return code
		}
	}
	return 0
}

func (i *networkIngress) refreshOfficialTunnel() {
	i.mu.RLock()
	child := i.officialTunnel
	i.mu.RUnlock()
	if child == nil {
		return
	}
	raw, err := os.ReadFile(filepath.Join(child.directory, "health.url"))
	if err != nil {
		return
	}
	u, err := url.Parse(strings.TrimSpace(string(raw)))
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.User != nil {
		return
	}
	transport := &http.Transport{DisableKeepAlives: true, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: relayNoRedirect, Timeout: 2 * time.Second}
	origin := "http://" + u.Host
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	snapshot, _, status, err := relayHTTP(ctx, client, http.MethodGet, origin+"/health/control-plane", nil, 2*time.Second)
	if err != nil || status/100 != 2 {
		return
	}
	health := openAITunnelHealth(snapshot)
	_, _, ready, _ := relayHTTP(ctx, client, http.MethodGet, origin+"/readyz", nil, 2*time.Second)
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.officialTunnel == child {
		i.providerStatus = health
		i.running = ready/100 == 2 && health["state"] == "authenticated"
	}
}

package core

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

func cloudflareCredentials(tunnel string) string {
	return filepath.Join(root(), "cloudflare", tunnel+".json")
}

func cloudflareConfigured(config object) bool {
	tunnel := text(config, "cloudflareTunnelId")
	if tunnel == "" {
		return false
	}
	info, err := os.Stat(cloudflareCredentials(tunnel))
	return err == nil && info.Mode().IsRegular()
}

var cloudflareLoginMu sync.Mutex
var currentCloudflareLogin *cloudflareLoginProcess

type cloudflareLoginProcess struct {
	process *managedHTTPSProcess
	mu      sync.Mutex
	openURL string
}

func cloudflareOriginCertificate() string {
	return filepath.Join(root(), "cloudflare", ".cloudflared", "cert.pem")
}

func cloudflareOrigin() (object, error) {
	raw, err := os.ReadFile(cloudflareOriginCertificate())
	if err != nil {
		return nil, errors.New("Cloudflare login required")
	}
	_, encoded, found := strings.Cut(string(raw), "-----BEGIN ARGO TUNNEL TOKEN-----")
	encoded, _, _ = strings.Cut(encoded, "-----END ARGO TUNNEL TOKEN-----")
	content, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(encoded), ""))
	var value object
	if !found || err != nil || decodeObject(content, &value) != nil {
		return nil, errors.New("Cloudflare origin certificate is unreadable")
	}
	return value, nil
}

func cloudflareStatus() object {
	_, err := cloudflareOrigin()
	ready := err == nil
	cloudflareLoginMu.Lock()
	defer cloudflareLoginMu.Unlock()
	if current := currentCloudflareLogin; current != nil {
		if ready {
			current.process.stop()
			currentCloudflareLogin = nil
		} else {
			select {
			case <-current.process.done:
				currentCloudflareLogin = nil
			default:
				current.mu.Lock()
				defer current.mu.Unlock()
				var address any
				if current.openURL != "" {
					address = current.openURL
				}
				return object{"hasOriginCert": false, "running": true, "openUrl": address}
			}
		}
	}
	return object{"hasOriginCert": ready, "running": false, "openUrl": nil}
}

func stopCloudflareLogin() {
	cloudflareLoginMu.Lock()
	defer cloudflareLoginMu.Unlock()
	if current := currentCloudflareLogin; current != nil {
		current.process.stop()
		currentCloudflareLogin = nil
	}
}

func cloudflareCommand(ctx context.Context, settings object, args ...string) (*exec.Cmd, error) {
	directory := filepath.Join(root(), "cloudflare")
	if err := platform.PrivateDir(directory); err != nil {
		return nil, err
	}
	proxy, err := resolveNetworkProxy(ctx, settings)
	if err != nil {
		return nil, err
	}
	binary, err := installManagedTunnel(ctx, "cloudflare", proxy)
	if err != nil {
		return nil, err
	}
	config := filepath.Join(directory, "empty.json")
	if err := save(config, object{}); err != nil {
		return nil, err
	}
	cmd := providerCommand(ctx, binary, proxy, append([]string{"tunnel", "--no-autoupdate", "--config", config}, args...)...)
	cmd.Env = append(cmd.Env, "HOME="+directory, "USERPROFILE="+directory, "TUNNEL_ORIGIN_CERT="+cloudflareOriginCertificate())
	return cmd, nil
}

type cloudflareLoginOutput struct {
	login *cloudflareLoginProcess
	line  []byte
}

func (out *cloudflareLoginOutput) Write(data []byte) (int, error) {
	for _, b := range data {
		if b == '\n' {
			for _, word := range strings.Fields(string(out.line)) {
				if strings.HasPrefix(word, "https://dash.cloudflare.com/argotunnel?") {
					out.login.mu.Lock()
					out.login.openURL = word
					out.login.mu.Unlock()
				}
			}
			out.line = out.line[:0]
		} else if len(out.line) < 65536 {
			out.line = append(out.line, b)
		}
	}
	return len(data), nil
}

func cloudflareLogin(ctx context.Context, settings object) error {
	state := cloudflareStatus()
	if state["hasOriginCert"] == true || state["running"] == true {
		return nil
	}
	if runtimeFixture {
		return errFixtureProviderUnavailable
	}
	cloudflareLoginMu.Lock()
	if currentCloudflareLogin != nil {
		cloudflareLoginMu.Unlock()
		return nil
	}
	cmd, err := cloudflareCommand(context.Background(), settings, "login")
	if err != nil {
		cloudflareLoginMu.Unlock()
		return err
	}
	login := &cloudflareLoginProcess{}
	cmd.Stderr = &cloudflareLoginOutput{login: login}
	if err := startOwnedChild(cmd); err != nil {
		cloudflareLoginMu.Unlock()
		return err
	}
	login.process = &managedHTTPSProcess{cmd: cmd, done: make(chan struct{})}
	currentCloudflareLogin = login
	cloudflareLoginMu.Unlock()
	go func() { _ = cmd.Wait(); close(login.process.done) }()
	for range 30 {
		state = cloudflareStatus()
		if state["openUrl"] != nil || state["running"] != true {
			break
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	state = cloudflareStatus()
	if state["running"] != true && state["hasOriginCert"] != true {
		return errors.New("Cloudflare login ended before authorization completed; apply again to retry")
	}
	return nil
}

func cloudflareAPI(ctx context.Context, settings, cert object, path string) (any, error) {
	if runtimeFixture {
		value, err := load(filepath.Join(root(), "fixtures/cloudflare-api.json"))
		if err != nil || field(value, path) == nil {
			return nil, errors.New("Cloudflare API fixture missing")
		}
		return field(value, path), nil
	}
	proxy, err := resolveNetworkProxy(ctx, settings)
	if err != nil {
		return nil, err
	}
	client := networkHTTPClient(proxy)
	defer client.CloseIdleConnections()
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(wait, http.MethodGet, "https://api.cloudflare.com/client/v4/"+path, nil)
	if err != nil {
		return nil, errors.New("Cloudflare API request failed")
	}
	request.Header.Set("Authorization", "Bearer "+text(cert, "apiToken"))
	res, err := client.Do(request)
	if err != nil {
		return nil, errors.New("Cloudflare API request failed")
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	var value object
	if err != nil || decodeObject(data, &value) != nil {
		return nil, errors.New("Cloudflare API response unreadable")
	}
	if res.StatusCode/100 != 2 || value["success"] != true {
		return nil, fmt.Errorf("Cloudflare API request failed (%s)", res.Status)
	}
	return value["result"], nil
}

func cloudflareRun(ctx context.Context, settings object, args ...string) ([]byte, error) {
	if runtimeFixture {
		return nil, errFixtureProviderUnavailable
	}
	wait, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd, err := cloudflareCommand(wait, settings, args...)
	if err != nil {
		return nil, err
	}
	out, err := cmd.Output()
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return nil, errors.New("Cloudflare command timed out")
	}
	if err != nil && cmd.ProcessState != nil {
		return nil, fmt.Errorf("Cloudflare %s failed (%s)", args[0], cmd.ProcessState)
	}
	return out, err
}

func cloudflareHostLabel() string {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "computer"
	}
	label, _, _ := strings.Cut(hostname, ".")
	label = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return '-'
	}, strings.ToLower(label))
	label = strings.Trim(label[:min(len(label), 24)], "-")
	if label == "" {
		label = "computer"
	}
	return "arc-" + label
}

var cloudflareProvisionLock sync.Mutex

func cloudflareProvision(ctx context.Context, settings object) (object, error) {
	cloudflareProvisionLock.Lock()
	defer cloudflareProvisionLock.Unlock()
	cert, err := cloudflareOrigin()
	if err != nil {
		return nil, err
	}
	zoneID := text(cert, "zoneID")
	zone, err := cloudflareAPI(ctx, settings, cert, "zones/"+zoneID)
	if err != nil {
		return nil, err
	}
	zoneName, ok := field(zone, "name").(string)
	if !ok {
		return nil, errors.New("Cloudflare zone name missing")
	}
	name := cloudflareHostLabel()
	data, err := cloudflareRun(ctx, settings, "list", "--output", "json")
	if err != nil {
		return nil, err
	}
	var rows []any
	if unmarshalJSON(data, &rows) != nil || rows == nil {
		return nil, errors.New("Cloudflare tunnel list unreadable")
	}
	requested := text(settings, "cloudflareTunnelId")
	var existing object
	if requested != "" {
		existing = find(rows, "id", requested)
	}
	if existing == nil {
		existing = find(rows, "name", name)
	}
	if existing == nil {
		records, err := cloudflareAPI(ctx, settings, cert, "zones/"+zoneID+"/dns_records?type=CNAME&name="+name+"."+zoneName)
		if err != nil {
			return nil, err
		}
		for _, row := range arr(records) {
			tunnel, ok := strings.CutSuffix(text(row, "content"), ".cfargotunnel.com")
			if _, err := uuid.Parse(tunnel); !ok || err != nil {
				continue
			}
			if info, err := os.Stat(cloudflareCredentials(tunnel)); err == nil && info.Mode().IsRegular() {
				existing = find(rows, "id", tunnel)
				break
			}
		}
	}
	var tunnel string
	if existing != nil {
		tunnel = text(existing, "id")
		path := "accounts/" + text(cert, "accountID") + "/cfd_tunnel/"
		detail, err := cloudflareAPI(ctx, settings, cert, path+tunnel)
		if err != nil {
			return nil, err
		}
		if field(detail, "config_src") == "cloudflare" {
			name += "-local"
			tunnel = text(find(rows, "name", name), "id")
			if tunnel != "" {
				sibling, err := cloudflareAPI(ctx, settings, cert, path+tunnel)
				if err != nil {
					return nil, err
				}
				if field(sibling, "config_src") == "cloudflare" {
					return nil, errors.New("Cloudflare setup tunnel name is already used by a dashboard-managed tunnel")
				}
			}
		}
	}
	hostname := name + "." + zoneName
	if tunnel != "" && tunnel == requested {
		if parsed, err := url.Parse(text(settings, "httpsUrl")); err == nil && strings.HasSuffix(parsed.Hostname(), "."+zoneName) {
			hostname = parsed.Hostname()
		}
	}
	if tunnel != "" {
		if _, err := uuid.Parse(tunnel); err != nil {
			return nil, errors.New("Cloudflare tunnel ID missing")
		}
		file := cloudflareCredentials(tunnel)
		if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
			if _, err := cloudflareRun(ctx, settings, "token", "--cred-file", file, tunnel); err != nil {
				return nil, err
			}
		}
	} else {
		pending := filepath.Join(root(), "cloudflare", "created.json")
		if err := os.Remove(pending); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if _, err := cloudflareRun(ctx, settings, "create", "--credentials-file", pending, name); err != nil {
			return nil, err
		}
		record, err := load(pending)
		if err != nil {
			return nil, err
		}
		tunnel = text(record, "TunnelID")
		if _, err := uuid.Parse(tunnel); err != nil {
			return nil, errors.New("Cloudflare tunnel ID missing")
		}
		if err := platform.ReplaceFile(pending, cloudflareCredentials(tunnel)); err != nil {
			return nil, err
		}
	}
	if _, err := cloudflareRun(ctx, settings, "route", "dns", tunnel, hostname); err != nil {
		return nil, err
	}
	return object{"httpsProvider": "cloudflare", "cloudflareMode": "named", "cloudflareAuth": "login", "cloudflareTunnelId": tunnel, "httpsUrl": "https://" + hostname + "/mcp"}, nil
}

func init() {
	setupCloudflareStatus = func(context.Context) object { return cloudflareStatus() }
	setupCloudflareLogin = cloudflareLogin
	setupCloudflareProvision = cloudflareProvision
	setupCloudflareStop = stopCloudflareLogin
	registerServiceStartup(func(_ context.Context, s *service) error {
		s.cleanup = append(s.cleanup, stopCloudflareLogin)
		return nil
	})
}

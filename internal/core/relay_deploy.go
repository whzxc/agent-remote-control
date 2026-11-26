package core

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/internal/platform"
	relayworker "github.com/whzxc/agent-remote-control/relay-worker"
)

const relayNodeVersion = "v24.12.0"
const relayWranglerVersion = "4.151.3"
const relayWranglerLoginRequired = "WRANGLER_LOGIN_REQUIRED"

func relayDeploymentWorkspace(config object) (string, error) {
	dir, err := relayDirectory(text(config, "id"))
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "deployment"), nil
}

func relayLoginURL(line string) string {
	for _, word := range strings.Fields(line) {
		u, err := url.Parse(word)
		if err == nil && u.Scheme == "https" && u.Hostname() == "dash.cloudflare.com" && u.Path == "/oauth2/auth" {
			return u.String()
		}
	}
	return ""
}

func relayOpenLogin(ctx context.Context, link string) {
	wait, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	switch runtime.GOOS {
	case "darwin":
		_ = nativeCommand(wait, "/usr/bin/open", link).Run()
	case "windows":
		_ = nativeCommand(wait, "rundll32.exe", "url.dll,FileProtocolHandler", link).Run()
	default:
		_ = nativeCommand(wait, "xdg-open", link).Run()
	}
}

func relayRunTool(ctx context.Context, cmd *exec.Cmd, job *relayJob, login, openBrowser bool) (string, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	defer writer.Close()
	cmd.Stdout, cmd.Stderr = writer, writer
	platform.OwnChild(cmd)
	if err := startOwnedChild(cmd); err != nil {
		return "", errors.New("Cannot start the managed deployment tool; check filesystem permissions and system tar availability.")
	}
	writer.Close()
	pid := cmd.Process.Pid
	exit := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		platform.KillOwnedGroup(pid)
		exit <- err
	}()
	quit := make(chan struct{})
	defer close(quit)
	type toolLine struct {
		text string
		err  error
	}
	lines := make(chan toolLine)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), 256*1024)
		for scanner.Scan() {
			select {
			case lines <- toolLine{text: scanner.Text()}:
			case <-quit:
				return
			}
		}
		if err := scanner.Err(); err != nil {
			select {
			case lines <- toolLine{err: err}:
			case <-quit:
			}
		}
	}()
	deadline := time.NewTimer(300 * time.Second)
	defer deadline.Stop()
	var linkDeadline <-chan time.Time
	if login {
		timer := time.NewTimer(30 * time.Second)
		defer timer.Stop()
		linkDeadline = timer.C
	}
	defer func() {
		if exit != nil {
			platform.SignalTree(pid, true)
			_ = cmd.Process.Kill()
			<-exit
		}
	}()
	var output strings.Builder
	var exitErr error
	var drainDeadline <-chan time.Time
	for exit != nil || lines != nil {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-deadline.C:
			if login {
				return "", errors.New("Cloudflare login timed out after 5 minutes; retry and complete authorization in the browser")
			}
			return "", errors.New("Deployment step timed out; check network and Cloudflare account access")
		case <-linkDeadline:
			return "", errors.New("Wrangler did not provide a Cloudflare login link within 30 seconds; check proxy and retry")
		case <-drainDeadline:
			_ = reader.Close()
			lines = nil
		case exitErr = <-exit:
			exit = nil
			linkDeadline = nil
			timer := time.NewTimer(time.Second)
			defer timer.Stop()
			drainDeadline = timer.C
		case line, ok := <-lines:
			if !ok {
				lines = nil
				continue
			}
			if line.err != nil {
				return "", errors.New("Cannot read deployment stdout")
			}
			if login {
				if link := relayLoginURL(line.text); link != "" {
					first := job.snapshot()["loginUrl"] == nil
					job.update(object{"loginUrl": link})
					linkDeadline = nil
					if first && openBrowser {
						relayOpenLogin(ctx, link)
					}
				}
			}
			if output.Len() < 256*1024 {
				output.WriteString(line.text)
				output.WriteByte('\n')
			}
		}
	}
	if exitErr == nil {
		return output.String(), nil
	}
	var result object
	if canonjson.Unmarshal([]byte(output.String()), &result) == nil && result["loggedIn"] == false {
		return "", errors.New(relayWranglerLoginRequired)
	}
	out := output.String()
	reason := "Check the managed deployment tools, Cloudflare authorization and Worker deployment permissions"
	switch {
	case login && (strings.Contains(out, "EADDRINUSE") || strings.Contains(out, "port is already in use")):
		reason = "Cloudflare login callback port is already in use; close the other Wrangler login and retry"
	case strings.Contains(out, "account"):
		reason = "Check Cloudflare account selection and Workers permissions"
	case strings.Contains(out, "ENOTFOUND") || strings.Contains(out, "fetch failed") || strings.Contains(out, "ECONN"):
		reason = "Cannot reach Cloudflare; check the system or HTTPS_PROXY proxy"
	}
	return "", fmt.Errorf("Deployment tool exited with %s. %s.", exitErr, reason)
}

func relayNodeDirectory() string {
	return filepath.Join(root(), "dependencies", "relay-deploy-node", relayNodeVersion)
}

func relayNodeBinary() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(relayNodeDirectory(), "node.exe")
	}
	return filepath.Join(relayNodeDirectory(), "bin", "node")
}

func relayDeploymentCommand(ctx context.Context, binary string, args ...string) *exec.Cmd {
	cmd := nativeCommand(ctx, binary, args...)
	config, err := load(filepath.Join(root(), "app/preferences.json"))
	if err != nil {
		config = ingressDefaults()
	}
	mode, address := text(config, "proxyMode"), text(config, "proxyUrl")
	bypass := strings.Trim(strings.Join([]string{os.Getenv("NO_PROXY"), os.Getenv("no_proxy"), "localhost,127.0.0.1,::1"}, ","), ",")
	for _, item := range os.Environ() {
		name, _, _ := strings.Cut(item, "=")
		switch strings.ToUpper(name) {
		case "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "NO_PROXY":
			continue
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY":
			if mode != "system" {
				continue
			}
		}
		cmd.Env = append(cmd.Env, item)
	}
	cmd.Env = append(cmd.Env, "NO_PROXY="+bypass, "no_proxy="+bypass)
	if mode == "custom" {
		for _, name := range []string{"HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"} {
			cmd.Env = append(cmd.Env, name+"="+address)
		}
	}
	if binary == relayNodeBinary() {
		path := strings.Join(append([]string{filepath.Dir(binary)}, filepath.SplitList(os.Getenv("PATH"))...), string(os.PathListSeparator))
		cmd.Env = append(cmd.Env, "PATH="+path)
	}
	return cmd
}

func relayEnsureNode(ctx context.Context, job *relayJob) error {
	dir := relayNodeDirectory()
	if _, err := os.Stat(filepath.Join(dir, "ready")); err == nil {
		return nil
	}
	platformName, extension, tar := runtime.GOOS, "tar.gz", "tar"
	if runtime.GOOS == "windows" {
		platformName, extension, tar = "win", "zip", "tar.exe"
	}
	arch := "x64"
	if runtime.GOARCH == "arm64" {
		arch = "arm64"
	}
	name := fmt.Sprintf("node-%s-%s-%s.%s", relayNodeVersion, platformName, arch, extension)
	client, err := configuredRelayHTTP()
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	client.Timeout = 180 * time.Second
	client.CheckRedirect = nil
	base := "https://nodejs.org/dist/" + relayNodeVersion + "/"
	sums, err := fetchTunnelAsset(ctx, client, base+"SHASUMS256.txt", 512*1024)
	if err != nil {
		return errors.New("Cannot download Node.js checksums; check proxy")
	}
	expected := ""
	for _, line := range strings.Split(string(sums), "\n") {
		if fields := strings.Fields(line); len(fields) >= 2 && fields[1] == name {
			expected = fields[0]
			break
		}
	}
	if expected == "" {
		return errors.New("Node.js package checksum missing")
	}
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+name, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(req)
	if err != nil {
		return errors.New("Cannot download deployment runtime; check proxy")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("Deployment runtime package unavailable")
	}
	archive := filepath.Join(dir, "download."+extension)
	file, err := os.OpenFile(archive, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(archive)
	const maxSize = 120 * 1024 * 1024
	digest := sha256.New()
	n, err := io.Copy(io.MultiWriter(file, digest), io.LimitReader(response.Body, maxSize+1))
	if err := errors.Join(err, file.Close()); err != nil {
		return errors.New("Deployment runtime download interrupted")
	}
	if n > maxSize {
		return errors.New("Deployment runtime download exceeded limit")
	}
	if hex.EncodeToString(digest.Sum(nil)) != expected {
		return errors.New("Deployment runtime SHA256 mismatch")
	}
	if _, err := relayRunTool(ctx, relayDeploymentCommand(ctx, tar, "-xf", archive, "--strip-components=1", "-C", dir), job, false, false); err != nil {
		return err
	}
	if info, err := os.Stat(relayNodeBinary()); err != nil || !info.Mode().IsRegular() {
		return errors.New("Deployment runtime extraction failed")
	}
	return saveBytes(filepath.Join(dir, "ready"), []byte(relayNodeVersion))
}

func relayPrepareDeployment(ctx context.Context, config object, job *relayJob) (string, string, error) {
	if err := relayEnsureNode(ctx, job); err != nil {
		return "", "", err
	}
	install := filepath.Join(root(), "dependencies", "wrangler", relayWranglerVersion)
	script := filepath.Join(install, "node_modules", "wrangler", "bin", "wrangler.js")
	marker := filepath.Join(install, "ready")
	if _, err := os.Stat(marker); err != nil {
		if err := platform.PrivateDir(install); err != nil {
			return "", "", err
		}
		npm := filepath.Join(relayNodeDirectory(), "node_modules", "npm", "bin", "npm-cli.js")
		if runtime.GOOS != "windows" {
			npm = filepath.Join(relayNodeDirectory(), "lib", "node_modules", "npm", "bin", "npm-cli.js")
		}
		if _, err := relayRunTool(ctx, relayDeploymentCommand(ctx, relayNodeBinary(), npm, "install", "--prefix", install, "--no-audit",
			"--no-fund", "--save-exact", "wrangler@"+relayWranglerVersion), job, false, false); err != nil {
			return "", "", err
		}
		if err := saveBytes(marker, []byte(relayWranglerVersion)); err != nil {
			return "", "", err
		}
	}
	dir, err := relayDeploymentWorkspace(config)
	if err != nil {
		return "", "", err
	}
	var wrangler object
	if err := canonjson.Unmarshal(relayworker.Config, &wrangler); err != nil {
		return "", "", err
	}
	wrangler["name"], wrangler["main"] = config["workerName"], "worker.ts"
	obj(wrangler["vars"])["ARC_VERSION"] = buildVersion
	if account, ok := config["accountId"]; ok {
		wrangler["account_id"] = account
	}
	if err := saveBytes(filepath.Join(dir, "worker.ts"), relayworker.Source); err != nil {
		return "", "", err
	}
	return script, dir, save(filepath.Join(dir, "wrangler.json"), wrangler)
}

func relayWrangler(ctx context.Context, script, dir string, job *relayJob, openBrowser bool, args ...string) (string, error) {
	cmd := relayDeploymentCommand(ctx, relayNodeBinary(), append([]string{script}, args...)...)
	cmd.Env = append(cmd.Env, "WRANGLER_SEND_METRICS=false", "NO_COLOR=1", "CI=true")
	cmd.Dir = dir
	return relayRunTool(ctx, cmd, job, args[0] == "login", openBrowser)
}

func relayWranglerToken(ctx context.Context, script, dir string, job *relayJob) (string, error) {
	out, err := relayWrangler(ctx, script, dir, job, false, "auth", "token", "--json")
	if err != nil {
		return "", err
	}
	var credentials object
	if canonjson.Unmarshal([]byte(out), &credentials) != nil {
		return "", errors.New("Cannot obtain Wrangler OAuth authorization")
	}
	if credentials["type"] != "oauth" {
		return "", errors.New("Wrangler browser OAuth authorization is required")
	}
	return text(credentials, "token"), nil
}

func relayWorkerAPI(ctx context.Context, method, path, token string, body object) (int, object, error) {
	client, err := configuredRelayHTTP()
	if err != nil {
		return 0, nil, err
	}
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var input io.Reader
	if body != nil {
		input = strings.NewReader(wire(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://api.cloudflare.com/client/v4/accounts/"+path, input)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxFrameBytes+1))
	var output object
	if err != nil {
		return res.StatusCode, nil, err
	}
	if len(data) > maxFrameBytes || canonjson.Unmarshal(data, &output) != nil {
		return res.StatusCode, nil, errors.New("Invalid Cloudflare response")
	}
	return res.StatusCode, output, nil
}

func relayEnsureSubdomain(ctx context.Context, script, dir, account, relayID string, job *relayJob) (string, error) {
	token, err := relayWranglerToken(ctx, script, dir, job)
	if err != nil {
		return "", err
	}
	path := url.PathEscape(account) + "/workers/subdomain"
	status, result, err := relayWorkerAPI(ctx, http.MethodGet, path, token, nil)
	if err != nil {
		if status == 0 {
			return "", errors.New("Cannot read workers.dev registration; check proxy")
		}
		return "", errors.New("Invalid workers.dev response")
	}
	if result["success"] != true {
		if !slices.ContainsFunc(arr(result["errors"]), func(item any) bool { return uintOr(field(item, "code"), 0) == 10007 }) {
			return "", errors.New("Cannot read workers.dev registration; check Workers account permissions")
		}
		status, result, err = relayWorkerAPI(ctx, http.MethodPut, path, token, object{"subdomain": "arc-" + strings.ReplaceAll(relayID, "-", "")})
		if err != nil {
			if status == 0 {
				return "", errors.New("workers.dev registration interrupted; retry deployment")
			}
			return "", errors.New("Invalid workers.dev registration response")
		}
		if result["success"] != true {
			return "", errors.New("Could not register a workers.dev subdomain; complete Workers onboarding in Cloudflare and redeploy")
		}
	}
	if subdomain, ok := field(result["result"], "subdomain").(string); ok {
		return subdomain, nil
	}
	return "", errors.New("No workers.dev subdomain returned")
}

func relayCheckAccount(ctx context.Context, script, dir string, job *relayJob) (string, error) {
	job.update(object{"loginStage": "checking", "loginUrl": nil})
	wait, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	who, err := relayWrangler(wait, script, dir, job, false, "whoami", "--json")
	if errors.Is(err, context.DeadlineExceeded) {
		return "", errors.New("Cloudflare account check timed out after 30 seconds; check network and proxy")
	}
	return who, err
}

var relayWorkerAddress = regexp.MustCompile(`https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev`)

func relayDeployedAddress(output, worker string) string {
	for _, address := range relayWorkerAddress.FindAllString(output, -1) {
		if strings.HasPrefix(address, "https://"+worker+".") {
			return address
		}
	}
	return ""
}

func relayDeployWorker(ctx context.Context, config object, publicKey string, job *relayJob, openBrowser bool) (string, error) {
	wait, cancel := context.WithTimeout(ctx, 300*time.Second)
	script, dir, err := relayPrepareDeployment(wait, config, job)
	timedOut := errors.Is(wait.Err(), context.DeadlineExceeded)
	cancel()
	if timedOut {
		return "", errors.New("Relay tool setup timed out after 5 minutes; check access to Node.js and npm")
	}
	if err != nil {
		return "", err
	}
	who, err := relayCheckAccount(ctx, script, dir, job)
	if err != nil && err.Error() == relayWranglerLoginRequired {
		job.update(object{"loginStage": "authorizing"})
		if _, err = relayWrangler(ctx, script, dir, job, openBrowser, "login", "--browser=false"); err != nil {
			return "", err
		}
		who, err = relayCheckAccount(ctx, script, dir, job)
	}
	if err != nil {
		return "", err
	}
	var identity object
	if canonjson.Unmarshal([]byte(who), &identity) != nil {
		return "", errors.New("Cannot read Wrangler account information")
	}
	accounts, ok := identity["accounts"].([]any)
	if !ok {
		return "", errors.New("No Cloudflare account available")
	}
	account, selected := config["accountId"].(string)
	if selected {
		if !slices.ContainsFunc(accounts, func(item any) bool { return text(item, "id") == account }) {
			return "", errors.New("Selected Cloudflare account is unavailable")
		}
	} else if len(accounts) == 1 {
		account = text(accounts[0], "id")
	} else {
		job.update(object{"accounts": accounts})
		return "", errors.New("Select a Cloudflare accountId and call relay.redeploy")
	}
	job.update(object{"phase": "deploying", "loginStage": nil})
	subdomain, err := relayEnsureSubdomain(ctx, script, dir, account, text(config, "id"), job)
	if err != nil {
		return "", err
	}
	settingsPath := filepath.Join(dir, "wrangler.json")
	settings, err := load(settingsPath)
	if err != nil {
		return "", err
	}
	obj(settings)["account_id"] = account
	if err := save(settingsPath, settings); err != nil {
		return "", err
	}
	saved, err := readRelay(text(config, "id"))
	if err != nil {
		return "", err
	}
	saved["accountId"], saved["deploymentStarted"] = account, true
	if err := saveRelay(saved); err != nil {
		return "", err
	}
	if err := save(filepath.Join(dir, "worker-secrets.json"), object{"MANAGEMENT_PUBLIC_KEY": publicKey}); err != nil {
		return "", err
	}
	out, err := relayWrangler(ctx, script, dir, job, false, "deploy", "--secrets-file", "worker-secrets.json")
	if err != nil {
		return "", err
	}
	worker := text(config, "workerName")
	if address := relayDeployedAddress(out, worker); address != "" {
		return address, nil
	}
	return relayOrigin("https://" + worker + "." + subdomain + ".workers.dev")
}

func relayWorkerMissingFromResponse(status int, response object) (bool, error) {
	if status >= 200 && status < 300 && response["success"] == true {
		return false, nil
	}
	items := arr(response["errors"])
	if status == http.StatusNotFound && response["success"] == false && len(items) == 1 && uintOr(field(items[0], "code"), 0) == 10007 {
		return true, nil
	}
	return false, fmt.Errorf("Cloudflare Worker lookup failed (HTTP %d %s); check Workers account permissions", status, http.StatusText(status))
}

func relayCheckWorkerMissing(ctx context.Context, script, dir string, config object, job *relayJob) (bool, error) {
	account, worker := text(config, "accountId"), text(config, "workerName")
	if account == "" || worker == "" {
		return false, errors.New("Cannot verify Worker removal without its Cloudflare account and name")
	}
	token, err := relayWranglerToken(ctx, script, dir, job)
	if err != nil {
		return false, err
	}
	status, result, err := relayWorkerAPI(ctx, http.MethodGet, url.PathEscape(account)+"/workers/scripts/"+url.PathEscape(worker)+"/settings", token, nil)
	if err != nil {
		if status == 0 {
			return false, errors.New("Cannot verify Worker removal; check Cloudflare connectivity")
		}
		return false, fmt.Errorf("Cannot verify Worker removal; invalid Cloudflare response (HTTP %d %s)", status, http.StatusText(status))
	}
	return relayWorkerMissingFromResponse(status, result)
}

func relayWorkerAccountMissing(ctx context.Context, config object, job *relayJob) (bool, error) {
	script, dir, err := relayPrepareDeployment(ctx, config, job)
	if err != nil {
		return false, err
	}
	return relayCheckWorkerMissing(ctx, script, dir, config, job)
}

func relayDeleteWorker(ctx context.Context, config object, job *relayJob) error {
	script, dir, err := relayPrepareDeployment(ctx, config, job)
	if err != nil {
		return err
	}
	if _, err := relayWrangler(ctx, script, dir, job, false, "delete", "--force"); err != nil {
		if missing, checkErr := relayCheckWorkerMissing(ctx, script, dir, config, job); checkErr != nil || !missing {
			return err
		}
	}
	return nil
}

package core

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

const claudeOpenedURL = "ARC_CLAUDE_LOGIN_URL_FILE"

type claudeAccount struct {
	ID         string  `json:"id"`
	Identity   object  `json:"identity"`
	ObservedAt *string `json:"observedAt"`
	Imported   bool    `json:"imported"`
}

func claudeAccountsDir() string { return filepath.Join(root(), "claude-accounts") }

func claudeAccountDir(id string) (string, error) {
	if _, err := uuid.Parse(id); err != nil {
		return "", errors.New("INVALID_CLAUDE_ACCOUNT: Select an account from accounts.list")
	}
	return filepath.Join(claudeAccountsDir(), id), nil
}

func readClaudeAccount(id string) (claudeAccount, error) {
	var account claudeAccount
	dir, err := claudeAccountDir(id)
	if err != nil {
		return account, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "account.json"))
	if err != nil {
		return account, err
	}
	if canonjson.Unmarshal(data, &account) != nil || account.ID == "" {
		return account, errors.New("INVALID_CLAUDE_ACCOUNT: Could not read this account")
	}
	if account.ID != id {
		return account, errors.New("INVALID_CLAUDE_ACCOUNT: Account identity mismatch")
	}
	return account, nil
}

func saveClaudeAccount(account claudeAccount) error {
	dir, err := claudeAccountDir(account.ID)
	if err != nil {
		return err
	}
	return save(filepath.Join(dir, "account.json"), object{"id": account.ID, "identity": account.Identity, "observedAt": account.ObservedAt, "imported": account.Imported})
}

func listClaudeAccounts() ([]claudeAccount, error) {
	accounts := []claudeAccount{}
	rows, err := os.ReadDir(claudeAccountsDir())
	if errors.Is(err, os.ErrNotExist) {
		return accounts, nil
	}
	if err != nil {
		return nil, err
	}
	for _, entry := range rows {
		name := entry.Name()
		dir, err := claudeAccountDir(name)
		if err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, "account.json")); err != nil {
			continue
		}
		account, err := readClaudeAccount(name)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	return accounts, nil
}

func claudeAccountObservations() ([]any, error) {
	accounts, err := listClaudeAccounts()
	if err != nil {
		return nil, err
	}
	rows := make([]any, 0, len(accounts))
	for _, account := range accounts {
		var at any
		if account.ObservedAt != nil {
			at = *account.ObservedAt
		}
		rows = append(rows, object{"profileId": account.ID, "identity": account.Identity, "observedAt": at})
	}
	return rows, nil
}

func claudeAccountProfiles() ([]object, error) {
	rows, err := readAccounts()
	if err != nil {
		return nil, err
	}
	accounts, err := listClaudeAccounts()
	if err != nil {
		return nil, err
	}
	result := []object{}
	for _, account := range accounts {
		if ownerOfAccountProfile(rows, account.ID) != nil {
			result = append(result, object{"accountId": account.ID, "identity": safeClaudeIdentity(account.Identity)})
		}
	}
	return result, nil
}

func claudeProfileConfig(id string) (string, error) {
	if _, err := readClaudeAccount(id); err != nil {
		return "", errors.New("CLAUDE_ACCOUNT_NOT_FOUND: The assigned profile is missing or unreadable. Select an existing accountId with notify_control action:route for this source-owned target, or edit the host assignment in Accounts; ARC will not use another account automatically")
	}
	dir, _ := claudeAccountDir(id)
	return filepath.Join(dir, "config"), nil
}

func nativeClaudeTranscriptRoots() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	native := os.Getenv("CLAUDE_CONFIG_DIR")
	if native != "" {
		parent := filepath.Dir(native)
		_, err := uuid.Parse(filepath.Base(parent))
		if filepath.Base(native) == "config" && err == nil && filepath.Base(filepath.Dir(parent)) == "claude-accounts" {
			native = ""
		}
	}
	if native == "" {
		native = filepath.Join(home, ".claude")
	}
	return []string{filepath.Join(native, "projects")}
}

func isolatedClaudeEnvironment(env []string, config string) []string {
	blocked := []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
		"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY",
		"CLAUDE_CODE_HOST_CREDS_FILE", "BROWSER", claudeOpenedURL}
	result := make([]string, 0, len(env)+1)
	host := []string{}
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		key = strings.ToUpper(key)
		if config == "" && (key == "CLAUDE_CONFIG_DIR" || key == "CLAUDE_SECURESTORAGE_CONFIG_DIR") {
			host = append(host, entry)
		}
		if !slices.Contains(blocked, key) {
			result = append(result, entry)
		}
	}
	if config != "" {
		return append(result, "CLAUDE_CONFIG_DIR="+config)
	}
	return append(result, host...)
}

// Segment A supplies the existing Agent discovery and command proxy policy.
var accountAgentSearchPaths func() []string
var accountAgentBinary func(string) string
var applyAccountCommandProxy func(context.Context, *exec.Cmd) error

func findAccountAgent(name string) string {
	if accountAgentBinary != nil {
		return accountAgentBinary(name)
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	return path
}

func claudeProfileCommand(ctx context.Context, config string, args ...string) (*exec.Cmd, error) {
	binary := findAccountAgent("claude")
	if binary == "" {
		return nil, errors.New("CLAUDE_NOT_FOUND: Install Claude Code before signing in")
	}
	cmd := nativeCommand(ctx, binary, args...)
	cmd.Env = isolatedClaudeEnvironment(os.Environ(), config)
	if accountAgentSearchPaths != nil {
		cmd.Env = append(cmd.Env, "PATH="+strings.Join(accountAgentSearchPaths(), string(os.PathListSeparator)))
	}
	if config != "" {
		cmd.Dir = config
	}
	if applyAccountCommandProxy != nil {
		if err := applyAccountCommandProxy(ctx, cmd); err != nil {
			return nil, err
		}
	}
	return cmd, nil
}

func claudeAccountCommand(ctx context.Context, id string, args ...string) (*exec.Cmd, error) {
	config, err := claudeProfileConfig(id)
	if err != nil {
		return nil, err
	}
	return claudeProfileCommand(ctx, config, args...)
}

func safeClaudeIdentity(value any) object {
	result := object{}
	if logged, ok := field(value, "loggedIn").(bool); ok {
		result["loggedIn"] = logged
	}
	for _, key := range []string{"authMethod", "email", "accountId", "orgId", "orgName", "subscriptionType"} {
		if v, ok := field(value, key).(string); ok {
			runes := []rune(v)
			result[key] = string(runes[:min(len(runes), 320)])
		}
	}
	return result
}

func readClaudeIdentity(ctx context.Context, config string) (object, error) {
	wait, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd, err := claudeProfileCommand(wait, config, "auth", "status", "--json")
	if err != nil {
		return nil, err
	}
	data, err := cmd.Output()
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return nil, errors.New("CLAUDE_STATUS_TIMEOUT: Retry checking this account")
	}
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return nil, errors.New("CLAUDE_STATUS_FAILED: Could not run Claude Code")
	}
	var value any
	if canonjson.Unmarshal(data, &value) != nil {
		return nil, errors.New("CLAUDE_STATUS_FAILED: Claude Code returned no authentication status; check its installation")
	}
	if _, ok := field(value, "loggedIn").(bool); !ok {
		return nil, errors.New("CLAUDE_STATUS_FAILED: Claude Code returned an unsupported status")
	}
	return safeClaudeIdentity(value), nil
}

func claudeAccountIdentity(ctx context.Context, id string) (object, error) {
	config, err := claudeProfileConfig(id)
	if err != nil {
		return nil, err
	}
	return readClaudeIdentity(ctx, config)
}

func refreshClaudeAccount(ctx context.Context, id string) (object, error) {
	account, err := readClaudeAccount(id)
	if err != nil {
		return nil, err
	}
	identity, statusErr := claudeAccountIdentity(ctx, id)
	if statusErr != nil {
		if account.Identity == nil {
			account.Identity = object{}
		}
		account.Identity["statusError"] = statusErr.Error()
	} else {
		account.Identity = identity
	}
	at := now()
	account.ObservedAt = &at
	if err := saveClaudeAccount(account); err != nil {
		return nil, err
	}
	return account.Identity, statusErr
}

func claudeAuthorizationURL(raw string) string {
	value, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || value.Scheme != "https" || value.User != nil || (value.Port() != "" && value.Port() != "443") {
		return ""
	}
	host := asciiFold(value.Hostname())
	path := value.EscapedPath()
	if host != "claude.com" || path != "/cai/oauth/authorize" {
		if !slices.Contains([]string{"claude.ai", "console.anthropic.com", "platform.claude.com"}, host) || path != "/oauth/authorize" {
			return ""
		}
	}
	value.Host = host
	return value.String()
}

func captureClaudeBrowserURL(args []string) (bool, error) {
	path, exists := os.LookupEnv(claudeOpenedURL)
	if !exists {
		return false, nil
	}
	if len(args) == 1 {
		if target := claudeAuthorizationURL(args[0]); target != "" {
			return true, saveBytes(path, []byte(target))
		}
	}
	return true, errors.New("INVALID_CLAUDE_LOGIN_URL")
}

type claudeLogin struct {
	mu       sync.Mutex
	progress object
	input    chan string
	cancel   context.CancelFunc
	done     chan struct{}
}

func (login *claudeLogin) view() object {
	login.mu.Lock()
	defer login.mu.Unlock()
	return clone(login.progress)
}

func (login *claudeLogin) active() bool {
	if login == nil {
		return false
	}
	select {
	case <-login.done:
		return false
	default:
		return true
	}
}

type claudeAccountManager struct {
	mu       sync.Mutex
	login    *claudeLogin
	lifetime context.Context
}

func (manager *claudeAccountManager) stop() {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.login.active() {
		manager.login.cancel()
		<-manager.login.done
	}
}

func (manager *claudeAccountManager) start(ctx context.Context, body object) (object, error) {
	if manager.login.active() {
		return nil, errors.New("CLAUDE_LOGIN_IN_PROGRESS: Complete or cancel the current login first")
	}
	browserID, ok := body["browserId"].(string)
	if !ok {
		browserID = "default"
	}
	var browser *claudeLoginBrowser
	browserName := "System default browser"
	if browserID != "default" {
		browsers, err := discoverClaudeBrowsers(ctx)
		if err != nil {
			return nil, err
		}
		index := slices.IndexFunc(browsers, func(b claudeLoginBrowser) bool { return b.ID == browserID })
		if index < 0 {
			return nil, errors.New("BROWSER_NOT_FOUND: Refresh the browser list and choose an installed browser")
		}
		browser = &browsers[index]
		browserName = browser.Name
	}
	accountID, reauth := body["accountId"].(string)
	account := claudeAccount{ID: accountID, Identity: object{}}
	if reauth {
		existing, err := readClaudeAccount(accountID)
		if err != nil {
			return nil, err
		}
		account = existing
	} else {
		account.ID = id()
	}
	dir, err := claudeAccountDir(account.ID)
	if err != nil {
		return nil, err
	}
	destination, config := filepath.Join(dir, "config"), filepath.Join(dir, "config")
	if reauth {
		config = filepath.Join(dir, "reauth-"+id())
	}
	if err := platform.PrivateDir(config); err != nil {
		return nil, err
	}
	opened := filepath.Join(config, ".arc-login-url")
	_ = os.Remove(opened)
	executable, err := runtimeBinary()
	if err != nil {
		return nil, err
	}
	lifetime := manager.lifetime
	if lifetime == nil {
		lifetime = context.WithoutCancel(ctx)
	}
	parent, cancel := context.WithCancel(lifetime)
	child, err := claudeProfileCommand(parent, config, "auth", "login", "--claudeai")
	if err != nil {
		cancel()
		return nil, err
	}
	child.Env = append(child.Env, "BROWSER="+executable, claudeOpenedURL+"="+opened)
	input, inErr := child.StdinPipe()
	stdout, outErr := child.StdoutPipe()
	stderr, errErr := child.StderrPipe()
	if pipeErr := errors.Join(inErr, outErr, errErr); pipeErr != nil {
		cancel()
		for _, pipe := range []io.Closer{input, stdout, stderr} {
			if pipe != nil {
				_ = pipe.Close()
			}
		}
		_ = os.RemoveAll(config)
		return nil, errors.New("CLAUDE_LOGIN_START_FAILED: Could not start Claude Code login")
	}
	if err := startOwnedChild(child); err != nil {
		cancel()
		_ = input.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		_ = os.RemoveAll(config)
		return nil, errors.New("CLAUDE_LOGIN_START_FAILED: Could not start Claude Code login")
	}
	progress := object{"id": id(), "accountId": account.ID, "browserId": browserID, "browserName": browserName, "state": "starting", "loginUrl": nil, "browserError": nil, "error": nil}
	login := &claudeLogin{progress: progress, input: make(chan string, 4), cancel: cancel, done: make(chan struct{})}
	manager.login = login
	initial := clone(progress)
	go login.finish(parent, child, input, stdout, stderr, browser, account, config, opened, destination, reauth)
	return initial, nil
}

var claudeLoginURLPattern = regexp.MustCompile(`https://[^\p{Z}\t\n\x0B\f\r\x{0085}\x1b<>"']+`)

func readClaudeLoginURLs(ctx context.Context, source io.Reader, urls chan<- string) {
	reader := bufio.NewScanner(source)
	reader.Buffer(make([]byte, 4096), 64*1024)
	for reader.Scan() {
		for _, raw := range claudeLoginURLPattern.FindAllString(reader.Text(), -1) {
			if target := claudeAuthorizationURL(raw); target != "" {
				select {
				case urls <- target:
				case <-ctx.Done():
					return
				}
			}
		}
	}
	// Keep draining the pipe if an oversized line stopped the scanner.
	_, _ = io.Copy(io.Discard, source)
}

func (login *claudeLogin) run(ctx context.Context, cmd *exec.Cmd, input io.WriteCloser, stdout, stderr io.ReadCloser, browser *claudeLoginBrowser, config, opened string) (object, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	urls := make(chan string, 8)
	var readers sync.WaitGroup
	for _, pipe := range []io.ReadCloser{stdout, stderr} {
		readers.Go(func() { readClaudeLoginURLs(ctx, pipe, urls) })
	}
	exited := make(chan error, 1)
	go func() { readers.Wait(); exited <- cmd.Wait() }()
	reaped := false
	defer func() {
		_ = input.Close()
		cancel()
		if !reaped {
			platform.SignalTree(cmd.Process.Pid, true)
			_ = stdout.Close()
			_ = stderr.Close()
			<-exited
		}
	}()
	deadline := time.NewTimer(600 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	start := time.Now()
	var fallback string
	var fallbackAt time.Time
	didOpen := false
	for {
		select {
		case <-ctx.Done():
			return nil, errors.New("CLAUDE_LOGIN_CANCELLED")
		case <-deadline.C:
			return nil, errors.New("CLAUDE_LOGIN_TIMEOUT: Start a new login and complete authorization within ten minutes")
		case err := <-exited:
			reaped = true
			if ctx.Err() != nil {
				return nil, errors.New("CLAUDE_LOGIN_CANCELLED")
			}
			if err != nil {
				return nil, errors.New("CLAUDE_LOGIN_FAILED: Claude Code could not complete authorization. Retry login and check the network settings")
			}
			identity, err := readClaudeIdentity(ctx, config)
			if err != nil {
				return nil, err
			}
			if identity["loggedIn"] != true || identity["authMethod"] != "claude.ai" {
				return nil, errors.New("CLAUDE_LOGIN_UNCONFIRMED: Claude Code did not confirm a Claude account login; retry")
			}
			return identity, nil
		case code := <-login.input:
			if _, err := io.WriteString(input, code+"\n"); err != nil {
				return nil, errors.New("CLAUDE_LOGIN_INPUT_FAILED: Start a new login")
			}
		case target := <-urls:
			if !didOpen {
				fallback, fallbackAt = target, time.Now()
			}
		case <-tick.C:
			if didOpen {
				continue
			}
			if time.Since(start) > 45*time.Second {
				return nil, errors.New("CLAUDE_LOGIN_NO_URL: Claude Code returned no supported authorization URL. Check the network and Claude Code installation, then retry login")
			}
			raw, _ := os.ReadFile(opened)
			target := claudeAuthorizationURL(string(raw))
			if target == "" && fallback != "" && time.Since(fallbackAt) >= 3*time.Second {
				target = fallback
			}
			if target == "" {
				continue
			}
			didOpen = true
			login.mu.Lock()
			login.progress["state"], login.progress["loginUrl"] = "waiting", target
			login.mu.Unlock()
			if err := openClaudeLoginBrowser(browser, target); err != nil {
				login.mu.Lock()
				login.progress["browserError"] = err.Error()
				login.mu.Unlock()
			}
		}
	}
}

func (login *claudeLogin) finish(ctx context.Context, cmd *exec.Cmd, input io.WriteCloser, stdout, stderr io.ReadCloser, browser *claudeLoginBrowser, account claudeAccount, config, opened, destination string, reauth bool) {
	defer close(login.done)
	defer login.cancel()
	identity, err := login.run(ctx, cmd, input, stdout, stderr, browser, config, opened)
	_ = os.Remove(opened)
	if reauth && err == nil {
		rows, readErr := readAccounts()
		err = readErr
		if err == nil {
			owner := ownerOfAccountProfile(rows, account.ID)
			if owner == nil {
				err = errors.New("ACCOUNT_PROFILE_NOT_FOUND")
			} else {
				err = confirmAccountReauth(owner, "anthropic", identity)
			}
		}
		if err == nil {
			err = installClaudeReauth(ctx, destination, config)
		}
	}
	if reauth || err != nil {
		if e := removeClaudeCredentials(context.WithoutCancel(ctx), config); e != nil {
			recordLog("WARN", e.Error(), nil)
		}
		_ = os.RemoveAll(config)
	}
	if err == nil {
		at := now()
		account.Identity, account.ObservedAt, account.Imported = identity, &at, false
		err = saveClaudeAccount(account)
	}
	login.mu.Lock()
	defer login.mu.Unlock()
	login.progress["loginUrl"] = nil
	switch {
	case err == nil:
		login.progress["state"] = "completed"
	case err.Error() == "CLAUDE_LOGIN_CANCELLED":
		login.progress["state"] = "cancelled"
	default:
		login.progress["state"] = "failed"
	}
	if err != nil {
		login.progress["error"] = err.Error()
	}
}

func (manager *claudeAccountManager) request(ctx context.Context, route, method string, body object) (object, error) {
	switch method + " " + route {
	case "GET profiles/system":
		return claudeSystemStatus(ctx)
	case "GET profiles/routes":
		routes, err := claudeNotificationRoutes()
		return object{"routes": routes}, err
	case "PUT profiles/routes":
		return bindClaudeNotificationRoute(text(body, "target"), text(body, "accountId"), true)
	case "GET profiles/browsers":
		browsers, err := discoverClaudeBrowsers(ctx)
		return object{"browsers": browsers}, err
	case "POST profiles/send":
		return sendAccountNotificationThroughOwner(ctx, body)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	login := manager.login
	switch method + " " + route {
	case "POST profiles/import-system":
		if login.active() {
			return nil, errors.New("CLAUDE_LOGIN_IN_PROGRESS: Complete or cancel the current login first")
		}
		return importClaudeSystem(ctx)
	case "GET profiles":
		accounts, err := listClaudeAccounts()
		if err != nil {
			return nil, err
		}
		var progress any
		if login != nil {
			progress = login.view()
		}
		return object{"accounts": accounts, "cliAvailable": findAccountAgent("claude") != "", "login": progress}, nil
	case "POST profiles/login":
		return manager.start(ctx, body)
	case "POST profiles/login/code":
		if login == nil {
			return nil, errors.New("CLAUDE_LOGIN_NOT_ACTIVE")
		}
		if !login.active() || login.view()["id"] != body["loginId"] {
			return nil, errors.New("CLAUDE_LOGIN_NOT_ACTIVE: Start a new login")
		}
		code := strings.TrimSpace(text(body, "code"))
		if code == "" || len(code) > 4096 || strings.ContainsFunc(code, unicode.IsControl) || strings.Contains(code, "://") {
			return nil, errors.New("INVALID_AUTHORIZATION_CODE: Paste the code shown by Claude, not a URL")
		}
		select {
		case login.input <- code:
			return object{"submitted": true}, nil
		default:
			return nil, errors.New("CLAUDE_LOGIN_BUSY: Wait for Claude Code before submitting again")
		}
	case "POST profiles/login/cancel":
		if login == nil || login.view()["id"] != body["loginId"] {
			return nil, errors.New("CLAUDE_LOGIN_NOT_ACTIVE")
		}
		login.cancel()
		<-login.done
		return login.view(), nil
	}
	tail, ok := strings.CutPrefix(route, "profiles/")
	if !ok {
		return nil, errors.New("UNKNOWN_ROUTE")
	}
	id, action, _ := strings.Cut(tail, "/")
	account, err := readClaudeAccount(id)
	if err != nil {
		return nil, err
	}
	if login.active() {
		return nil, errors.New("CLAUDE_LOGIN_IN_PROGRESS: Complete or cancel the current login first")
	}
	dir, _ := claudeAccountDir(id)
	config := filepath.Join(dir, "config")
	if action == "refresh" && method == "POST" {
		identity, err := readClaudeIdentity(ctx, config)
		if err != nil {
			return nil, err
		}
		at := now()
		account.Identity, account.ObservedAt = identity, &at
		if err := saveClaudeAccount(account); err != nil {
			return nil, err
		}
		return object{"id": account.ID, "identity": account.Identity, "observedAt": account.ObservedAt, "imported": account.Imported}, nil
	}
	if action == "" && method == "DELETE" {
		if account.Imported {
			if err := removeClaudeCredentials(ctx, config); err != nil {
				return nil, err
			}
		} else if err := logoutClaudeAccount(ctx, config); err != nil {
			return nil, err
		}
		if err := os.RemoveAll(dir); err != nil {
			return nil, err
		}
		if login != nil && login.view()["accountId"] == id {
			manager.login = nil
		}
		return object{"removed": true}, nil
	}
	return nil, errors.New("UNKNOWN_ROUTE")
}

func logoutClaudeAccount(ctx context.Context, config string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd, err := claudeProfileCommand(ctx, config, "auth", "logout")
	if err != nil {
		return err
	}
	_, err = cmd.Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return errors.New("CLAUDE_LOGOUT_TIMEOUT: Retry removing this account")
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return errors.New("CLAUDE_LOGOUT_FAILED: Account retained; retry removing it")
	}
	if err != nil {
		return errors.New("CLAUDE_LOGOUT_FAILED: Could not run Claude Code logout")
	}
	return nil
}

var sendAccountNotification func(context.Context, object) (object, error)

func sendAccountNotificationThroughOwner(ctx context.Context, body object) (object, error) {
	return sendAccountNotification(ctx, body)
}

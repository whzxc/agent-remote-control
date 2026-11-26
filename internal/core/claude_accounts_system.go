package core

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/text/unicode/norm"
)

func claudeSystemMarker() string { return filepath.Join(claudeAccountsDir(), "system-import.json") }

func initialClaudeAccount() (string, error) {
	value, err := load(claudeSystemMarker())
	if account, ok := field(value, "accountId").(string); err == nil && ok {
		return account, nil
	}
	return "", errors.New("CLAUDE_SYSTEM_IMPORT_REQUIRED: Import the system login in Accounts or assign this target with accounts.route")
}

func sameClaudeSystemIdentity(left, right any) bool {
	if field(left, "loggedIn") != true || field(right, "loggedIn") != true || field(left, "authMethod") != "claude.ai" || field(right, "authMethod") != "claude.ai" {
		return false
	}
	a, b := text(left, "accountId"), text(right, "accountId")
	same := a == b
	if a == "" || b == "" {
		a, b = text(left, "email"), text(right, "email")
		same = a != "" && asciiFold(a) == asciiFold(b)
	}
	return same && reflect.DeepEqual(field(left, "orgId"), field(right, "orgId"))
}

func asciiFold(value string) string {
	return strings.Map(func(r rune) rune {
		if 'A' <= r && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, value)
}

func claudeHostConfig() string {
	if config := os.Getenv("CLAUDE_CONFIG_DIR"); config != "" {
		return config
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

func claudeHostStorage() string {
	if storage, ok := os.LookupEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR"); ok {
		if storage != "" {
			return storage
		}
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".claude")
	}
	return claudeHostConfig()
}

func claudeKeychainService(config string) string {
	if config == "" {
		var ok bool
		if config, ok = os.LookupEnv("CLAUDE_SECURESTORAGE_CONFIG_DIR"); !ok {
			config = os.Getenv("CLAUDE_CONFIG_DIR")
		}
	}
	const service = "Claude Code-credentials"
	if config == "" {
		return service
	}
	return service + "-" + hash([]byte(norm.NFC.String(strings.ToValidUTF8(config, "�"))))[:8]
}

func claudeKeychainUser() string {
	user := os.Getenv("USER")
	if user == "" {
		if home, err := os.UserHomeDir(); err == nil {
			user = filepath.Base(home)
		}
	}
	if user == "" || strings.ContainsFunc(user, func(c rune) bool {
		return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._-", c))
	}) {
		return "claude-code-user"
	}
	return user
}

func claudeSecurity(ctx context.Context, args ...string) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	data, err := nativeCommand(ctx, "/usr/bin/security", args...).Output()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, -1, errors.New("CLAUDE_IMPORT_TIMEOUT: Unlock Keychain and retry import")
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return nil, exit.ExitCode(), nil
	}
	if err != nil {
		return nil, -1, errors.New("CLAUDE_IMPORT_FAILED: Could not access Keychain")
	}
	return data, 0, nil
}

func readClaudeCredentials(ctx context.Context, config, storage string) (object, error) {
	var data []byte
	if operatingSystem == "darwin" {
		got, status, err := claudeSecurity(ctx, "find-generic-password", "-a", claudeKeychainUser(), "-s", claudeKeychainService(config), "-w")
		if err != nil {
			return nil, err
		}
		switch status {
		case 0:
			data = got
		case 44:
		default:
			return nil, errors.New("CLAUDE_IMPORT_KEYCHAIN_UNAVAILABLE: Unlock the login Keychain and retry import")
		}
	}
	if data == nil {
		var err error
		data, err = os.ReadFile(filepath.Join(storage, ".credentials.json"))
		if err != nil {
			return nil, errors.New("CLAUDE_IMPORT_CREDENTIALS_UNAVAILABLE: Sign in with the system CLI and retry import")
		}
	}
	var value any
	if canonjson.Unmarshal(data, &value) != nil {
		return nil, errors.New("CLAUDE_IMPORT_CREDENTIALS_INVALID: Re-login with the system CLI and retry import")
	}
	auth := obj(field(value, "claudeAiOauth"))
	if auth == nil {
		return nil, errors.New("CLAUDE_IMPORT_CREDENTIALS_INVALID: No Claude account credential was found; sign in with the system CLI")
	}
	return object{"claudeAiOauth": auth}, nil
}

func writeClaudeCredentials(ctx context.Context, config string, credentials object) error {
	if operatingSystem != "darwin" {
		return save(filepath.Join(config, ".credentials.json"), credentials)
	}
	data, err := canonjson.Marshal(credentials)
	if err != nil {
		return errors.New("CLAUDE_IMPORT_FAILED")
	}
	input := fmt.Sprintf("add-generic-password -U -a \"%s\" -s \"%s\" -X \"%s\"\n", claudeKeychainUser(), claudeKeychainService(config), hex.EncodeToString(data))
	wait, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := nativeCommand(wait, "/usr/bin/security", "-i")
	cmd.Stdin = strings.NewReader(input)
	if startOwnedChild(cmd) != nil {
		return errors.New("CLAUDE_IMPORT_FAILED: Could not open Keychain")
	}
	err = cmd.Wait()
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return errors.New("CLAUDE_IMPORT_TIMEOUT: Unlock Keychain and retry import")
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return errors.New("CLAUDE_IMPORT_FAILED: Keychain rejected the isolated credential; unlock it and retry import")
	}
	if err != nil {
		return errors.New("CLAUDE_IMPORT_FAILED: Could not store the isolated credential")
	}
	return nil
}

func removeClaudeCredentials(ctx context.Context, config string) error {
	if operatingSystem == "darwin" {
		_, status, err := claudeSecurity(ctx, "delete-generic-password", "-a", claudeKeychainUser(), "-s", claudeKeychainService(config))
		if err != nil {
			return err
		}
		if status != 0 && status != 44 {
			return errors.New("CLAUDE_IMPORT_CLEANUP_FAILED")
		}
	}
	if err := os.Remove(filepath.Join(config, ".credentials.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("CLAUDE_IMPORT_CLEANUP_FAILED: Could not remove the isolated credential file")
	}
	return nil
}

func installClaudeReauth(ctx context.Context, destination, staging string) error {
	staged, err := load(filepath.Join(staging, ".claude.json"))
	if err != nil {
		return err
	}
	path := filepath.Join(destination, ".claude.json")
	existing, err := load(path)
	if errors.Is(err, os.ErrNotExist) {
		existing, err = object{}, nil
	}
	if err != nil {
		return err
	}
	metadata := obj(existing)
	if obj(field(staged, "oauthAccount")) == nil || metadata == nil {
		return errors.New("CLAUDE_LOGIN_UNCONFIRMED: Claude Code did not provide account metadata")
	}
	credentials, err := readClaudeCredentials(ctx, staging, staging)
	if err != nil {
		return err
	}
	metadata["oauthAccount"], metadata["hasCompletedOnboarding"] = field(staged, "oauthAccount"), true
	if err := save(path, metadata); err != nil {
		return err
	}
	return writeClaudeCredentials(ctx, destination, credentials)
}

func claudeSystemStatus(ctx context.Context) (object, error) {
	identity, err := readClaudeIdentity(ctx, "")
	if err != nil {
		return nil, err
	}
	accounts, err := listClaudeAccounts()
	if err != nil {
		return nil, err
	}
	var accountID any
	for _, account := range accounts {
		if sameClaudeSystemIdentity(account.Identity, identity) {
			accountID = account.ID
			break
		}
	}
	_, err = os.Stat(claudeSystemMarker())
	return object{"identity": identity, "accountId": accountID, "initialized": err == nil, "observedAt": now()}, nil
}

func finishClaudeImport(account string) error {
	marker := claudeSystemMarker()
	_, err := os.Stat(marker)
	exists := err == nil
	if exists {
		account, err = initialClaudeAccount()
		if err != nil {
			return err
		}
	}
	if err := migrateDefaultClaudeRoute(account); err != nil {
		return err
	}
	if !exists {
		return save(marker, object{"accountId": account})
	}
	return nil
}

func importClaudeSystem(ctx context.Context) (object, error) {
	host, err := readClaudeIdentity(ctx, "")
	if err != nil {
		return nil, err
	}
	if host["loggedIn"] != true || host["authMethod"] != "claude.ai" {
		return nil, errors.New("CLAUDE_SYSTEM_LOGIN_REQUIRED: Sign in to a Claude account with the system CLI, then import it in Accounts")
	}
	accounts, err := listClaudeAccounts()
	if err != nil {
		return nil, err
	}
	for _, account := range accounts {
		if !sameClaudeSystemIdentity(account.Identity, host) {
			continue
		}
		config, err := claudeProfileConfig(account.ID)
		if err != nil {
			return nil, err
		}
		observed, err := readClaudeIdentity(ctx, config)
		if err != nil {
			return nil, err
		}
		if !sameClaudeSystemIdentity(observed, host) {
			continue
		}
		at := now()
		account.Identity, account.ObservedAt = observed, &at
		if err := saveClaudeAccount(account); err != nil {
			return nil, err
		}
		if err := finishClaudeImport(account.ID); err != nil {
			return nil, err
		}
		return object{"account": account, "identity": host}, nil
	}
	accountID := id()
	dir := filepath.Join(claudeAccountsDir(), accountID)
	config := filepath.Join(dir, "config")
	if err := platform.PrivateDir(config); err != nil {
		return nil, err
	}
	saved := false
	defer func() {
		if !saved {
			_ = removeClaudeCredentials(context.WithoutCancel(ctx), config)
			_ = os.RemoveAll(dir)
		}
	}()
	source := os.Getenv("CLAUDE_CONFIG_DIR")
	if source == "" {
		source, err = os.UserHomeDir()
		if err != nil {
			return nil, errors.New("HOME_UNAVAILABLE")
		}
	}
	metadata, err := load(filepath.Join(source, ".claude.json"))
	if err != nil {
		return nil, err
	}
	credentials, err := readClaudeCredentials(ctx, "", claudeHostStorage())
	if err != nil {
		return nil, err
	}
	if err := save(filepath.Join(config, ".claude.json"), object{"oauthAccount": field(metadata, "oauthAccount"), "hasCompletedOnboarding": true}); err != nil {
		return nil, err
	}
	if err := writeClaudeCredentials(ctx, config, credentials); err != nil {
		return nil, err
	}
	observed, err := readClaudeIdentity(ctx, config)
	if err != nil {
		return nil, err
	}
	if !sameClaudeSystemIdentity(observed, host) {
		return nil, errors.New("CLAUDE_IMPORT_UNCONFIRMED: The isolated CLI did not confirm the system identity. Refresh the system login and retry import")
	}
	at := now()
	account := claudeAccount{ID: accountID, Identity: observed, ObservedAt: &at, Imported: true}
	if err := saveClaudeAccount(account); err != nil {
		return nil, err
	}
	saved = true
	if err := finishClaudeImport(account.ID); err != nil {
		return nil, err
	}
	return object{"account": account, "identity": host}, nil
}

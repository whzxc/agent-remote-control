package core

import (
	"context"
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
	assets "github.com/whzxc/agent-remote-control/shared/core"
)

const adapterPackageLimit = 128 << 20

func nativeClaudeAdapterManifest() (object, []byte, error) {
	bytes, err := assets.Files.ReadFile("claude-adapter.json")
	if err != nil {
		return nil, nil, err
	}
	var manifest object
	if err := decodeObject(bytes, &manifest); err != nil {
		return nil, nil, err
	}
	version := text(manifest, "version")
	if version == "" || filepath.Base(version) != version || version == "." || version == ".." {
		return nil, nil, errors.New("CLAUDE_ADAPTER_MANIFEST_INVALID")
	}
	return manifest, bytes, nil
}

func nativeClaudeAdapterPath(version string) string {
	return filepath.Join(root(), "dependencies", "claude-acp", version)
}

func nativeClaudeAdapterExecutables(dir string) (string, string) {
	bun := "bun"
	if operatingSystem == "windows" {
		bun += ".exe"
	}
	return filepath.Join(dir, "runtime", "bin", bun),
		filepath.Join(dir, "node_modules", "@agentclientprotocol", "claude-agent-acp", "dist", "index.js")
}

func nativeClaudeAdapterReady() bool {
	manifest, bytes, err := nativeClaudeAdapterManifest()
	if err != nil {
		return false
	}
	dir := nativeClaudeAdapterPath(text(manifest, "version"))
	record, err := cachedLoad(filepath.Join(dir, "ready.json"))
	if err != nil || wire(record) != wire(object{"manifest": hash(bytes)}) {
		return false
	}
	binary, entry := nativeClaudeAdapterExecutables(dir)
	for _, path := range []string{binary, entry} {
		if stat, err := os.Stat(path); err != nil || !stat.Mode().IsRegular() {
			return false
		}
	}
	return true
}

func pruneNativeClaudeAdapters() error {
	manifest, _, err := nativeClaudeAdapterManifest()
	if err != nil {
		return nil
	}
	current := nativeClaudeAdapterPath(text(manifest, "version"))
	parent := filepath.Dir(current)
	rows, err := os.ReadDir(parent)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, row := range rows {
		dir := filepath.Join(parent, row.Name())
		if dir != current && row.IsDir() {
			if record, err := load(filepath.Join(dir, "ready.json")); err == nil && text(record, "manifest") != "" {
				if err := os.RemoveAll(dir); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func unpackNativeClaudeAdapter(ctx context.Context, client *http.Client, pkg object, dest string) error {
	if err := platform.PrivateDir(dest); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, text(pkg, "url"), nil)
	if err != nil {
		return errors.New("CLAUDE_ADAPTER_DOWNLOAD_FAILED")
	}
	request.Header.Set("User-Agent", "agent-remote-control")
	response, err := client.Do(request)
	if err != nil {
		return errors.New("CLAUDE_ADAPTER_DOWNLOAD_FAILED")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("CLAUDE_ADAPTER_DOWNLOAD_FAILED")
	}
	archive := filepath.Join(dest, "download.tgz")
	file, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	digest := sha512.New()
	count, err := io.Copy(io.MultiWriter(file, digest), io.LimitReader(response.Body, adapterPackageLimit+1))
	if issue := file.Close(); issue != nil {
		return issue
	}
	if err != nil {
		return errors.New("CLAUDE_ADAPTER_DOWNLOAD_FAILED")
	}
	if count > adapterPackageLimit {
		return errors.New("CLAUDE_ADAPTER_DOWNLOAD_TOO_LARGE")
	}
	if "sha512-"+base64.StdEncoding.EncodeToString(digest.Sum(nil)) != pkg["integrity"] {
		return errors.New("CLAUDE_ADAPTER_CHECKSUM_FAILED")
	}
	extractor := "/usr/bin/tar"
	if operatingSystem == "windows" {
		extractor = filepath.Join(nonemptyTaskText(os.Getenv("SystemRoot"), `C:\Windows`), "System32", "tar.exe")
	}
	wait, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if err := nativeCommand(wait, extractor, "-xzf", archive, "--strip-components=1", "-C", dest).Run(); err != nil {
		return errors.New("CLAUDE_ADAPTER_EXTRACT_FAILED")
	}
	return os.Remove(archive)
}

func prepareNativeClaudeAdapter(ctx context.Context) error {
	if nativeClaudeAdapterReady() {
		return nil
	}
	manifest, bytes, err := nativeClaudeAdapterManifest()
	if err != nil {
		return err
	}
	driver, _ := nativeAgentDriverByID("claude")
	found := driver.discover(ctx)
	if found.binary == "" || !strings.Contains(found.version, "Claude Code") {
		if found.err != nil {
			return found.err
		}
		return errors.New("AGENT_NOT_INSTALLED")
	}
	system := operatingSystem
	if system == "darwin" {
		system = "macos"
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x86_64"
	} else if arch == "arm64" {
		arch = "aarch64"
	}
	bun := obj(field(manifest["runtimes"], system+"-"+arch))
	if bun == nil {
		return errors.New("UNSUPPORTED_PLATFORM")
	}
	target := nativeClaudeAdapterPath(text(manifest, "version"))
	if err := platform.PrivateDir(filepath.Dir(target)); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(filepath.Dir(target), ".prepare-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	proxy, err := savedNetworkProxy(ctx)
	if err != nil {
		return err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = proxy.proxyFor
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 180 * time.Second}
	if err := unpackNativeClaudeAdapter(ctx, client, bun, filepath.Join(staging, "runtime")); err != nil {
		return err
	}
	packages := arr(manifest["packages"])
	if len(packages) == 0 {
		return errors.New("CLAUDE_ADAPTER_MANIFEST_INVALID")
	}
	for _, pkg := range packages {
		name := text(pkg, "name")
		repository := filepath.Join(staging, "node_modules")
		dest := filepath.Join(repository, name)
		if name == "" || !belowPath(dest, repository) {
			return errors.New("CLAUDE_ADAPTER_MANIFEST_INVALID")
		}
		if err := unpackNativeClaudeAdapter(ctx, client, obj(pkg), dest); err != nil {
			return err
		}
	}
	binary, entry := nativeClaudeAdapterExecutables(staging)
	probe, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	command := nativeCommand(probe, binary, entry, "--version")
	command.Env = append(safeClaudeAdapterEnvironment(command.Environ()), "CLAUDE_CODE_EXECUTABLE="+found.binary)
	output, err := command.Output()
	if err != nil || strings.TrimSpace(string(output)) != text(packages[0], "version") {
		return errors.New("CLAUDE_ADAPTER_PROBE_FAILED")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := save(filepath.Join(staging, "ready.json"), object{"manifest": hash(bytes)}); err != nil {
		return err
	}
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	return os.Rename(staging, target)
}

func safeClaudeAdapterEnvironment(env []string) []string {
	clean := make([]string, 0, len(env))
	for _, row := range env {
		if key, _, _ := strings.Cut(row, "="); key != "NODE_OPTIONS" && key != "BUN_OPTIONS" {
			clean = append(clean, row)
		}
	}
	return clean
}

func (host *nativeAgentHost) stopClaudeAdapterPreparation() {
	host.adapterMu.Lock()
	cancel, done := host.adapterCancel, host.adapterDone
	host.adapterMu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
}

func (host *nativeAgentHost) setEnabled(ctx context.Context, body object) (object, error) {
	enabled, valid := body["enabled"].(bool)
	if body["agent"] != "claude" || !valid {
		return updateNativeAgentEnabled(body)
	}
	if !enabled {
		host.stopClaudeAdapterPreparation()
		host.adapterMu.Lock()
		host.adapterFailure = ""
		host.adapterMu.Unlock()
		return updateNativeAgentEnabled(body)
	}
	host.adapterMu.Lock()
	defer host.adapterMu.Unlock()
	if nativeClaudeAdapterReady() {
		return updateNativeAgentEnabled(body)
	}
	if host.adapterDone == nil {
		wait, cancel := context.WithCancel(context.WithoutCancel(ctx))
		done := make(chan struct{})
		host.adapterCancel, host.adapterDone, host.adapterFailure = cancel, done, ""
		go func() {
			defer close(done)
			defer cancel()
			err := prepareNativeClaudeAdapter(wait)
			if err == nil && wait.Err() == nil {
				_, err = updateNativeAgentEnabled(object{"agent": "claude", "enabled": true})
			}
			host.adapterMu.Lock()
			defer host.adapterMu.Unlock()
			if err != nil && wait.Err() == nil {
				host.adapterFailure = err.Error()
			}
			host.adapterCancel, host.adapterDone = nil, nil
		}()
	}
	return object{"enabled": false, "preparing": true}, nil
}

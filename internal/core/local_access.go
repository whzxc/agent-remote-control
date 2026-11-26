package core

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const localServerName = "agent-remote-control"

var localInstall sync.Mutex

type localClient struct {
	id, name, product, path, binary string
	available                       bool
}

func localClients() map[string]localClient {
	home, _ := os.UserHomeDir()
	codeHome, exists := os.LookupEnv("CLAUDE_CONFIG_DIR")
	if !exists {
		codeHome = home
	}
	code, _ := exec.LookPath("claude")
	var desktop string
	switch operatingSystem {
	case "darwin":
		if home != "" {
			desktop = filepath.Join(home, "Library/Application Support/Claude/claude_desktop_config.json")
		}
	case "windows":
		if config, err := os.UserConfigDir(); err == nil {
			desktop = filepath.Join(config, "Claude/claude_desktop_config.json")
		}
	}
	antiHome := home
	var antigravity string
	if antiHome != "" {
		antigravity = filepath.Join(antiHome, ".gemini/config/mcp_config.json")
	}
	available := false
	for _, path := range []string{filepath.Join(antiHome, ".gemini/config"), filepath.Join(antiHome, ".gemini/antigravity"), filepath.Join(antiHome, ".gemini/antigravity/bin/agentapi"), "/Applications/Antigravity.app"} {
		if _, err := os.Stat(path); err == nil {
			available = true
			break
		}
	}
	for _, name := range []string{"agy", "antigravity"} {
		if _, err := exec.LookPath(name); err == nil {
			available = true
		}
	}
	return map[string]localClient{
		"code":        {id: "local-claude-code", name: "Claude Code", product: "claude", path: filepath.Join(codeHome, ".claude.json"), binary: code, available: code != ""},
		"desktop":     {id: "local-claude-desktop", name: "Claude Desktop", product: "claude", path: desktop, available: desktop != ""},
		"antigravity": {id: "local-antigravity", name: "Antigravity", product: "gemini", path: antigravity, available: available},
	}
}

func localConfiguration(path string) (any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return object{}, nil
	}
	var value any
	err = unmarshalJSON(data, &value)
	return value, err
}

func localServerConfig(client localClient) object {
	config := object{"command": cliExecutable(), "args": []any{"cli", "local-mcp", client.id}}
	if client.id != "local-antigravity" {
		config["env"] = object{"ARC_STATE_DIR": root()}
	}
	return config
}

func localServerInstalled(client localClient, expected object) bool {
	config, err := localConfiguration(client.path)
	if err != nil {
		return false
	}
	current := field(field(config, "mcpServers"), localServerName)
	for _, key := range []string{"command", "args", "env"} {
		if wire(field(current, key)) != wire(expected[key]) {
			return false
		}
	}
	return true
}

func localAccessStatus(ctx context.Context, s *service) (object, error) {
	localInstall.Lock()
	defer localInstall.Unlock()
	reply := object{}
	clients := localClients()
	for _, name := range []string{"code", "desktop", "antigravity"} {
		client := clients[name]
		installed := localServerInstalled(client, localServerConfig(client))
		if installed && name == "antigravity" {
			rows, err := s.management(ctx, "ingress", http.MethodGet, object{})
			if err != nil {
				return nil, err
			}
			installed = false
			for _, row := range arr(rows) {
				if field(row, "transport") == "local" && (field(row, "id") == client.id || field(row, "name") == client.id || field(row, "controlSource") == "gemini" && field(row, "name") == "Antigravity") {
					installed = true
					break
				}
			}
		} else if installed {
			_, err := s.management(ctx, "ingress/"+client.id, http.MethodGet, object{})
			installed = err == nil
		}
		reply[name+"Available"], reply[name+"Installed"] = client.available, installed
	}
	return reply, nil
}

func writeLocalRegistration(client localClient, expected object) error {
	if client.path == "" {
		return errors.New("HOME_UNAVAILABLE")
	}
	config, err := localConfiguration(client.path)
	if errors.Is(err, os.ErrNotExist) {
		config, err = object{}, nil
	}
	if err != nil {
		return err
	}
	row := obj(config)
	if row == nil {
		return errors.New("Invalid client configuration")
	}
	if _, exists := row["mcpServers"]; !exists {
		row["mcpServers"] = object{}
	}
	servers := obj(row["mcpServers"])
	if servers == nil {
		return errors.New("Invalid client server configuration")
	}
	if current, exists := servers[localServerName]; exists && client.id != "local-antigravity" && wire(current) != wire(expected) {
		return errors.New("LOCAL_CONFIG_CONFLICT")
	}
	servers[localServerName] = expected
	return save(client.path, row)
}

func installLocalAccess(ctx context.Context, s *service, target string) (object, error) {
	localInstall.Lock()
	defer localInstall.Unlock()
	client := localClients()[target]
	if !client.available {
		return nil, errors.New("LOCAL_CLIENT_UNAVAILABLE")
	}
	expected := localServerConfig(client)
	if target != "code" {
		if err := writeLocalRegistration(client, expected); err != nil {
			return nil, err
		}
	} else if !localServerInstalled(client, expected) {
		if config, err := localConfiguration(client.path); err == nil && field(field(config, "mcpServers"), localServerName) != nil {
			return nil, errors.New("LOCAL_CONFIG_CONFLICT")
		}
		wait, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		cmd := exec.CommandContext(wait, client.binary, "mcp", "add", "--transport", "stdio", "--scope", "user", "--env",
			"ARC_STATE_DIR="+root(), localServerName, "--", str(expected["command"]), "cli", "local-mcp", client.id)
		if err := cmd.Run(); err != nil {
			if wait.Err() != nil {
				return nil, errors.New("LOCAL_INSTALL_TIMEOUT")
			}
			return nil, errors.New("LOCAL_INSTALL_FAILED")
		}
	}
	if !localServerInstalled(client, expected) {
		return nil, errors.New("LOCAL_INSTALL_NOT_CONFIRMED")
	}
	input := object{"id": client.id, "name": client.name, "controlSource": client.product, "transport": "local", "auth": "none", "config": object{"autoStart": true}}
	route := "ingress/" + client.id
	_, existing := s.management(ctx, route, http.MethodGet, object{})
	if target == "antigravity" {
		input["enabled"] = true
	}
	if existing != nil {
		if _, err := s.management(ctx, "ingress", http.MethodPost, input); err != nil {
			return nil, err
		}
	} else if target == "antigravity" {
		if _, err := s.management(ctx, route, http.MethodPut, input); err != nil {
			return nil, err
		}
	}
	if _, err := s.management(ctx, route+"/start", http.MethodPost, object{}); err != nil {
		return nil, err
	}
	if target == "antigravity" {
		result, err := s.management(ctx, "source", http.MethodGet, object{})
		if err != nil {
			return nil, err
		}
		for _, source := range arr(field(result, "sources")) {
			if field(source, "ingressId") == client.id && (field(source, "product") != "gemini" || field(source, "label") != "Antigravity") {
				if _, err := s.management(ctx, "source/"+text(source, "id"), http.MethodPut, object{"product": "gemini", "label": "Antigravity"}); err != nil {
					return nil, err
				}
			}
		}
	}
	return object{"installed": true, "ingressId": client.id}, nil
}

func localMCP(ctx context.Context, ingress string, input io.Reader, output io.Writer) error {
	if !routeID.MatchString(ingress) {
		return errors.New("invalid ingress id")
	}
	binary, err := runtimeBinary()
	if err != nil {
		return err
	}
	client, err := connectRuntimeClient(ctx, binary, "cli")
	if err != nil {
		return err
	}
	defer func() {
		release, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		client.close(release)
	}()
	route := "ingress/" + ingress
	entry, err := client.request(ctx, route, http.MethodGet, object{})
	if err != nil {
		return err
	}
	if field(entry, "transport") != "local" {
		return errors.New("Not a local control source")
	}
	if _, err := client.request(ctx, route+"/start", http.MethodPost, object{}); err != nil {
		return err
	}
	meta, _, err := discoverLocal(ctx)
	if err != nil {
		return err
	}
	port := uintOr(meta["port"], 0)
	if port == 0 || port > 65535 {
		return errors.New("Invalid Core port")
	}
	return stdioConnection(ctx, port, text(meta, "token"), ingress, input, output)
}

func init() {
	registerRoute("GET", "local-access/status", func(ctx context.Context, s *service, _ object, _ []string) (any, error) {
		return localAccessStatus(ctx, s)
	})
	registerRoute("POST", "local-access/install", func(ctx context.Context, s *service, args object, _ []string) (any, error) {
		return installLocalAccess(ctx, s, text(args, "target"))
	})
}

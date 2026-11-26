package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

type nativeACPServer struct {
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

type nativeACPConfiguration struct {
	Servers                []nativeACPServer `json:"mcpServers"`
	IncludeContextProvider *bool             `json:"includeContextProvider"`
}

func nativeACPServers(agent string) ([]object, error) {
	configs := map[string]nativeACPConfiguration{}
	data, err := os.ReadFile(filepath.Join(root(), "agents", "mcp.json"))
	switch {
	case err == nil:
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&configs); err != nil {
			return nil, fmt.Errorf("INVALID_AGENT_MCP: %w", err)
		}
	case !errors.Is(err, os.ErrNotExist):
		return nil, err
	}
	config := configs[agent]
	names := map[string]bool{}
	servers := []object{}
	for _, item := range config.Servers {
		if strings.TrimSpace(item.Name) == "" || names[item.Name] || !filepath.IsAbs(item.Command) {
			return nil, errors.New("INVALID_AGENT_MCP: unique names and absolute commands required")
		}
		names[item.Name] = true
		environment := []object{}
		for _, name := range slices.Sorted(maps.Keys(item.Env)) {
			environment = append(environment, object{"name": name, "value": item.Env[name]})
		}
		args := item.Args
		if args == nil {
			args = []string{}
		}
		servers = append(servers, object{"name": item.Name, "command": item.Command, "args": args, "env": environment})
	}
	if config.IncludeContextProvider == nil || *config.IncludeContextProvider {
		provider, err := readContextProviderConfig()
		if err != nil {
			return nil, err
		}
		if provider != nil {
			if names["context-provider"] {
				return nil, errors.New("INVALID_AGENT_MCP: context-provider is reserved while includeContextProvider is enabled")
			}
			binary, err := runtimeBinary()
			if err != nil {
				return nil, err
			}
			servers = append(servers, object{"name": "context-provider", "command": binary, "args": []string{"context-provider-stdio"},
				"env": []object{{"name": "ARC_STATE_DIR", "value": root()}}})
		}
	}
	return servers, nil
}

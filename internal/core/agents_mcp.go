package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type agentMCPConfig struct {
	Servers                []agentMCPServer `json:"mcpServers"`
	IncludeContextProvider *bool            `json:"includeContextProvider"`
}

type agentMCPServer struct {
	Name    *string           `json:"name"`
	Command *string           `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

func agentMCPServers(agent string) ([]object, error) {
	configs := map[string]agentMCPConfig{}
	path := filepath.Join(root(), "agents/mcp.json")
	stored, err := load(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		decoder := json.NewDecoder(bytes.NewBufferString(wire(stored)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&configs); err != nil {
			return nil, fmt.Errorf("INVALID_AGENT_MCP: %w", err)
		}
	}
	config := configs[agent]
	servers := make([]object, 0, len(config.Servers))
	names := make(map[string]bool, len(config.Servers))
	for _, server := range config.Servers {
		switch {
		case server.Name == nil:
			return nil, errors.New("INVALID_AGENT_MCP: missing field `name`")
		case server.Command == nil:
			return nil, errors.New("INVALID_AGENT_MCP: missing field `command`")
		case strings.TrimSpace(*server.Name) == "" || names[*server.Name] || !filepath.IsAbs(*server.Command):
			return nil, errors.New("INVALID_AGENT_MCP: unique names and absolute commands required")
		}
		names[*server.Name] = true
		env := make(object, len(server.Env))
		for key, value := range server.Env {
			env[key] = value
		}
		variables := make([]object, 0, len(env))
		for _, name := range keys(env) {
			variables = append(variables, object{"name": name, "value": env[name]})
		}
		args := server.Args
		if args == nil {
			args = []string{}
		}
		servers = append(servers, object{"name": *server.Name, "command": *server.Command, "args": args, "env": variables})
	}
	if config.IncludeContextProvider == nil || *config.IncludeContextProvider {
		provider, err := contextProviderACPServer()
		if err != nil {
			return nil, err
		}
		if provider != nil {
			if names["context-provider"] {
				return nil, errors.New("INVALID_AGENT_MCP: context-provider is reserved while includeContextProvider is enabled")
			}
			servers = append(servers, provider)
		}
	}
	return servers, nil
}

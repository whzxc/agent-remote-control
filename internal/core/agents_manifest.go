package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	agentassets "github.com/whzxc/agent-remote-control/native/src/agents"
)

type nativeACPManifest struct {
	ID            string                 `json:"id"`
	Command       string                 `json:"command"`
	Args          []string               `json:"args"`
	DisplayName   *string                `json:"displayName"`
	Protocol      string                 `json:"protocol"`
	Integration   string                 `json:"integration"`
	Aliases       []string               `json:"aliases"`
	SearchDirs    []string               `json:"searchDirs"`
	VersionArgs   []string               `json:"versionArgs"`
	Compatibility nativeACPCompatibility `json:"compatibility"`
}

type nativeACPCompatibility struct {
	HelpArgs           []string `json:"helpArgs"`
	HelpContains       []string `json:"helpContains"`
	IdentityContains   []string `json:"identityContains"`
	VersionRequirement string   `json:"versionRequirement"`
	Runtime            string   `json:"runtime"`
	Authentication     string   `json:"authentication"`
	Caveats            []string `json:"caveats"`
	Sources            []string `json:"sources"`
}

func validACPManifestID(id string) bool {
	if id == "" {
		return false
	}
	for _, char := range id {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '-') {
			return false
		}
	}
	return true
}

func parseNativeACPManifests(data []byte) ([]nativeACPManifest, error) {
	var rows []json.RawMessage
	if err := unmarshalJSON(data, &rows); err != nil {
		return nil, err
	}
	if rows == nil {
		return nil, errors.New("INVALID_ACP_MANIFEST")
	}
	manifests := make([]nativeACPManifest, 0, len(rows))
	seen := map[string]bool{}
	for _, raw := range rows {
		manifest := nativeACPManifest{Protocol: "acp-v1", Integration: "custom", VersionArgs: []string{"--version"},
			Args: []string{}, Aliases: []string{}, SearchDirs: []string{}, Compatibility: nativeACPCompatibility{
				HelpArgs: []string{}, HelpContains: []string{}, IdentityContains: []string{}, Caveats: []string{}, Sources: []string{},
			}}
		input := json.NewDecoder(bytes.NewReader(raw))
		input.DisallowUnknownFields()
		if err := input.Decode(&manifest); err != nil {
			return nil, err
		}
		if err := input.Decode(new(any)); err != io.EOF {
			return nil, errors.New("INVALID_ACP_MANIFEST")
		}
		if !validACPManifestID(manifest.ID) || seen[manifest.ID] {
			return nil, errors.New("INVALID_OR_DUPLICATE_AGENT_ID")
		}
		keywords := len(manifest.Compatibility.HelpContains) + len(manifest.Compatibility.IdentityContains)
		if manifest.Protocol != "acp-v1" || strings.TrimSpace(manifest.Command) == "" || strings.ContainsRune(manifest.Command, 0) ||
			manifest.Args == nil || manifest.VersionArgs == nil || manifest.SearchDirs == nil || manifest.Aliases == nil ||
			slices.ContainsFunc(manifest.Args, func(value string) bool { return strings.ContainsRune(value, 0) }) ||
			keywords > 0 && len(manifest.Compatibility.HelpArgs) == 0 ||
			!slices.Contains([]string{"native", "adapter", "custom"}, manifest.Integration) {
			return nil, errors.New("INVALID_ACP_MANIFEST")
		}
		seen[manifest.ID] = true
		manifests = append(manifests, manifest)
	}
	return manifests, nil
}

func agentRegistry() ([]nativeAgentDriver, error) {
	builtins, err := parseNativeACPManifests(agentassets.Builtins)
	if err != nil {
		return nil, err
	}
	drivers := slices.Clone(nativeAgentDrivers)
	for _, manifest := range builtins {
		drivers = append(drivers, manifest.driver())
	}
	manifestLookup := map[string]bool{}
	for _, driver := range drivers {
		if manifestLookup[driver.id] {
			return nil, errors.New("INVALID_OR_DUPLICATE_AGENT_ID")
		}
		manifestLookup[driver.id] = true
	}
	raw, err := os.ReadFile(filepath.Join(root(), "agents", "manifests.json"))
	if errors.Is(err, os.ErrNotExist) {
		return drivers, nil
	}
	if err != nil {
		return nil, err
	}
	local, err := parseNativeACPManifests(raw)
	if err != nil {
		return nil, err
	}
	for _, manifest := range local {
		if manifestLookup[manifest.ID] {
			return nil, errors.New("INVALID_OR_DUPLICATE_AGENT_ID")
		}
		drivers = append(drivers, manifest.driver())
	}
	return drivers, nil
}

func (manifest nativeACPManifest) driver() nativeAgentDriver {
	name := manifest.ID
	if manifest.DisplayName != nil {
		name = *manifest.DisplayName
	}
	return nativeAgentDriver{id: manifest.ID, name: name, protocol: manifest.Protocol, commands: append([]string{manifest.Command}, manifest.Aliases...),
		args: manifest.Args, manifest: &manifest}
}

func (driver nativeAgentDriver) descriptor() any {
	if driver.manifest != nil {
		return driver.manifest
	}
	integration := "native"
	if driver.id == "claude" {
		integration = "adapter"
	}
	return object{"displayName": driver.name, "integration": integration}
}

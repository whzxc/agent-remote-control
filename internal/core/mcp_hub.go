package core

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pelletier/go-toml/v2"
	"golang.org/x/net/http/httpguts"
)

const hubConnect = 30 * time.Second
const hubIdle = 600 * time.Second

var hubName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
var hubConnectionFields = []string{"command", "args", "env", "cwd", "url", "headers"}
var hubStoreLock sync.Mutex

type hubPool struct {
	sync.Mutex
	entries map[string]*hubLive
}

type hubLive struct {
	sync.Mutex
	revision uint64
	session  *mcpSession
	tools    []any
	listed   bool
	state    string
	failure  any
	observed any
	used     time.Time
}

func hubEnabled(requestSource) bool { return readPreferences()["mcp-services"] == "on" }

func hubDefaults(name string) object {
	return object{"name": name, "command": "", "args": []any{}, "env": object{}, "cwd": nil, "url": "", "headers": object{},
		"enabled": true, "toolTimeoutSeconds": nil, "revision": 0, "addedBy": nil}
}

func hubPath() string { return filepath.Join(root(), "mcp-hub.json") }

func loadHubLocked() ([]any, error) {
	value, err := load(hubPath())
	if errors.Is(err, os.ErrNotExist) {
		old := filepath.Join(root(), "mcp-services.json")
		legacy, err := load(old)
		if errors.Is(err, os.ErrNotExist) {
			return []any{}, nil
		}
		if err != nil {
			return nil, err
		}
		result := []any{}
		for _, value := range arr(legacy) {
			name := sanitizeHubName(text(value, "name"))
			for find(result, "name", name) != nil {
				name += "_"
			}
			row := hubDefaults(name)
			mergeHubFields(row, obj(value))
			row["revision"] = 1
			row["addedBy"] = object{"kind": "migration", "from": "mcp-services", "at": now()}
			result = append(result, row)
		}
		if err := storeHub(result); err != nil {
			return nil, err
		}
		if err := os.Remove(old); err != nil {
			return nil, fmt.Errorf("MCP_HUB_STORAGE: %w", err)
		}
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	stored, ok := field(value, "servers").([]any)
	if !ok {
		return nil, errors.New("MCP_HUB_CONFIG_INVALID: Inspect mcp-hub.json in the ARC state directory")
	}
	for i, row := range stored {
		if obj(row) == nil || text(row, "name") == "" || text(row, "transport") == "" {
			return nil, errors.New("MCP_HUB_CONFIG_INVALID: Inspect mcp-hub.json in the ARC state directory")
		}
		base := hubDefaults(text(row, "name"))
		maps.Copy(base, obj(row))
		stored[i] = base
	}
	return stored, nil
}

func loadHub() ([]any, error) {
	hubStoreLock.Lock()
	defer hubStoreLock.Unlock()
	return loadHubLocked()
}

func storeHub(rows []any) error { return save(hubPath(), object{"servers": rows}) }

func sanitizeHubName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' || r == '.' {
			return r
		}
		return '-'
	}, name)
	if name == "" || strings.ContainsRune("_-.", rune(name[0])) {
		name = "m" + name
	}
	return name[:min(len(name), 64)]
}

func validateHubServer(row object) error {
	if !hubName.MatchString(text(row, "name")) {
		return errors.New("MCP_INVALID_NAME: Use 1-64 characters from A-Z, a-z, 0-9, _, - and ., starting with a letter or digit")
	}
	switch text(row, "transport") {
	case "stdio":
		command := text(row, "command")
		if strings.TrimSpace(command) == "" || strings.ContainsRune(command, 0) || slices.ContainsFunc(stringValues(row["args"]), func(s string) bool { return strings.ContainsRune(s, 0) }) {
			return errors.New("MCP_INVALID_COMMAND: stdio servers need command (absolute path or a name on ARC's search path) and args without NUL characters")
		}
	case "http":
		endpoint, err := url.Parse(text(row, "url"))
		if err != nil {
			return errors.New("MCP_INVALID_URL: Use a complete HTTP(S) Streamable HTTP endpoint")
		}
		if (endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.Fragment != "" {
			return errors.New("MCP_INVALID_URL: Use an HTTP(S) endpoint without userinfo or fragments; put credentials in headers")
		}
		for name, value := range obj(row["headers"]) {
			managed := slices.Contains([]string{"host", "content-type", "accept", "mcp-session-id", "mcp-protocol-version"}, strings.ToLower(name))
			if managed || !httpguts.ValidHeaderFieldName(name) || !httpguts.ValidHeaderFieldValue(str(value)) {
				return errors.New("MCP_INVALID_HEADER: Use valid custom headers; ARC owns Host, Accept, Content-Type, session and protocol headers")
			}
		}
	default:
		return errors.New("MCP_INVALID_TRANSPORT: Use stdio or http (Streamable HTTP)")
	}
	for key, value := range obj(row["env"]) {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(str(value), 0) {
			return errors.New("MCP_INVALID_ENV: Correct the environment variable names and values")
		}
	}
	if cwd, exists := row["cwd"].(string); exists && !filepath.IsAbs(cwd) {
		return errors.New("MCP_INVALID_CWD: cwd must be an absolute directory")
	}
	if sec, exists := uintValue(row["toolTimeoutSeconds"]); exists && (sec == 0 || sec > 600) {
		return errors.New("MCP_INVALID_TIMEOUT: toolTimeoutSeconds must be 1-600")
	}
	return nil
}

func mergeHubFields(row, change object) {
	for _, key := range append(slices.Clone(hubConnectionFields), "transport", "toolTimeoutSeconds") {
		if value, exists := change[key]; exists {
			row[key] = value
		}
	}
}

func (p *hubPool) entry(name string) *hubLive {
	p.Lock()
	defer p.Unlock()
	if p.entries == nil {
		p.entries = make(map[string]*hubLive)
	}
	if p.entries[name] == nil {
		p.entries[name] = &hubLive{}
	}
	return p.entries[name]
}

func (p *hubPool) forget(name string) {
	p.Lock()
	entry := p.entries[name]
	delete(p.entries, name)
	p.Unlock()
	if entry == nil {
		return
	}
	entry.Lock()
	defer entry.Unlock()
	if entry.session != nil {
		entry.session.close()
		entry.session = nil
	}
}

func (p *hubPool) names() []string {
	p.Lock()
	defer p.Unlock()
	var names []string
	for name := range p.entries {
		names = append(names, name)
	}
	return names
}

func (p *hubPool) restore(ctx context.Context) {
	if hubEnabled(requestSource{}) {
		if rows, err := loadHub(); err == nil {
			p.discover(ctx, rows, false)
		}
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	defer func() {
		for _, name := range p.names() {
			p.forget(name)
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			for _, name := range p.names() {
				entry := p.entry(name)
				if !entry.TryLock() {
					continue
				}
				if entry.session != nil && !entry.used.IsZero() && time.Since(entry.used) > hubIdle {
					entry.session.close()
					entry.session = nil
					entry.used = time.Time{}
				}
				entry.Unlock()
			}
		}
	}
}

func hubReconnectable(err error) bool {
	if err == nil {
		return false
	}
	for _, code := range []string{"MCP_STDIO_CLOSED", "MCP_SESSION_CLOSED", "MCP_HTTP_404", "MCP_CONNECTION_LOST"} {
		if strings.HasPrefix(err.Error(), code) {
			return true
		}
	}
	return false
}

func hubListTools(ctx context.Context, session *mcpSession) ([]any, error) {
	tools := []any{}
	params := object{}
	seen := map[string]bool{}
	for {
		wait, cancel := context.WithTimeout(ctx, hubConnect)
		value, err := session.request(wait, "tools/list", params)
		cancel()
		if err != nil {
			return nil, err
		}
		page, ok := field(value, "tools").([]any)
		if !ok {
			return nil, errors.New("MCP_INVALID_TOOLS: tools/list must return a tools array")
		}
		tools = append(tools, page...)
		cursor := field(value, "nextCursor")
		if cursor == nil || len(tools) > 2000 {
			return tools, nil
		}
		key := wire(cursor)
		if seen[key] {
			return nil, errors.New("MCP_CURSOR_REPEATED: The server repeated a tools/list cursor")
		}
		seen[key] = true
		params["cursor"] = cursor
	}
}

func (p *hubPool) ensure(ctx context.Context, row object, refresh bool) (*mcpSession, error) {
	live := p.entry(text(row, "name"))
	live.Lock()
	defer live.Unlock()
	revision := uintOr(row["revision"], 0)
	if live.revision != revision {
		if live.session != nil {
			live.session.close()
		}
		live.session, live.tools, live.state, live.failure, live.observed = nil, nil, "", nil, nil
		live.listed = false
		live.revision = revision
	}
	fail := func(err error) (*mcpSession, error) {
		live.state = "failed"
		live.failure = err.Error()
		live.observed = now()
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		reused := live.session != nil && live.session.alive()
		if !reused {
			wait, cancel := context.WithTimeout(ctx, hubConnect)
			session, err := openMCP(wait, row)
			cancel()
			if err != nil {
				return fail(err)
			}
			live.session = session
		}
		session := live.session
		if refresh || !live.listed || session.stale.Swap(false) {
			tools, err := hubListTools(ctx, session)
			if err != nil {
				session.close()
				live.session = nil
				if reused && attempt == 0 && hubReconnectable(err) {
					continue
				}
				return fail(err)
			}
			live.tools, live.listed, live.observed = tools, true, now()
		}
		live.state, live.failure, live.used = "ready", nil, time.Now()
		return session, nil
	}
	return fail(errors.New("MCP_SESSION_CLOSED: Retry the request"))
}

func (p *hubPool) discover(ctx context.Context, rows []any, refresh bool) {
	var jobs sync.WaitGroup
	for _, entry := range rows {
		row := obj(entry)
		if row["enabled"] == false {
			continue
		}
		live := p.entry(text(row, "name"))
		listed := false
		if live.TryLock() {
			listed = live.listed && live.revision == uintOr(row["revision"], 0)
			live.Unlock()
		}
		if refresh || !listed {
			jobs.Go(func() { _, _ = p.ensure(ctx, row, refresh) })
		}
	}
	jobs.Wait()
}

func compactHubTool(tool any) object {
	description := strings.Join(strings.Fields(text(tool, "description")), " ")
	first, _, _ := strings.Cut(description, ". ")
	runes := []rune(first)
	if len(runes) > 160 {
		first = string(runes[:160]) + "…"
	}
	result := object{"name": field(tool, "name"), "description": first}
	switch {
	case field(field(tool, "annotations"), "readOnlyHint") == true:
		result["readOnly"] = true
	case field(field(tool, "annotations"), "destructiveHint") == true:
		result["destructive"] = true
	}
	return result
}

func (p *hubPool) status(row object, compact bool) object {
	var command, endpoint any
	if row["transport"] == "stdio" {
		command = row["command"]
	}
	if candidate, err := url.Parse(text(row, "url")); err == nil && candidate.IsAbs() {
		candidate.RawQuery, candidate.Fragment, candidate.ForceQuery = "", "", false
		endpoint = candidate.String()
	}
	result := object{"name": row["name"], "transport": row["transport"], "enabled": row["enabled"], "revision": row["revision"],
		"command": command, "endpoint": endpoint, "envNames": keys(obj(row["env"])), "headerNames": keys(obj(row["headers"])), "addedBy": row["addedBy"]}
	if row["enabled"] == false {
		result["state"] = "disabled"
		return result
	}
	entry := p.entry(text(row, "name"))
	if !entry.TryLock() {
		result["state"] = "connecting"
		return result
	}
	defer entry.Unlock()
	current := entry.revision == uintOr(row["revision"], 0)
	state := entry.state
	if !current || state == "" {
		state = "unchecked"
	} else if state == "ready" && (entry.session == nil || !entry.session.alive()) {
		state = "idle"
	}
	result["state"] = state
	if current {
		result["observedAt"], result["error"] = entry.observed, entry.failure
		if entry.listed {
			tools := make([]any, 0, len(entry.tools))
			for _, tool := range entry.tools {
				if compact {
					tools = append(tools, compactHubTool(tool))
				} else {
					tools = append(tools, tool)
				}
			}
			result["tools"], result["toolCount"] = tools, len(tools)
		}
	}
	return result
}

func hubNext(op string, args object) object {
	return object{"via": via(operation(op)), "op": op, "args": args}
}
func hubFailure(message string, next object) object {
	code, _, _ := strings.Cut(message, ":")
	return object{"state": "failed", "error": object{"code": code, "message": message}, "next": next}
}
func hubUnknown(name string) object {
	return hubFailure(fmt.Sprintf("MCP_SERVER_UNKNOWN: No hub server named %q", name), hubNext("mcp_tools", object{}))
}

func (p *hubPool) tools(ctx context.Context, args object) (object, error) {
	rows, err := loadHub()
	if err != nil {
		return nil, err
	}
	name, named := args["server"].(string)
	if named {
		row := find(rows, "name", name)
		if row == nil {
			return hubUnknown(name), nil
		}
		rows = []any{row}
	}
	p.discover(ctx, rows, args["refresh"] == true)
	if named {
		row := p.status(obj(rows[0]), false)
		if tool, specific := args["tool"].(string); specific {
			entry := p.entry(name)
			entry.Lock()
			defer entry.Unlock()
			if definition := find(entry.tools, "name", tool); definition != nil {
				return object{"server": name, "tool": definition, "observedAt": entry.observed,
					"next": hubNext("mcp_call", object{"server": name, "tool": tool, "arguments": object{}})}, nil
			}
			return hubFailure(fmt.Sprintf("MCP_TOOL_UNKNOWN: %s has no tool %q", name, tool), hubNext("mcp_tools", object{"server": name, "refresh": true})), nil
		}
		return row, nil
	}
	servers := make([]any, 0, len(rows))
	next := hubNext("mcp_tools", object{"refresh": true})
	next["hint"] = "No tools discovered; inspect each server state and error"
	for _, entry := range rows {
		servers = append(servers, p.status(obj(entry), true))
	}
	if len(servers) == 0 {
		next = hubNext("mcp_configure", object{"action": "import", "from": "codex"})
		next["hint"] = "Import the user's existing MCP servers, or add one with action:add"
	} else {
		for _, server := range servers {
			if tools := arr(field(server, "tools")); len(tools) > 0 {
				next = hubNext("mcp_tools", object{"server": field(server, "name"), "tool": field(tools[0], "name")})
				next["hint"] = "Read a tool's inputSchema with server and tool before calling it with mcp_call"
				break
			}
		}
	}
	return object{"servers": servers, "observedAt": now(), "next": next}, nil
}

func (p *hubPool) call(ctx context.Context, args object) (object, error) {
	name, tool := text(args, "server"), text(args, "tool")
	rows, err := loadHub()
	if err != nil {
		return hubFailure(err.Error(), object{"op": nil, "hint": "Ask the user to inspect the ARC MCP hub configuration"}), nil
	}
	row := find(rows, "name", name)
	if row == nil {
		return hubUnknown(name), nil
	}
	if row["enabled"] == false {
		return hubFailure("MCP_SERVER_DISABLED: "+name+" is disabled in the hub", hubNext("mcp_configure", object{"action": "enable", "name": name})), nil
	}
	retry := hubNext("mcp_tools", object{"server": name, "refresh": true})
	session, err := p.ensure(ctx, row, false)
	if err != nil {
		return hubFailure(err.Error(), retry), nil
	}
	known := func() bool {
		entry := p.entry(name)
		entry.Lock()
		defer entry.Unlock()
		return find(entry.tools, "name", tool) != nil
	}
	if !known() {
		session, err = p.ensure(ctx, row, true)
		if err != nil {
			return hubFailure(err.Error(), retry), nil
		}
		if !known() {
			return hubFailure(fmt.Sprintf("MCP_TOOL_UNKNOWN: %s has no tool %q", name, tool), hubNext("mcp_tools", object{"server": name})), nil
		}
	}
	timeout := min(uintOr(args["timeoutMs"], uintOr(row["toolTimeoutSeconds"], 120)*1000), 600000)
	arguments := obj(args["arguments"])
	if arguments == nil {
		arguments = object{}
	}
	wait, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	value, err := session.request(wait, "tools/call", object{"name": tool, "arguments": arguments})
	cancel()
	entry := p.entry(name)
	entry.Lock()
	entry.used = time.Now()
	if hubReconnectable(err) && entry.session == session {
		session.close()
		entry.session = nil
	}
	entry.Unlock()
	if err != nil {
		next := hubNext("mcp_tools", object{"server": name})
		next["hint"] = "The downstream outcome is unknown. Read downstream state before retrying a side effect"
		return hubFailure(err.Error(), next), nil
	}
	result := object{"server": name, "tool": tool, "isError": field(value, "isError") == true, "content": field(value, "content"), "observedAt": now()}
	for _, key := range []string{"structuredContent", "_meta"} {
		if value, ok := obj(value)[key]; ok {
			result[key] = value
		}
	}
	return result, nil
}

func hubAttribution(source requestSource) object {
	kind := "local"
	if _, known := source.origin["sourceId"].(string); known {
		kind = "source"
	}
	return object{"kind": kind, "sourceId": source.origin["sourceId"], "sourceLabel": source.origin["sourceLabel"], "at": now()}
}

func (p *hubPool) configure(ctx context.Context, args object, source requestSource) (object, error) {
	action, name := text(args, "action"), text(args, "name")
	if action == "import" {
		return hubImport(args, source)
	}
	row, detail, err := changeHub(args, source)
	if err != nil || detail != nil {
		return detail, err
	}
	if action == "remove" {
		p.forget(name)
		return object{"removed": name, "observedAt": now()}, nil
	}
	if action == "disable" {
		p.forget(name)
		return object{"server": p.status(row, true)}, nil
	}
	_, err = p.ensure(ctx, row, true)
	result := object{"server": p.status(row, true)}
	if err != nil {
		next := hubNext("mcp_configure", object{"action": "update", "name": name})
		next["hint"] = "Saved but not connected: " + err.Error()
		result["next"] = next
	}
	return result, nil
}

func changeHub(args object, source requestSource) (row, detail object, err error) {
	hubStoreLock.Lock()
	defer hubStoreLock.Unlock()
	rows, err := loadHubLocked()
	if err != nil {
		return nil, nil, err
	}
	action, name := text(args, "action"), text(args, "name")
	index := slices.IndexFunc(rows, func(row any) bool { return text(row, "name") == name })
	if index >= 0 {
		row = obj(rows[index])
		if expected, ok := uintValue(args["expectedRevision"]); ok && expected != uintOr(row["revision"], 0) {
			return nil, hubFailure(fmt.Sprintf("MCP_CONFIG_CHANGED: %s is at revision %d", name, uintOr(row["revision"], 0)), hubNext("mcp_tools", object{"server": name})), nil
		}
	}
	switch action {
	case "add":
		if index >= 0 {
			return nil, hubFailure("MCP_SERVER_EXISTS: "+name+" is already in the hub", hubNext("mcp_configure", object{"action": "update", "name": name})), nil
		}
		row = hubDefaults(name)
		row["addedBy"] = hubAttribution(source)
		mergeHubFields(row, args)
	case "update", "enable", "disable", "remove":
		if index < 0 {
			return nil, hubUnknown(name), nil
		}
		if action == "remove" {
			return row, nil, storeHub(slices.Delete(rows, index, index+1))
		}
		if action == "update" {
			if transport, ok := args["transport"]; ok && transport != row["transport"] {
				base := hubDefaults(name)
				for _, key := range hubConnectionFields {
					row[key] = base[key]
				}
			}
			mergeHubFields(row, args)
		} else {
			row["enabled"] = action == "enable"
		}
	default:
		return nil, nil, errors.New("INVALID_ARGUMENT: action must be add, update, remove, enable, disable or import")
	}
	row["revision"] = uintOr(row["revision"], 0) + 1
	if err := validateHubServer(row); err != nil {
		return nil, nil, err
	}
	if index < 0 {
		rows = append(rows, row)
	}
	return row, nil, storeHub(rows)
}

func hubImport(args object, source requestSource) (object, error) {
	from := text(args, "from")
	profile, err := hubNativeProfile(from)
	if err != nil {
		return hubFailure(err.Error(), hubNext("guide", object{"op": "mcp_configure"})), nil
	}
	hubStoreLock.Lock()
	defer hubStoreLock.Unlock()
	servers, err := loadHubLocked()
	if err != nil {
		return nil, err
	}
	imported, skipped := []string{}, []any{}
	for _, native := range keys(profile) {
		if names := arr(args["names"]); names != nil && !slices.Contains(names, any(native)) {
			continue
		}
		server, err := hubImportServer(from, native, obj(profile[native]))
		if err == nil && find(servers, "name", text(server, "name")) != nil {
			err = errors.New("A hub server with this name exists")
		}
		if err == nil {
			err = validateHubServer(server)
		}
		if err != nil {
			skipped = append(skipped, object{"name": native, "reason": err.Error()})
			continue
		}
		server["revision"] = 1
		server["addedBy"] = object{"kind": "import", "from": from, "by": hubAttribution(source), "at": now()}
		servers = append(servers, server)
		imported = append(imported, text(server, "name"))
	}
	if err := storeHub(servers); err != nil {
		return nil, err
	}
	next := hubNext("mcp_tools", object{})
	next["hint"] = "Listing connects imported servers and discovers their tools"
	return object{"from": from, "imported": imported, "skipped": skipped, "observedAt": now(), "next": next}, nil
}

func hubNativeProfile(from string) (object, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, errors.New("MCP_IMPORT_UNAVAILABLE: Home directory unavailable")
	}
	var path string
	switch from {
	case "codex":
		config, err := nativeCodexHome()
		if err != nil {
			return nil, err
		}
		path = filepath.Join(config, "config.toml")
	case "claude":
		config, ok := os.LookupEnv("CLAUDE_CONFIG_DIR")
		if !ok {
			config = home
		}
		path = filepath.Join(config, ".claude.json")
	case "cursor":
		path = filepath.Join(home, ".cursor/mcp.json")
	case "gemini":
		path = filepath.Join(home, ".gemini/settings.json")
	default:
		return nil, errors.New("INVALID_ARGUMENT: from must be codex, claude, cursor or gemini")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("MCP_IMPORT_NOT_FOUND: %s is not readable", path)
	}
	var value object
	if from == "codex" {
		if err := toml.Unmarshal(data, &value); err != nil {
			return nil, errors.New("MCP_IMPORT_INVALID: config.toml is not valid TOML")
		}
		return obj(value["mcp_servers"]), nil
	}
	if err := decodeObject(data, &value); err != nil {
		return nil, errors.New("MCP_IMPORT_INVALID: The profile is not valid JSON")
	}
	return obj(value["mcpServers"]), nil
}

func hubImportServer(from, name string, source object) (object, error) {
	row := hubDefaults(sanitizeHubName(name))
	mergeHubFields(row, source)
	endpoint := text(source, "url")
	switch from {
	case "codex":
		headers := maps.Clone(obj(source["http_headers"]))
		if headers == nil {
			headers = object{}
		}
		if variable, ok := source["bearer_token_env_var"].(string); ok {
			token, exists := os.LookupEnv(variable)
			if !exists {
				return nil, fmt.Errorf("%s is not set in ARC's environment; add an Authorization header with mcp_configure update", variable)
			}
			headers["Authorization"] = "Bearer " + token
		}
		for header, key := range obj(source["env_http_headers"]) {
			token, exists := os.LookupEnv(str(key))
			if !exists {
				return nil, fmt.Errorf("%s is not set in ARC's environment; add the %s header with mcp_configure update", key, header)
			}
			headers[header] = token
		}
		row["headers"] = headers
		row["enabled"] = source["enabled"] != false
		if raw, ok := source["tool_timeout_sec"]; ok {
			value, _ := strconv.ParseFloat(fmt.Sprint(raw), 64)
			row["toolTimeoutSeconds"] = uint64(min(max(math.Ceil(value), 1), 600))
		}
	default:
		_, legacyURL := source["url"].(string)
		if source["type"] == "sse" || from == "gemini" && legacyURL {
			return nil, errors.New("Legacy SSE servers are not supported; add the server's Streamable HTTP endpoint")
		}
		if httpURL, ok := source["httpUrl"].(string); ok {
			endpoint = httpURL
		}
		row["enabled"] = source["disabled"] != true
	}
	row["url"] = endpoint
	row["transport"] = "stdio"
	if endpoint != "" {
		row["transport"] = "http"
	}
	return row, nil
}

func init() {
	registerOperation("mcp_tools", func(ctx context.Context, r operationRequest) (any, error) { return r.service.hub.tools(ctx, r.args) }, hubEnabled)
	registerOperation("mcp_call", func(ctx context.Context, r operationRequest) (any, error) { return r.service.hub.call(ctx, r.args) }, hubEnabled)
	registerOperation("mcp_configure", func(ctx context.Context, r operationRequest) (any, error) {
		return r.service.hub.configure(ctx, r.args, r.source)
	}, hubEnabled)
	registerRoute("GET", "mcp-hub", func(_ context.Context, s *service, _ object, _ []string) (any, error) {
		rows, err := loadHub()
		if err != nil {
			return nil, err
		}
		servers := []any{}
		for _, row := range rows {
			servers = append(servers, s.hub.status(obj(row), true))
		}
		return object{"enabled": hubEnabled(requestSource{}), "servers": servers, "observedAt": now()}, nil
	})
	registerRoute("POST", "mcp-hub/configure", func(ctx context.Context, s *service, args object, _ []string) (any, error) {
		if args["action"] == "refresh" {
			return s.hub.tools(ctx, object{"server": args["name"], "refresh": true})
		}
		return s.hub.configure(ctx, args, requestSource{})
	})
	registerManagementCatalog(func(result object) {
		var specs []any
		const raw = `[{"name":"mcp-hub.list","method":"GET","route":"mcp-hub","localOnly":true,"description":"Read hub servers with observed state and tool names. Starts no connection.","inputSchema":{"type":"object","properties":{},"additionalProperties":false}},{"name":"mcp-hub.configure","method":"POST","route":"mcp-hub/configure","localOnly":true,"description":"Enable, disable, remove or refresh one hub server with local authority.","inputSchema":{"type":"object","required":["body"],"additionalProperties":false,"properties":{"body":{"type":"object","required":["action","name"],"additionalProperties":false,"properties":{"action":{"enum":["enable","disable","remove","refresh"]},"name":{"type":"string"}}}}}}]`
		if err := unmarshalJSON([]byte(raw), &specs); err != nil {
			panic(err)
		}
		result["operations"] = append(arr(result["operations"]), specs...)
	})
	registerServiceStartup(func(ctx context.Context, s *service) error { go s.hub.restore(ctx); return nil })
}

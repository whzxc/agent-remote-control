package core

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
)

type contextProviderConfig struct {
	Command string
	Args    []string
	Env     map[string]string
	CWD     string
}

func readContextProviderConfig() (*contextProviderConfig, error) {
	data, err := os.ReadFile(filepath.Join(root(), "context-provider.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config *contextProviderConfig
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("INVALID_CONTEXT_PROVIDER: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, errors.New("INVALID_CONTEXT_PROVIDER: trailing characters")
	}
	if config != nil && strings.TrimSpace(config.Command) == "" {
		return nil, errors.New("INVALID_CONTEXT_PROVIDER: command must be nonempty")
	}
	return config, nil
}

func contextProviderConfigured() bool {
	config, err := readContextProviderConfig()
	return err == nil && config != nil
}

func contextProviderCommand(ctx context.Context) (*exec.Cmd, error) {
	config, err := readContextProviderConfig()
	if err != nil {
		return nil, err
	}
	if config == nil {
		return nil, errors.New("CONTEXT_PROVIDER_NOT_CONFIGURED")
	}
	cmd := exec.CommandContext(ctx, config.Command, config.Args...)
	cmd.Dir = config.CWD
	cmd.Env = cmd.Environ()
	for key, value := range config.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd, nil
}

func contextProviderStdio(ctx context.Context, stdin io.Reader, stdout, stderr io.Writer) error {
	cmd, err := contextProviderCommand(ctx)
	if err != nil {
		return err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return fmt.Errorf("CONTEXT_PROVIDER_EXIT: %s", exit.ProcessState)
		}
		return err
	}
	return nil
}

func responseFromProvider(output *bufio.Scanner, input io.Writer, replyID uint64) (any, error) {
	for output.Scan() {
		var message object
		if err := canonjson.Unmarshal(output.Bytes(), &message); err != nil {
			return nil, err
		}
		if _, request := message["method"]; request {
			if id, ok := message["id"]; ok {
				reply := object{"jsonrpc": "2.0", "id": id}
				if message["method"] == "ping" {
					reply["result"] = object{}
				} else {
					reply["error"] = object{"code": -32601, "message": "Client capability not supported"}
				}
				if err := outputLine(input, wire(reply)); err != nil {
					return nil, err
				}
			}
			continue
		}
		if uintOr(message["id"], 0) == replyID {
			if rpcError, ok := message["error"]; ok {
				return nil, fmt.Errorf("CONTEXT_PROVIDER_RPC_ERROR: %s", wire(rpcError))
			}
			if result, ok := message["result"]; ok {
				return result, nil
			}
			return nil, errors.New("CONTEXT_PROVIDER_INVALID_RESPONSE")
		}
	}
	if err := output.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("CONTEXT_PROVIDER_CLOSED")
}

func runContextProvider(input io.Writer, output io.Reader, name string, args object) (any, error) {
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 8192), 4*1024*1024)
	write := func(frame object) error {
		frame["jsonrpc"] = "2.0"
		_, err := io.WriteString(input, wire(frame)+"\n")
		return err
	}
	if err := write(object{"id": 1, "method": "initialize", "params": object{"protocolVersion": "2025-06-18",
		"capabilities": object{}, "clientInfo": object{"name": "arc-context-provider", "version": buildVersion}}}); err != nil {
		return nil, err
	}
	initialized, err := responseFromProvider(scanner, input, 1)
	if err != nil {
		return nil, err
	}
	versions := []string{"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
	if !slices.Contains(versions, text(initialized, "protocolVersion")) {
		return nil, errors.New("CONTEXT_PROVIDER_UNSUPPORTED_PROTOCOL")
	}
	if err := write(object{"method": "notifications/initialized"}); err != nil {
		return nil, err
	}
	if err := write(object{"id": 2, "method": "tools/call", "params": object{"name": name, "arguments": args}}); err != nil {
		return nil, err
	}
	result, err := responseFromProvider(scanner, input, 2)
	if err != nil {
		return nil, err
	}
	if field(result, "isError") == true {
		return nil, fmt.Errorf("CONTEXT_PROVIDER_TOOL_ERROR: %s", wire(field(result, "content")))
	}
	if value, ok := obj(result)["structuredContent"]; ok {
		return value, nil
	}
	var blocks []string
	for _, block := range arr(field(result, "content")) {
		if field(block, "type") == "text" {
			blocks = append(blocks, text(block, "text"))
		}
	}
	var parsed any
	if err := canonjson.Unmarshal([]byte(strings.Join(blocks, "\n")), &parsed); err != nil {
		return nil, fmt.Errorf("CONTEXT_PROVIDER_INVALID_RESULT: %w", err)
	}
	return parsed, nil
}

func callContextProvider(parent context.Context, name string, args object, timeout time.Duration) (any, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd, err := contextProviderCommand(ctx)
	if err != nil {
		return nil, err
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return nil, err
	}
	if err := startOwnedChild(cmd); err != nil {
		input.Close()
		output.Close()
		return nil, fmt.Errorf("CONTEXT_PROVIDER_START_FAILED: %w", err)
	}
	result, err := runContextProvider(input, output, name, args)
	deadline := ctx.Err()
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	if deadline == context.DeadlineExceeded {
		return nil, fmt.Errorf("CONTEXT_PROVIDER_TIMEOUT: %dms; read current provider state before retrying a write", timeout.Milliseconds())
	}
	return result, err
}

func contextProviderACPServer() (object, error) {
	config, err := readContextProviderConfig()
	if err != nil || config == nil {
		return nil, err
	}
	binary, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return object{"name": "context-provider", "command": binary, "args": []string{"context-provider-stdio"},
		"env": []object{{"name": "ARC_STATE_DIR", "value": root()}}}, nil
}

func providerOperation(ctx context.Context, request operationRequest) (any, error) {
	timeout := 10 * time.Second
	if request.name == "context_amend" || request.name == "context_check" {
		timeout = 120 * time.Second
	}
	return callContextProvider(ctx, strings.TrimPrefix(request.name, "context_"), request.args, timeout)
}

func init() {
	for _, name := range []string{"context_resolve", "context_search", "context_read", "context_check", "context_amend"} {
		registerOperation(name, providerOperation, nil)
	}
}

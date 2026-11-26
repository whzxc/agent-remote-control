package core

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const primaryCodexProfile = "codex-home"

var codexHostProfile = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// The account lane supplies the single native primary home resolver.
var resolveNativeCodexHome func() (string, error)
var codexDesktopAttached func(context.Context) bool

func codexPrimaryHome() (string, error) {
	if resolveNativeCodexHome == nil {
		return "", errors.New(PortPending)
	}
	return resolveNativeCodexHome()
}

func codexHostLocation(profile, suffix string) (string, error) {
	if !codexHostProfile.MatchString(profile) {
		return "", errors.New("INVALID_ARGUMENT: Codex profile")
	}
	return filepath.Join(root(), "codex-app-server", profile+suffix), nil
}

func loadCodexHost(profile string) (object, error) {
	path, err := codexHostLocation(profile, ".json")
	if err != nil {
		return nil, err
	}
	value, err := load(path)
	return obj(value), err
}

func codexBinaryStamp(binary string) any {
	info, err := os.Stat(binary)
	if err != nil {
		return nil
	}
	var modified any
	if at := info.ModTime(); at.Unix() >= 0 {
		modified = strconv.FormatUint(uint64(at.Unix())*uint64(time.Second)+uint64(at.Nanosecond()), 10)
	}
	return object{"path": binary, "len": info.Size(), "modified": modified}
}

func codexHostPID(record object) int {
	pid := uintOr(record["pid"], 0)
	start := text(record, "processStart")
	if pid <= 2147483647 && pid != 0 && start != "" && detachedHostAlive(int(pid)) && platform.ProcessStart(int(pid)) == start {
		return int(pid)
	}
	return 0
}

func codexHostRunning(profile string) bool {
	record, _ := loadCodexHost(profile)
	return codexHostPID(record) != 0
}

func codexRunningHosts() []object {
	entries, _ := os.ReadDir(filepath.Join(root(), "codex-app-server"))
	hosts := []object{}
	for _, entry := range entries {
		profile, ok := strings.CutSuffix(entry.Name(), ".json")
		if ok {
			record, _ := loadCodexHost(profile)
			if codexHostPID(record) != 0 {
				hosts = append(hosts, record)
			}
		}
	}
	return hosts
}

func codexHostExecutables() []string {
	hosts := codexRunningHosts()
	executables := make([]string, 0, len(hosts))
	for _, record := range hosts {
		if name, ok := record["executable"].(string); ok {
			executables = append(executables, name)
		}
	}
	return executables
}

func stopAllCodexHosts(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(root(), "codex-app-server"))
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if profile, ok := strings.CutSuffix(entry.Name(), ".json"); ok {
			if err := stopCodexHost(ctx, profile); err != nil {
				return err
			}
		}
	}
	return nil
}

func deleteCodexHost(profile string) error {
	for _, suffix := range []string{".json", ".sock"} {
		path, err := codexHostLocation(profile, suffix)
		if err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func stopCodexHost(_ context.Context, profile string) error {
	record, err := loadCodexHost(profile)
	if err == nil {
		if pid := codexHostPID(record); pid != 0 {
			platform.SignalTree(pid, false)
			deadline := time.Now().Add(5 * time.Second)
			for codexHostPID(record) == pid {
				if time.Now().After(deadline) {
					if codexHostPID(record) == pid {
						platform.SignalTree(pid, true)
					}
					break
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
	}
	return deleteCodexHost(profile)
}

func codexRPCHost(profile, binary string, record object, pid int, adopted bool) *rpcHost {
	return &rpcHost{
		socket: text(record, "socket"), startedAt: text(record, "startedAt"), processStart: text(record, "processStart"),
		pid: pid, inheritedNoFile: obj(record["inheritedNofile"]), adopted: adopted,
		outdated: adopted && wire(record["binary"]) != wire(codexBinaryStamp(binary)),
		running:  func() bool { return codexHostPID(record) == pid },
		stop: func(ctx context.Context) error {
			current, _ := loadCodexHost(profile)
			if codexHostPID(current) == pid && current["processStart"] == record["processStart"] {
				return stopCodexHost(ctx, profile)
			}
			return nil
		},
	}
}

func indexedHostSpawn(command *exec.Cmd, spec object) error {
	if operatingSystem == "windows" {
		breakaway := exec.Command(command.Path, command.Args[1:]...)
		breakaway.Env, breakaway.Dir, breakaway.Stderr = command.Env, command.Dir, command.Stderr
		started, err := indexDetachedHost(breakaway, spec, true)
		if started || err == nil {
			return err
		}
	}
	_, err := indexDetachedHost(command, spec, false)
	return err
}

func indexDetachedHost(command *exec.Cmd, spec object, breakaway bool) (bool, error) {
	input, err := command.StdinPipe()
	if err != nil {
		return false, err
	}
	defer input.Close()
	output, err := command.StdoutPipe()
	if err != nil {
		return false, err
	}
	defer output.Close()
	if err := startDetachedAgentHost(command, breakaway); err != nil {
		return false, fmt.Errorf("CODEX_HOST_START_FAILED: %w", err)
	}
	start := time.NewTimer(10 * time.Second)
	defer start.Stop()
	result := make(chan error, 1)
	go func() {
		if err := outputLine(input, wire(spec)); err != nil {
			result <- err
			return
		}
		if err := input.Close(); err != nil {
			result <- err
			return
		}
		line, err := bufio.NewReader(output).ReadString('\n')
		if err == nil || errors.Is(err, io.EOF) {
			if line != "indexed\n" {
				err = errors.New("CODEX_HOST_START_FAILED: launcher did not publish its index")
			}
		}
		result <- err
	}()
	select {
	case err = <-result:
	case <-start.C:
		err = errors.New("timed out waiting on channel")
	}
	if err != nil {
		platform.SignalTree(command.Process.Pid, true)
		_ = command.Process.Kill()
		_ = command.Wait()
		return true, err
	}
	go func() { _ = command.Wait() }()
	return true, nil
}

func codexHostScope(profile string) []string {
	if operatingSystem != "linux" {
		return nil
	}
	if _, exists := os.LookupEnv("INVOCATION_ID"); !exists {
		return nil
	}
	for _, binary := range []string{"/usr/bin/systemd-run", "/bin/systemd-run"} {
		if info, err := os.Stat(binary); err == nil && info.Mode().IsRegular() {
			return []string{binary, "--user", "--scope", "--quiet", "--collect", "--unit", "arc-codex-" + profile + "-" + id()[:8], "--"}
		}
	}
	return nil
}

func spawnCodexHost(binary, profile, socket string, scope []string) error {
	executable, err := taskHostExecutable()
	if err != nil {
		return err
	}
	logPath, err := codexHostLocation(profile, ".log")
	if err != nil {
		return err
	}
	log, err := os.Create(logPath)
	if err != nil {
		return err
	}
	defer log.Close()
	argv := append(append([]string{}, scope...), executable, "codex-host")
	command := exec.Command(argv[0], argv[1:]...)
	command.Env = append(command.Environ(), "ARC_STATE_DIR="+root())
	command.Stderr = log
	var creatorStart any
	if value := platform.ProcessStart(os.Getpid()); value != "" {
		creatorStart = value
	}
	record := object{"profile": profile, "socket": socket, "binary": codexBinaryStamp(binary), "startedAt": now(),
		"inheritedNofile": inheritedResourceLimits(), "creatorPid": os.Getpid(), "creatorStart": creatorStart, "executable": executable}
	if err := indexedHostSpawn(command, object{"binary": binary, "record": record}); err != nil {
		if record, readErr := loadCodexHost(profile); readErr == nil {
			if pid := codexHostPID(record); pid != 0 {
				platform.SignalTree(pid, true)
			}
		}
		return err
	}
	return nil
}

func codexHostReachable(ctx context.Context, binary, socket string) bool {
	wait, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if operatingSystem != "windows" {
		socket, err := filepath.EvalSymlinks(socket)
		if err != nil {
			return false
		}
		connection, err := (&net.Dialer{}).DialContext(wait, "unix", socket)
		if err != nil {
			return false
		}
		_ = connection.Close()
		return true
	}
	child := exec.CommandContext(wait, binary, "app-server", "proxy", "--sock", socket)
	platform.OwnChild(child)
	input, err := child.StdinPipe()
	if err != nil {
		return false
	}
	defer input.Close()
	output, err := child.StdoutPipe()
	if err != nil {
		return false
	}
	defer output.Close()
	if err := startOwnedChild(child); err != nil {
		return false
	}
	defer func() {
		_ = child.Process.Kill()
		_ = child.Wait()
	}()
	conn, err := rpcProxyHandshake(wait, input, output)
	if err == nil {
		_ = conn.CloseNow()
	}
	return err == nil
}

func attachCodexHost(ctx context.Context, binary string, launches *launches) (*rpcHost, error) {
	profile := primaryCodexProfile
	socket, err := codexHostLocation(profile, ".sock")
	if err != nil {
		return nil, err
	}
	record, _ := loadCodexHost(profile)
	if pid := codexHostPID(record); pid != 0 {
		if err := launches.run(func() error { return nil }); err != nil {
			return nil, err
		}
		return codexRPCHost(profile, binary, record, pid, true), nil
	}
	if err := platform.PrivateDir(filepath.Dir(socket)); err != nil {
		return nil, err
	}
	if err := deleteCodexHost(profile); err != nil {
		return nil, err
	}
	attempts := [][]string{nil}
	if scope := codexHostScope(profile); scope != nil {
		attempts = [][]string{scope, nil}
	}
	var failure error
	for _, scope := range attempts {
		err := launches.run(func() error { return spawnCodexHost(binary, profile, socket, scope) })
		if err != nil {
			failure = err
			if scope != nil {
				recordLog("WARN", "Codex scope unavailable; using direct detachment: "+err.Error(), nil)
			}
			continue
		}
		deadline := time.Now().Add(20 * time.Second)
		for {
			if err := launches.run(func() error { return nil }); err != nil {
				return nil, err
			}
			if codexHostReachable(ctx, binary, socket) {
				record, err := loadCodexHost(profile)
				if err != nil {
					return nil, err
				}
				if pid := codexHostPID(record); pid != 0 {
					return codexRPCHost(profile, binary, record, pid, false), nil
				}
			}
			if !codexHostRunning(profile) || time.Now().After(deadline) {
				break
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
		}
		if err := stopCodexHost(ctx, profile); err != nil {
			return nil, err
		}
		failure = errors.New("CODEX_HOST_START_FAILED: socket did not accept a connection")
	}
	return nil, failure
}

func runCodexHost(stdin io.Reader, stdout io.Writer) error {
	line, err := readProtocolLine(bufio.NewReader(stdin), rpcFrameLimit)
	if err != nil {
		return err
	}
	var spec object
	if err := decodeObject(line, &spec); err != nil {
		return err
	}
	record := obj(spec["record"])
	profile := text(record, "profile")
	path, err := codexHostLocation(profile, ".json")
	if err != nil {
		return err
	}
	home, err := codexPrimaryHome()
	if err != nil {
		return err
	}
	identity := platform.ProcessStart(os.Getpid())
	if identity == "" {
		return errors.New("CODEX_HOST_IDENTITY_UNAVAILABLE")
	}
	release, err := prepareDetachedAgentHost()
	if err != nil {
		return err
	}
	defer release()
	record["pid"], record["processStart"] = os.Getpid(), identity
	if err := save(path, record); err != nil {
		return err
	}
	if err := outputLine(stdout, "indexed"); err != nil {
		return err
	}
	command := exec.Command(text(spec, "binary"), "app-server", "-c", "thread_unload_delay_secs=0", "--listen", "unix://"+text(record, "socket"))
	command.Env = append(command.Environ(), "CODEX_HOME="+home)
	command.Stderr = os.Stderr
	err = execCodexHost(command)
	cleanup := deleteCodexHost(profile)
	if err != nil {
		return err
	}
	return cleanup
}

func init() {
	rpcDetachedHost = attachCodexHost
	rpcDetachedRunning = func() bool { return codexHostRunning(primaryCodexProfile) }
	rpcDesktopAttached = func(ctx context.Context) bool {
		return codexDesktopAttached != nil && codexDesktopAttached(ctx)
	}
}

package core

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const taskHostProtocol = 1
const taskHostMaxFrame = 32 << 20
const taskHostJournalLimit = 64 << 20
const taskHostIdleGrace = 30 * time.Minute
const taskHostHandshakeError = "TASK_HOST_PROTOCOL: use protocol 1; unknown versions are drain-only"

func taskHostIO(err error) error { return fmt.Errorf("TASK_HOST_IO: %w", err) }
func taskHostInstances() string  { return filepath.Join(root(), "task-host", "instances") }

type taskHostJournalRow struct {
	offset uint64
	wire   []byte
}

type taskHostJournal struct {
	path  string
	rows  []taskHostJournalRow
	bytes int
	next  uint64
}

func openTaskHostJournal(path string) (taskHostJournal, error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return taskHostJournal{}, taskHostIO(err)
	}
	return taskHostJournal{path: path, next: 1}, file.Close()
}

func (j *taskHostJournal) first() uint64 {
	if len(j.rows) == 0 {
		return j.next
	}
	return j.rows[0].offset
}

func (j *taskHostJournal) append(kind string, frame any) error {
	line := []byte(wire(object{"offset": j.next, "kind": kind, "frame": frame}) + "\n")
	if len(line) > taskHostJournalLimit {
		return errors.New("TASK_HOST_FRAME_TOO_LARGE: encoded frame exceeds the delivery buffer")
	}
	retained, remaining := j.rows, j.bytes
	if remaining+len(line) > taskHostJournalLimit {
		target := taskHostJournalLimit * 3 / 4
		for remaining+len(line) > target && len(retained) != 0 {
			remaining -= len(retained[0].wire)
			retained = retained[1:]
		}
	}
	if len(retained) != len(j.rows) {
		temporary := strings.TrimSuffix(j.path, filepath.Ext(j.path)) + ".next"
		file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return taskHostIO(err)
		}
		for _, row := range retained {
			if _, err := file.Write(row.wire); err != nil {
				_ = file.Close()
				return taskHostIO(err)
			}
		}
		_, err = file.Write(line)
		if err == nil {
			err = file.Sync()
		}
		if err = errors.Join(err, file.Close()); err != nil {
			return taskHostIO(err)
		}
		if err := platform.ReplaceFile(temporary, j.path); err != nil {
			return taskHostIO(err)
		}
		clear(j.rows[:len(j.rows)-len(retained)])
	} else {
		file, err := os.OpenFile(j.path, os.O_WRONLY|os.O_APPEND, 0)
		if err != nil {
			return taskHostIO(err)
		}
		_, err = file.Write(line)
		if err = errors.Join(err, file.Close()); err != nil {
			return taskHostIO(err)
		}
	}
	j.rows = append(retained, taskHostJournalRow{j.next, line})
	j.bytes, j.next = remaining+len(line), j.next+1
	return nil
}

type taskHostJournalReader struct {
	first    uint64
	position int64
}

func (r *taskHostJournalReader) read(ctx context.Context, path string, after uint64) ([]object, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, taskHostIO(err)
	}
	defer file.Close()
	reader := bufio.NewReader(file)
	line, err := readProtocolLine(reader, taskHostJournalLimit)
	if errors.Is(err, io.EOF) || err == nil && !bytes.HasSuffix(line, []byte{'\n'}) {
		return []object{}, nil
	}
	if err != nil {
		return nil, taskHostIO(err)
	}
	row, err := parseTaskHostJournalRow(line)
	if err != nil {
		return nil, err
	}
	first := uintOr(row["offset"], 0)
	position := r.position
	if first != r.first {
		position = 0
	}
	if _, err := file.Seek(position, io.SeekStart); err != nil {
		return nil, taskHostIO(err)
	}
	reader.Reset(file)
	result := []object{}
	expected := after + 1
	cost := currentRuntimeCost(ctx)
	if cost != nil {
		cost.read.Add(uint64(len(line)))
		cost.parsed.Add(uint64(len(line)))
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line, err := readProtocolLine(reader, taskHostJournalLimit)
		if errors.Is(err, io.EOF) || err == nil && !bytes.HasSuffix(line, []byte{'\n'}) {
			break
		}
		if err != nil {
			return nil, taskHostIO(err)
		}
		position += int64(len(line))
		if cost != nil {
			cost.rows.Add(1)
			cost.read.Add(uint64(len(line)))
			cost.parsed.Add(uint64(len(line)))
		}
		row, err := parseTaskHostJournalRow(line)
		if err != nil {
			return nil, err
		}
		offset := uintOr(row["offset"], 0)
		if offset <= after {
			continue
		}
		if offset != expected {
			return nil, errors.New("TASK_HOST_JOURNAL_GAP: delivery buffer expired; reconcile native Agent history before resuming")
		}
		expected++
		result = append(result, row)
	}
	r.first, r.position = first, position
	return result, nil
}

func parseTaskHostJournalRow(data []byte) (object, error) {
	var row object
	if err := decodeObject(data, &row); err != nil {
		return nil, taskHostIO(err)
	}
	if _, ok := uintValue(row["offset"]); !ok {
		return nil, errors.New("TASK_HOST_JOURNAL_INVALID")
	}
	return row, nil
}

func taskHostWriteSequence(received, sequence uint64) (bool, error) {
	if sequence <= received {
		return false, nil
	}
	if sequence != received+1 {
		return false, errors.New("TASK_HOST_WRITE_GAP: query status and reconcile the received sequence")
	}
	return true, nil
}

func taskHostHandshake(frame object) error {
	if uintOr(frame["protocol"], 0) != taskHostProtocol {
		return errors.New(taskHostHandshakeError)
	}
	return nil
}

func taskHostReceive(reader *bufio.Reader) (object, error) {
	data, err := readProtocolLine(reader, taskHostMaxFrame*2+4096)
	if err != nil {
		return nil, err
	}
	var value object
	if err := decodeObject(data, &value); err != nil {
		return nil, taskHostIO(err)
	}
	return value, nil
}

func taskHostRequest(ctx context.Context, index, command object) (object, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	stream, err := platform.DialIPC(ctx, text(index, "socket"))
	if err != nil {
		return nil, taskHostIO(err)
	}
	defer stream.Close()
	deadline, _ := ctx.Deadline()
	_ = stream.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = stream.Close() })
	defer stop()
	reader := bufio.NewReader(stream)
	exchange := func(value object) (object, error) {
		if err := outputLine(stream, wire(value)); err != nil {
			return nil, taskHostIO(err)
		}
		return taskHostReceive(reader)
	}
	hello, err := exchange(object{"protocol": taskHostProtocol})
	if err == nil {
		err = taskHostHandshake(hello)
	}
	var reply object
	if err == nil {
		reply, err = exchange(command)
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, errors.New("TASK_HOST_TIMEOUT: query host status before retrying writes")
	}
	if err != nil {
		return nil, err
	}
	if message, ok := reply["error"].(string); ok {
		return nil, errors.New(message)
	}
	return reply, nil
}

func taskHostIdentity(index object, pidField, startField string) int {
	pid := int(uintOr(index[pidField], 0))
	start := text(index, startField)
	if pid > 0 && start != "" && platform.ProcessStart(pid) == start {
		return pid
	}
	return 0
}

func taskHostIndexes() []object {
	directory := taskHostInstances()
	entries, _ := os.ReadDir(directory)
	result := []object{}
	for _, row := range entries {
		if row.IsDir() {
			if index, err := load(filepath.Join(directory, row.Name(), "host.json")); err == nil && obj(index) != nil {
				result = append(result, obj(index))
			}
		}
	}
	return result
}

type taskHostClient struct {
	index object
	sync.Mutex
	sequence uint64
}

func newTaskHostClient(index object) *taskHostClient {
	return &taskHostClient{index: clone(index), sequence: uintOr(index["writeSequence"], 0)}
}

func (c *taskHostClient) alive() bool { return taskHostIdentity(c.index, "hostPid", "hostStart") != 0 }

func (c *taskHostClient) exit() object {
	value, _ := load(filepath.Join(filepath.Dir(text(c.index, "journalPath")), "exit.json"))
	return obj(value)
}

func (c *taskHostClient) status(ctx context.Context) (object, error) {
	if uintOr(c.index["hostProtocol"], 0) != taskHostProtocol {
		return object{"alive": c.alive(), "drainOnly": true}, nil
	}
	return taskHostRequest(ctx, c.index, object{"op": "status"})
}

func (c *taskHostClient) write(ctx context.Context, value object, checkpoint func(func(object)) error) error {
	if uintOr(c.index["hostProtocol"], 0) != taskHostProtocol {
		return errors.New("TASK_HOST_DRAIN_ONLY: wait for this host to exit before starting new turns")
	}
	c.Lock()
	defer c.Unlock()
	status, err := c.status(ctx)
	if err != nil {
		return err
	}
	received, ok := uintValue(status["receivedSequence"])
	if !ok {
		return errors.New("TASK_HOST_STATUS_INVALID")
	}
	if received < c.sequence {
		return errors.New("TASK_HOST_WRITE_UNCONFIRMED: reconcile the previous input before sending another write")
	}
	next := received + 1
	err = checkpoint(func(state object) {
		host := dispatchSetSection(state, "taskHost")
		host["writeSequence"], host["unconfirmedWrite"] = next, object{"sequence": next, "frame": value}
		if value["method"] == "session/prompt" || value["type"] == "prompt" {
			host["promptId"], host["promptSequence"], host["promptResponded"] = value["id"], next, false
		}
	})
	if err != nil {
		return err
	}
	c.sequence = next
	reply, err := taskHostRequest(ctx, c.index, object{"op": "write", "sequence": next, "frame": value})
	if err != nil {
		return err
	}
	if uintOr(reply["receivedSequence"], 0) < next {
		return errors.New("TASK_HOST_WRITE_UNCONFIRMED")
	}
	return checkpoint(func(state object) {
		// The replay consumer clears intent alongside its journal cursor.
		dispatchSetSection(state, "taskHost")["receivedSequence"] = reply["receivedSequence"]
	})
}

func (c *taskHostClient) signal(ctx context.Context, kill bool) error {
	if !c.alive() {
		return nil
	}
	if uintOr(c.index["hostProtocol"], 0) != taskHostProtocol {
		if pid := taskHostIdentity(c.index, "agentPid", "agentStart"); pid != 0 {
			signalTaskHostAgent(pid, kill)
		}
		return nil
	}
	name := "interrupt"
	if kill {
		name = "kill"
	}
	_, err := taskHostRequest(ctx, c.index, object{"op": "signal", "signal": name})
	return err
}

func (c *taskHostClient) close(ctx context.Context) error {
	if !c.alive() {
		return nil
	}
	if uintOr(c.index["hostProtocol"], 0) != taskHostProtocol {
		return c.signal(ctx, true)
	}
	_, err := taskHostRequest(ctx, c.index, object{"op": "close"})
	return err
}

func taskHostCommandSpec(command *exec.Cmd) (object, error) {
	if !utf8.ValidString(command.Path) || !utf8.ValidString(command.Dir) {
		return nil, errors.New("TASK_HOST_NON_UTF8: use the direct transport for non-UTF-8 launch values")
	}
	args := []string{}
	for _, arg := range command.Args[1:] {
		if !utf8.ValidString(arg) {
			return nil, errors.New("TASK_HOST_NON_UTF8: use the direct transport for non-UTF-8 launch values")
		}
		args = append(args, arg)
	}
	env := object{}
	environment := command.Env
	if environment == nil {
		environment = os.Environ()
	}
	keys := make(map[string]string)
	for _, pair := range environment {
		if !utf8.ValidString(pair) {
			return nil, errors.New("TASK_HOST_NON_UTF8: use the direct transport for non-UTF-8 launch values")
		}
		if key, value, ok := strings.Cut(pair, "="); ok && key != "" {
			if operatingSystem == "windows" {
				folded := strings.ToLower(key)
				delete(env, keys[folded])
				keys[folded] = key
			}
			env[key] = value
		}
	}
	var cwd any
	if command.Dir != "" {
		cwd = command.Dir
	}
	return object{"program": command.Path, "args": args, "cwd": cwd, "env": env}, nil
}

type taskHostProcess struct {
	sync.Mutex
	input                io.WriteCloser
	journal              taskHostJournal
	received             uint64
	agentPID             int
	alive, busy, closing bool
	exitCode, prompt     any
	pending              map[string]bool
	lastAttach           time.Time
}

func (p *taskHostProcess) status() object {
	return object{"protocol": taskHostProtocol, "agentPid": p.agentPID, "alive": p.alive, "exitCode": p.exitCode,
		"receivedSequence": p.received, "firstOffset": p.journal.first(), "nextOffset": p.journal.next}
}

func (p *taskHostProcess) observeWrite(frame object) {
	if frame["method"] == "session/prompt" || frame["type"] == "prompt" || frame["event"] == "user" {
		p.busy, p.prompt = true, frame["id"]
	}
	if key, exists := frame["id"]; exists {
		_, result := frame["result"]
		_, failure := frame["error"]
		if result || failure || frame["type"] == "extension_ui_response" {
			delete(p.pending, wire(key))
		}
	}
}

func (p *taskHostProcess) observeStdout(frame object) {
	kind := text(frame, "method")
	if kind == "session/request_permission" ||
		frame["type"] == "extension_ui_request" && (kind == "select" || kind == "confirm" || kind == "input" || kind == "editor") {
		p.pending[wire(frame["id"])] = true
	}
	if frame["type"] == "agent_settled" || frame["event"] == "result" ||
		p.prompt != nil && wire(frame["id"]) == wire(p.prompt) && frame["method"] == nil && frame["type"] == nil ||
		frame["type"] == "response" && frame["command"] == "prompt" && frame["success"] == false {
		p.busy = false
		clear(p.pending)
	}
}

func (p *taskHostProcess) command(ctx context.Context, command object) (object, error) {
	p.Lock()
	defer p.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	p.lastAttach = time.Now()
	switch command["op"] {
	case "status":
	case "write":
		sequence, ok := uintValue(command["sequence"])
		if !ok {
			return nil, errors.New("TASK_HOST_SEQUENCE_REQUIRED")
		}
		write, err := taskHostWriteSequence(p.received, sequence)
		if err != nil {
			return nil, err
		}
		if !write {
			return p.status(), nil
		}
		if p.closing {
			return nil, errors.New("TASK_HOST_CLOSING")
		}
		if p.input == nil {
			return nil, errors.New("TASK_HOST_AGENT_EXITED")
		}
		frame := command["frame"]
		input := p.input
		stop := context.AfterFunc(ctx, func() { _ = input.Close() })
		err = outputLine(input, wire(frame))
		stop()
		if err != nil {
			p.closing = true
			return nil, taskHostIO(err)
		}
		p.received = sequence
		if err := p.journal.append("write", object{"sequence": sequence, "value": frame}); err != nil {
			p.closing = true
			return nil, err
		}
		p.observeWrite(obj(frame))
	case "signal":
		if p.alive {
			signalTaskHostAgent(p.agentPID, command["signal"] == "kill")
		}
	case "close":
		p.closing = true
	default:
		return nil, errors.New("TASK_HOST_OP: use status, write, signal or close")
	}
	return p.status(), nil
}

func serveTaskHostConnection(conn net.Conn, process *taskHostProcess) {
	defer conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	reader := bufio.NewReader(conn)
	hello, err := taskHostReceive(reader)
	if err != nil {
		return
	}
	if err := outputLine(conn, wire(object{"protocol": taskHostProtocol})); err != nil || taskHostHandshake(hello) != nil {
		return
	}
	command, err := taskHostReceive(reader)
	if err != nil {
		return
	}
	reply, err := process.command(ctx, command)
	if err != nil {
		reply = object{"error": err.Error()}
	}
	_ = outputLine(conn, wire(reply))
}

func journalTaskHostOutput(reader io.ReadCloser, process *taskHostProcess) error {
	defer reader.Close()
	input := bufio.NewReader(reader)
	for {
		line, err := readProtocolLine(input, taskHostMaxFrame)
		if errors.Is(err, io.EOF) || err == nil && len(bytes.TrimSuffix(line, []byte{'\n'})) == 0 {
			return nil
		}
		if err != nil {
			return err
		}
		line = bytes.TrimSuffix(line, []byte{'\n'})
		process.Lock()
		err = process.journal.append("stdout", strings.ToValidUTF8(string(line), "\uFFFD"))
		var frame object
		if err == nil && decodeObject(line, &frame) == nil {
			process.observeStdout(frame)
		}
		process.Unlock()
		if err != nil {
			return err
		}
	}
}

func runTaskHost(ctx context.Context, stdin io.Reader, stdout io.Writer) error {
	spec, err := taskHostReceive(bufio.NewReader(stdin))
	if err != nil {
		return err
	}
	directory, socket := text(spec, "directory"), text(spec, "socket")
	listener, err := platform.ListenIPC(socket)
	if err != nil {
		return taskHostIO(err)
	}
	defer func() {
		_ = listener.Close()
		removeTaskHostSocketDirectory(socket)
	}()
	finishTree, err := taskHostOwnTree()
	if err != nil {
		return err
	}
	defer finishTree()

	var args []string
	values := arr(spec["args"])
	if values == nil {
		return errors.New("TASK_HOST_ARGS")
	}
	for _, value := range values {
		arg, ok := value.(string)
		if !ok {
			return errors.New("TASK_HOST_ARG")
		}
		args = append(args, arg)
	}
	child := exec.Command(text(spec, "program"), args...)
	platform.ConfigureCommand(child)
	platform.OwnChild(child)
	child.Dir = text(spec, "cwd")
	child.Env = []string{}
	env := obj(spec["env"])
	if env == nil {
		return errors.New("TASK_HOST_ENV")
	}
	for _, key := range keys(env) {
		value, ok := env[key].(string)
		if !ok {
			return errors.New("TASK_HOST_ENV_VALUE")
		}
		child.Env = append(child.Env, key+"="+value)
	}
	childInput, err := child.StdinPipe()
	if err != nil {
		return taskHostIO(err)
	}
	defer childInput.Close()
	childOutput, childWriter, err := os.Pipe()
	if err != nil {
		return taskHostIO(err)
	}
	defer childOutput.Close()
	defer childWriter.Close()
	child.Stdout = childWriter
	journal, err := openTaskHostJournal(filepath.Join(directory, "journal.jsonl"))
	if err != nil {
		return err
	}
	if err := child.Start(); err != nil {
		return taskHostIO(err)
	}
	_ = childWriter.Close()
	pid := child.Process.Pid
	exited := make(chan error, 1)
	go func() { exited <- child.Wait() }()
	unreaped := true
	defer func() {
		if unreaped {
			signalTaskHostAgent(pid, true)
			<-exited
		}
	}()

	identity := selectFields(spec, "taskId", "processSession", "agent", "executable", "creatorPid", "creatorStart")
	identity["hostPid"], identity["hostStart"] = os.Getpid(), platform.ProcessStart(os.Getpid())
	identity["socket"], identity["journalPath"], identity["ackedOffset"] = socket, journal.path, 0
	identity["agentPid"], identity["agentStart"], identity["hostProtocol"] = pid, platform.ProcessStart(pid), taskHostProtocol
	if err := save(filepath.Join(directory, "host.json"), identity); err != nil {
		return err
	}
	if spec["startupAck"] == true {
		if err := outputLine(stdout, "indexed"); err != nil {
			return taskHostIO(err)
		}
	}
	process := &taskHostProcess{input: childInput, journal: journal, agentPID: pid,
		alive: true, pending: map[string]bool{}, lastAttach: time.Now()}
	output := make(chan error, 1)
	go func() { output <- journalTaskHostOutput(childOutput, process) }()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveTaskHostConnection(conn, process)
		}
	}()

	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	var waitErr, outputErr error
	drained := false
	for unreaped {
		select {
		case waitErr = <-exited:
			unreaped = false
		case outputErr = <-output:
			drained = true
		case <-ctx.Done():
		case <-ticker.C:
		}
		process.Lock()
		closing := process.closing || !process.busy && len(process.pending) == 0 && time.Since(process.lastAttach) >= taskHostIdleGrace
		if unreaped && (closing || drained || ctx.Err() != nil) {
			process.closing = true
			if process.input != nil {
				_ = process.input.Close()
				process.input = nil
			}
			process.Unlock()
			select {
			case waitErr = <-exited:
			case <-time.After(2 * time.Second):
				signalTaskHostAgent(pid, true)
				waitErr = <-exited
			}
			unreaped = false
		} else {
			process.Unlock()
		}
	}
	_ = listener.Close()
	// Prevent descendants from indefinitely retaining the output pipe.
	platform.KillOwnedGroup(pid)
	if !drained {
		select {
		case outputErr = <-output:
		case <-time.After(3 * time.Second):
			_ = childOutput.Close()
			<-output
			outputErr = errors.New("TASK_HOST_STDOUT_DRAIN_FAILED")
		}
	}
	process.Lock()
	defer process.Unlock()
	process.alive, process.closing = false, true
	if child.ProcessState == nil {
		return taskHostIO(waitErr)
	}
	if code := child.ProcessState.ExitCode(); code >= 0 {
		process.exitCode = code
	}
	exit := process.status()
	exit["error"], exit["exitedAt"] = nil, now()
	if outputErr != nil {
		exit["error"] = outputErr.Error()
	}
	return save(filepath.Join(directory, "exit.json"), exit)
}

func init() {
	uninstallStopCodexHosts = stopAllCodexHosts
	uninstallStopTaskHosts = stopAllTaskHosts
}

// A content-addressed Core copy keeps detached hosts alive across installer updates.
func taskHostExecutable() (string, error) {
	source, err := runtimeBinary()
	if err != nil {
		return "", err
	}
	identity, err := buildID(source)
	if err != nil {
		return "", err
	}
	directory := filepath.Join(root(), "task-host", identity)
	if err := platform.PrivateDir(directory); err != nil {
		return "", err
	}
	name := "arc"
	if operatingSystem == "windows" {
		name += ".exe"
	}
	target := filepath.Join(directory, name)
	if _, err := os.Stat(target); err == nil {
		return target, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	input, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return "", err
	}
	output, err := os.OpenFile(filepath.Join(directory, id()+".tmp"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return "", err
	}
	defer os.Remove(output.Name())
	_, copyErr := io.Copy(output, input)
	if err := errors.Join(copyErr, output.Close()); err != nil {
		return "", err
	}
	if err := platform.ReplaceFile(output.Name(), target); err != nil {
		if _, statErr := os.Stat(target); statErr != nil {
			return "", err
		}
	}
	return target, nil
}

func launchTaskHost(ctx context.Context, command *exec.Cmd, state object, gate *launches) (*taskHostClient, error) {
	executable, err := taskHostExecutable()
	if err != nil {
		return nil, err
	}
	spec, err := taskHostCommandSpec(command)
	if err != nil {
		return nil, err
	}
	directory := filepath.Join(taskHostInstances(), id())
	if err := platform.PrivateDir(directory); err != nil {
		return nil, taskHostIO(err)
	}
	socket, err := newTaskHostSocket()
	if err != nil {
		return nil, err
	}
	spec["directory"], spec["socket"], spec["executable"], spec["startupAck"] = directory, socket, executable, true
	spec["taskId"], spec["processSession"], spec["agent"] = state["taskId"], state["processSession"], state["agent"]
	spec["creatorPid"], spec["creatorStart"] = os.Getpid(), platform.ProcessStart(os.Getpid())
	routes := [][]string{{executable, "task-host"}}
	if operatingSystem == "linux" && os.Getenv("INVOCATION_ID") != "" {
		scoped := []string{"systemd-run", "--user", "--scope", "--collect", "--quiet", "--", executable, "task-host"}
		routes = append([][]string{scoped}, routes...)
	}
	var failure error
	for _, argv := range routes {
		if err := ctx.Err(); err != nil {
			failure = err
			break
		}
		host := exec.Command(argv[0], argv[1:]...)
		host.Env = append(host.Environ(), "ARC_STATE_DIR="+root())
		failure = gate.run(func() error { return indexedHostSpawn(host, spec) })
		indexValue, indexErr := load(filepath.Join(directory, "host.json"))
		if indexErr == nil && obj(indexValue) != nil {
			client := newTaskHostClient(obj(indexValue))
			if failure == nil && client.alive() {
				if _, err := client.status(ctx); err == nil {
					return client, nil
				}
			}
			stopTaskHostIndex(context.WithoutCancel(ctx), client)
		}
		if failure == nil {
			failure = errors.New("TASK_HOST_START_FAILED: no protocol handshake")
		}
		// A fallback needs a fresh journal and index directory.
		directory = filepath.Join(taskHostInstances(), id())
		if err := platform.PrivateDir(directory); err != nil {
			failure = err
			break
		}
		spec["directory"] = directory
	}
	removeTaskHostSocketDirectory(socket)
	return nil, failure
}

func stopTaskHostIndex(ctx context.Context, client *taskHostClient) {
	if client.alive() {
		_ = client.close(ctx)
		deadline := time.Now().Add(5 * time.Second)
		for ctx.Err() == nil && client.alive() && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
	}
	if pid := taskHostIdentity(client.index, "agentPid", "agentStart"); pid != 0 {
		signalVerifiedTaskHostAgent(pid, text(client.index, "agentStart"))
	}
	if pid := taskHostIdentity(client.index, "hostPid", "hostStart"); pid != 0 {
		platform.SignalVerifiedTree(pid, text(client.index, "hostStart"), true)
	}
}

func stopUnattachedTaskHosts(ctx context.Context, retained []object) {
	pid, start := os.Getpid(), platform.ProcessStart(os.Getpid())
	for _, index := range taskHostIndexes() {
		if slices.ContainsFunc(retained, func(host object) bool {
			return uintOr(host["hostPid"], 0) == uintOr(index["hostPid"], 0) && host["hostStart"] == index["hostStart"]
		}) {
			continue
		}
		if uintOr(index["creatorPid"], 0) == uint64(pid) && index["creatorStart"] == start && start != "" {
			stopTaskHostIndex(ctx, newTaskHostClient(index))
		}
	}
}

var taskHostBuildDirectory = regexp.MustCompile("^[a-fA-F0-9]{64}$")

func gcTaskHostExecutables() error {
	keep := codexHostExecutables()
	for _, index := range taskHostIndexes() {
		if taskHostIdentity(index, "hostPid", "hostStart") != 0 && text(index, "executable") != "" {
			keep = append(keep, text(index, "executable"))
		}
	}
	source, _ := runtimeBinary()
	current, _ := buildID(source)
	directory := filepath.Join(root(), "task-host")
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		name := entry.Name()
		if name == current || !taskHostBuildDirectory.MatchString(name) {
			continue
		}
		path := filepath.Join(directory, name)
		if !slices.ContainsFunc(keep, func(value string) bool { return belowPath(value, path) }) {
			if err := os.RemoveAll(path); err != nil {
				return taskHostIO(err)
			}
		}
	}
	return nil
}

func stopAllTaskHosts(ctx context.Context) error {
	for _, index := range taskHostIndexes() {
		stopTaskHostIndex(ctx, newTaskHostClient(index))
	}
	return gcTaskHostExecutables()
}

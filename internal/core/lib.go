package core

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/internal/platform"
	assets "github.com/whzxc/agent-remote-control/shared/core"
)

type object = map[string]any

var catalog = sync.OnceValue(func() object { return resource("catalog.json") })

func resource(name string) object {
	data, err := assets.Files.ReadFile(name)
	if err != nil {
		panic(err)
	}
	var value object
	if err := canonjson.Unmarshal(data, &value); err != nil {
		panic(err)
	}
	return value
}

func obj(value any) object              { result, _ := value.(object); return result }
func arr(value any) []any               { result, _ := value.([]any); return result }
func str(value any) string              { result, _ := value.(string); return result }
func field(value any, key string) any   { return obj(value)[key] }
func text(value any, key string) string { return str(field(value, key)) }

func uintValue(value any) (uint64, bool) {
	switch n := value.(type) {
	case json.Number:
		result, err := strconv.ParseUint(n.String(), 10, 64)
		return result, err == nil
	case uint64:
		return n, true
	case int:
		return uint64(n), n >= 0
	case int64:
		return uint64(n), n >= 0
	}
	return 0, false
}

func uintOr(value any, fallback uint64) uint64 {
	if n, ok := uintValue(value); ok {
		return n
	}
	return fallback
}

func find(rows any, key, value string) object {
	for _, row := range arr(rows) {
		if text(row, key) == value {
			return obj(row)
		}
	}
	return nil
}

func keys(value object) []string {
	result := make([]string, 0, len(value))
	for key := range value {
		result = append(result, key)
	}
	slices.Sort(result)
	return result
}

func wire(value any) string {
	data, err := canonjson.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}

func clone(value object) object {
	var copy object
	if err := canonjson.Unmarshal([]byte(wire(value)), &copy); err != nil {
		panic(err)
	}
	return copy
}

func newUUID() [16]byte {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return b
}

func id() string {
	b := newUUID()
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func hash(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func root() string {
	if path, ok := os.LookupEnv("ARC_STATE_DIR"); ok {
		return path
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "agent-remote-control")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".agent-remote-control")
}

func load(path string) (any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		recordFileCost(fileCost{Path: path, Rows: 1})
		return nil, err
	}
	recordFileCost(fileCost{Path: path, Rows: 1, BytesRead: len(data), BytesParsed: len(data)})
	var value any
	err = canonjson.Unmarshal(data, &value)
	return value, err
}

type fileCost struct {
	Path                                  string
	Rows, BytesRead, BytesParsed, Changed int
	CacheHits, CacheMisses                int
}

var fileCostObservers []func(fileCost)

func registerFileCostObserver(observe func(fileCost)) {
	fileCostObservers = append(fileCostObservers, observe)
}

func recordFileCost(cost fileCost) {
	for _, observe := range fileCostObservers {
		observe(cost)
	}
}

func save(path string, value any) error {
	data, err := canonjson.Marshal(value)
	if err != nil {
		return err
	}
	return saveBytes(path, data)
}

func saveBytes(path string, data []byte) error {
	parent := filepath.Dir(path)
	before, _ := readStamp(parent)
	if err := platform.PrivateDir(parent); err != nil {
		return fmt.Errorf("File operation failed at prepare-directory for %s: %w", parent, err)
	}
	temp := strings.TrimSuffix(path, filepath.Ext(path)) + "." + id() + ".tmp"
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("File operation failed at write-temporary for %s: %w", temp, err)
	}
	defer os.Remove(temp)
	_, writeErr := file.Write(data)
	if err = errors.Join(writeErr, file.Close()); err != nil {
		return fmt.Errorf("File operation failed at write-temporary for %s: %w", temp, err)
	}
	if err := platform.ReplaceFile(temp, path); err != nil {
		return fmt.Errorf("File operation failed at replace for %s: from %s: %w", path, temp, err)
	}
	markCachedFileChanged(path, before)
	recordFileCost(fileCost{Path: path, Changed: 1})
	return nil
}

// readProtocolLine includes the newline in the byte budget and accepts a final partial line at EOF.
func readProtocolLine(input *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		part, err := input.ReadSlice('\n')
		if len(part) > limit-len(line) {
			return nil, errors.New("FRAME_TOO_LARGE")
		}
		line = append(line, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF && len(line) != 0 {
			err = nil
		}
		return line, err
	}
}

func nativeCommand(ctx context.Context, binary string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, binary, args...)
	platform.ConfigureCommand(cmd)
	return cmd
}

func decodeCommandOutput(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	if decoded, ok := platform.DecodeOEM(data); ok {
		return decoded
	}
	return strings.ToValidUTF8(string(data), "�")
}

func commandOutput(ctx context.Context, binary string, args ...string) (string, error) {
	wait, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	out, err := nativeCommand(wait, binary, args...).Output()
	if errors.Is(wait.Err(), context.DeadlineExceeded) {
		return "", errors.New("COMMAND_TIMEOUT")
	}
	if err == nil {
		return decodeCommandOutput(out), nil
	}
	var status *exec.ExitError
	if errors.As(err, &status) {
		message := strings.TrimSpace(decodeCommandOutput(status.Stderr))
		if message == "" {
			message = strings.TrimSpace(decodeCommandOutput(out))
		}
		if message == "" {
			message = "Command failed: " + status.ProcessState.String()
		}
		return "", errors.New(message)
	}
	return "", err
}

var deviceDisplayName = sync.OnceValue(func() string {
	ctx := context.Background()
	if operatingSystem == "darwin" {
		if name, err := commandOutput(ctx, "/usr/sbin/scutil", "--get", "ComputerName"); err == nil && strings.TrimSpace(name) != "" {
			return strings.TrimSpace(name)
		}
	}
	for _, env := range []string{"COMPUTERNAME", "HOSTNAME"} {
		if name := strings.TrimSpace(os.Getenv(env)); name != "" {
			return name
		}
	}
	if name, err := os.Hostname(); err == nil && strings.TrimSpace(name) != "" {
		return strings.TrimSpace(name)
	}
	return "This computer"
})

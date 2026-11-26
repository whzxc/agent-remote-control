package core

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

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
		return nil, err
	}
	var value any
	err = canonjson.Unmarshal(data, &value)
	return value, err
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
	return nil
}

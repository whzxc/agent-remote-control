package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

func number(value any) int {
	switch n := value.(type) {
	case int:
		return n
	case float64:
		return int(n)
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return -1
		}
		return int(i)
	default:
		return -1
	}
}

func readJSON(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return canonjson.Unmarshal(data, value)
}

func writeJSON(path string, value any) error {
	data, err := canonjson.Marshal(value)
	if err != nil {
		return err
	}
	return writePrivate(path, data)
}

func writePrivate(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := platform.PrivateDir(dir); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

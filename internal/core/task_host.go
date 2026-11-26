package core

import (
	"errors"
	"io"
	"os"
	"path/filepath"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

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

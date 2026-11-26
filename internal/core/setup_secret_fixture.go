//go:build arcfixture

package core

import (
	"errors"
	"os"
	"path/filepath"
	"unicode/utf8"
)

func init() {
	setupClipboardFixture = func(clear bool) (string, bool, error) {
		path := filepath.Join(root(), "fixtures", "clipboard.txt")
		if _, err := os.Stat(path); err != nil {
			return "", false, nil
		}
		if clear {
			return "", true, os.WriteFile(path, nil, 0o600)
		}
		data, err := os.ReadFile(path)
		if err == nil && !utf8.Valid(data) {
			err = errors.New("stream did not contain valid UTF-8")
		}
		return string(data), true, err
	}
}

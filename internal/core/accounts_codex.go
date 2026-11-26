package core

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

func primaryCodexHome(configured *string, profiles string, userHome *string) (string, bool) {
	if configured != nil {
		profile := filepath.Dir(*configured)
		container := filepath.Dir(profile)
		_, idError := uuid.Parse(filepath.Base(profile))
		managed := filepath.Base(*configured) == "home" && idError == nil &&
			(container == filepath.Clean(profiles) || filepath.Base(container) == "profiles" &&
				filepath.Base(filepath.Dir(container)) == "codex" &&
				filepath.Base(filepath.Dir(filepath.Dir(container))) == "accounts")
		if !managed {
			return *configured, true
		}
	}
	if userHome != nil {
		return filepath.Join(*userHome, ".codex"), true
	}
	return "", false
}

func nativeCodexHome() (string, error) {
	canonical := func(value string) string {
		if absolute, err := filepath.Abs(value); err == nil {
			if actual, err := filepath.EvalSymlinks(absolute); err == nil {
				return actual
			}
		}
		return value
	}
	var configured, userHome *string
	if value, ok := os.LookupEnv("CODEX_HOME"); ok {
		if value != "" {
			value = canonical(value)
		}
		configured = &value
	}
	if value, err := os.UserHomeDir(); err == nil {
		userHome = &value
	}
	if path, ok := primaryCodexHome(configured, canonical(filepath.Join(root(), "accounts/codex/profiles")), userHome); ok {
		return path, nil
	}
	return "", errors.New("CODEX_HOME_UNAVAILABLE")
}

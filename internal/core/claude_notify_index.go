package core

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func notificationDirectory() string { return filepath.Join(root(), "notifications") }

func notificationBindingPath(thread, turn string) string {
	digest := hash([]byte(wire([]string{thread, turn})))
	return filepath.Join(notificationDirectory(), "tasks", digest+".json")
}

func persistNotificationBinding(binding object) error {
	path := notificationBindingPath(text(binding, "threadId"), text(binding, "turnId"))
	old, _ := load(path)
	if wire(old) == wire(binding) {
		return nil
	}
	return save(path, binding)
}

func readNotificationBinding(thread, turn string) (object, error) {
	row, err := load(notificationBindingPath(thread, turn))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return obj(row), err
}

func notificationBindings() ([]object, error) {
	dir := filepath.Join(notificationDirectory(), "tasks")
	files, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return []object{}, nil
	}
	if err != nil {
		return nil, err
	}
	rows := make([]object, 0, len(files))
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		value, err := load(filepath.Join(dir, file.Name()))
		if err != nil || obj(value) == nil {
			recordLog("WARN", "Ignored malformed notification binding", nil)
			continue
		}
		rows = append(rows, obj(value))
	}
	return rows, nil
}

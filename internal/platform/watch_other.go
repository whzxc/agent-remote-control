//go:build !darwin && !windows

package platform

import "github.com/fsnotify/fsnotify"

type FileWatcher = fsnotify.Watcher

const FileWatcherRecursive = false

func NewFileWatcher() (*FileWatcher, error) { return fsnotify.NewWatcher() }

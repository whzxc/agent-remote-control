package core

import (
	"errors"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/fsnotify/fsnotify"
	"github.com/whzxc/agent-remote-control/internal/platform"
)

func physicalPath(path string) string {
	abs, err := filepath.Abs(path)
	if err == nil {
		path = abs
	}
	if canonical, err := filepath.EvalSymlinks(path); err == nil {
		return canonical
	}
	parent := filepath.Dir(path)
	if parent == path {
		return path
	}
	return filepath.Join(physicalPath(parent), filepath.Base(path))
}

func belowPath(path, parent string) bool {
	relative, err := filepath.Rel(parent, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

type fileChanges struct {
	sync.Mutex
	registration sync.Mutex
	watcher      *platform.FileWatcher
	files        map[string]string
	directories  map[string]int
	paths        map[string]bool
	own          map[string]*pendingFileWrite
	wake         chan struct{}
	failed       atomic.Bool
	closed       bool
}

type pendingFileWrite struct {
	stamp   *fileStamp
	writing bool
}

var fileWatchers struct {
	sync.Mutex
	active map[*fileChanges]bool
}

func newFileChanges() *fileChanges {
	watcher, err := platform.NewFileWatcher()
	w := &fileChanges{watcher: watcher, files: make(map[string]string), directories: make(map[string]int), paths: make(map[string]bool),
		own: make(map[string]*pendingFileWrite), wake: make(chan struct{}, 1)}
	w.failed.Store(err != nil)
	fileWatchers.Lock()
	if fileWatchers.active == nil {
		fileWatchers.active = make(map[*fileChanges]bool)
	}
	fileWatchers.active[w] = true
	fileWatchers.Unlock()
	if watcher != nil {
		go w.watchLoop()
	}
	return w
}

func (w *fileChanges) notify() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

func (w *fileChanges) watchLoop() {
	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			if isDerivedIndexPath(event.Name) {
				continue
			}
			w.acceptPhysical(physicalPath(event.Name))
			if event.Has(fsnotify.Create) || event.Has(fsnotify.Rename) {
				w.refreshParents(event.Name)
			}
		case _, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			w.failed.Store(true)
			w.notify()
		}
	}
}

func closestDirectory(path string) string {
	for {
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			return path
		}
		parent := filepath.Dir(path)
		if parent == path {
			return ""
		}
		path = parent
	}
}

func (w *fileChanges) refreshParents(changed string) {
	w.registration.Lock()
	defer w.registration.Unlock()
	if w.closed {
		return
	}
	for path, old := range w.files {
		parent := filepath.Dir(path)
		if !belowPath(parent, changed) {
			continue
		}
		candidate := closestDirectory(parent)
		if candidate == "" || candidate == old {
			continue
		}
		// Register before swapping the old parent so writes during a move
		// are either observed under the old watch or picked up below.
		w.addDirectory(candidate)
		w.Lock()
		w.files[path] = candidate
		w.Unlock()
		w.removeDirectory(old)
		if filepath.Base(path) == ".index-watch" {
			if entries, err := os.ReadDir(candidate); err == nil {
				for _, entry := range entries {
					w.acceptPhysical(filepath.Join(candidate, entry.Name()))
				}
			}
		} else {
			w.acceptPhysical(path)
		}
	}
}

func (w *fileChanges) add(path string) {
	path = physicalPath(path)
	w.registration.Lock()
	defer w.registration.Unlock()
	if _, ok := w.files[path]; ok || w.closed {
		return
	}
	parent := closestDirectory(filepath.Dir(path))
	w.Lock()
	w.files[path] = parent
	w.Unlock()
	w.addDirectory(parent)
}

func (w *fileChanges) addDirectory(parent string) {
	if w.directories[parent] == 0 && (parent == "" || w.watcher == nil || w.watcher.Add(parent) != nil) {
		w.failed.Store(true)
		w.notify()
	}
	w.directories[parent]++
}

func (w *fileChanges) removeDirectory(parent string) {
	w.directories[parent]--
	if w.directories[parent] <= 0 {
		delete(w.directories, parent)
		if w.watcher != nil && parent != "" {
			_ = w.watcher.Remove(parent)
		}
	}
}

func (w *fileChanges) remove(path string) {
	path = physicalPath(path)
	w.registration.Lock()
	defer w.registration.Unlock()
	w.Lock()
	parent, exists := w.files[path]
	if exists {
		delete(w.files, path)
		delete(w.own, path)
	}
	w.Unlock()
	if exists {
		w.removeDirectory(parent)
	}
}

func (w *fileChanges) accept(path string) {
	if own := w.own[path]; own != nil {
		if own.writing {
			return
		}
		if current, err := readStamp(path); err == nil && stampSame(current, own.stamp) {
			return
		}
		delete(w.own, path)
	}
	_, explicit := w.files[path]
	_, discover := w.files[filepath.Join(filepath.Dir(path), ".index-watch")]
	if explicit || discover && filepath.Ext(path) == ".json" {
		w.paths[path] = true
		w.notify()
	}
}
func isDerivedIndexPath(path string) bool {
	separator := string(filepath.Separator)
	return strings.Contains(separator+path+separator, separator+".activity-index"+separator)
}

func (w *fileChanges) changed(path string) {
	if !isDerivedIndexPath(path) {
		w.acceptPhysical(physicalPath(path))
	}
}

func (w *fileChanges) acceptPhysical(path string) {
	w.Lock()
	defer w.Unlock()
	if !w.closed {
		w.accept(path)
	}
}

func publishChangedFile(path string) {
	if isDerivedIndexPath(path) {
		return
	}
	path = physicalPath(path)
	fileWatchers.Lock()
	watchers := slices.Collect(maps.Keys(fileWatchers.active))
	fileWatchers.Unlock()
	for _, watcher := range watchers {
		watcher.acceptPhysical(path)
	}
}

func (w *fileChanges) ownWrite(path string) func() {
	path = physicalPath(path)
	w.Lock()
	w.own[path] = &pendingFileWrite{writing: true}
	delete(w.paths, path)
	w.Unlock()
	return func() {
		stamp, _ := readStamp(path)
		w.Lock()
		w.own[path] = &pendingFileWrite{stamp: stamp}
		w.Unlock()
	}
}

func (w *fileChanges) drain() ([]string, bool) {
	w.Lock()
	defer w.Unlock()
	paths := make([]string, 0, len(w.paths))
	for path := range w.paths {
		paths = append(paths, path)
	}
	slices.Sort(paths)
	clear(w.paths)
	return paths, w.failed.Load()
}

func (w *fileChanges) close() {
	fileWatchers.Lock()
	delete(fileWatchers.active, w)
	fileWatchers.Unlock()
	w.registration.Lock()
	defer w.registration.Unlock()
	w.Lock()
	wasClosed := w.closed
	w.closed = true
	w.Unlock()
	if !wasClosed && w.watcher != nil {
		_ = w.watcher.Close()
	}
}

func watchDiagnostics() object {
	fileWatchers.Lock()
	defer fileWatchers.Unlock()
	failed := 0
	for active := range fileWatchers.active {
		if active.failed.Load() {
			failed++
		}
	}
	return object{"watchers": len(fileWatchers.active), "coverageGaps": failed}
}

type repairCursor struct{ dir *os.File }

func repairPaths(directory string, cursor *repairCursor, limit int) ([]string, error) {
	if cursor.dir == nil {
		dir, err := os.Open(directory)
		if err != nil {
			return nil, err
		}
		cursor.dir = dir
	}
	entries, err := cursor.dir.ReadDir(limit)
	if err != nil || len(entries) < limit {
		_ = cursor.dir.Close()
		cursor.dir = nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) && len(entries) == 0 {
		if !errors.Is(err, io.EOF) {
			return nil, err
		}
	}
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		paths = append(paths, filepath.Join(directory, entry.Name()))
	}
	return paths, nil
}

type discoveryChanges struct {
	watcher  *platform.FileWatcher
	revision atomic.Uint64
	failed   atomic.Bool
	wake     chan struct{}
}

func watchDiscovery(paths []string, relevant func(string) bool) (*discoveryChanges, error) {
	watcher, err := platform.NewFileWatcher()
	if err != nil {
		return nil, err
	}
	result := &discoveryChanges{watcher: watcher, wake: make(chan struct{}, 1)}
	input := make([]string, 0, len(paths))
	roots := map[string]bool{}
	watchTree := func(path string) error {
		if platform.FileWatcherRecursive {
			return watcher.Add(path)
		}
		return filepath.WalkDir(path, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() && !roots[path] {
				if err := watcher.Add(path); err != nil {
					return err
				}
				roots[path] = true
			}
			return nil
		})
	}
	for _, path := range paths {
		path = physicalPath(path)
		input = append(input, path)
		parent := closestDirectory(filepath.Dir(path))
		if parent == "" {
			watcher.Close()
			return nil, errors.New("No watchable parent directory")
		}
		if err := watchTree(parent); err != nil {
			watcher.Close()
			return nil, err
		}
	}
	signal := func() {
		select {
		case result.wake <- struct{}{}:
		default:
		}
	}
	go func() {
		for {
			select {
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				if !platform.FileWatcherRecursive && event.Has(fsnotify.Create) {
					if state, err := os.Stat(event.Name); err == nil && state.IsDir() {
						if watchTree(event.Name) != nil {
							result.failed.Store(true)
						}
					}
				}
				for _, path := range input {
					if (belowPath(path, event.Name) || belowPath(event.Name, path)) && (relevant == nil || relevant(event.Name)) {
						result.revision.Add(1)
						signal()
						break
					}
				}
			case _, ok := <-watcher.Errors:
				if !ok {
					return
				}
				result.failed.Store(true)
				signal()
			}
		}
	}()
	return result, nil
}

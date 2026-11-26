package platform

import (
	"sync"

	"github.com/fsnotify/fsnotify"
)

const FileWatcherRecursive = false

type FileWatcher struct {
	Events chan fsnotify.Event
	Errors chan error

	mu     sync.Mutex
	source *fsnotify.Watcher
}

func NewFileWatcher() (*FileWatcher, error) {
	source, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	watcher := &FileWatcher{Events: make(chan fsnotify.Event, 4096), Errors: make(chan error, 1), source: source}
	go watcher.deliver()
	return watcher, nil
}

func (w *FileWatcher) deliver() {
	defer close(w.Events)
	defer close(w.Errors)
	events, failures := w.source.Events, w.source.Errors
	// Windows fsnotify services Add and Remove on the same worker that emits
	// events. Keep receiving even when a consumer is changing its watches.
	for events != nil || failures != nil {
		select {
		case event, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			select {
			case w.Events <- event:
			default:
				w.reportGap(fsnotify.ErrEventOverflow)
			}
		case err, ok := <-failures:
			if !ok {
				failures = nil
				continue
			}
			w.reportGap(err)
		}
	}
}

func (w *FileWatcher) reportGap(err error) {
	select {
	case w.Errors <- err:
	default:
	}
}

func (w *FileWatcher) Add(path string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.source.Add(path)
}

func (w *FileWatcher) Remove(path string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.source.Remove(path)
}

func (w *FileWatcher) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.source.Close()
}

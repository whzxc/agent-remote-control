package platform

import (
	"errors"
	"path/filepath"
	"slices"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/fsnotify/fsnotify"
	"golang.org/x/sys/unix"
)

const FileWatcherRecursive = true

const (
	fseNoDefer           = 0x0002
	fseFileEvents        = 0x0010
	fseMustScanSubDirs   = 0x0001
	fseHistoryDone       = 0x0010
	fseItemCreated       = 0x0100
	fseItemRemoved       = 0x0200
	fseItemRenamed       = 0x0800
	cfStringEncodingUTF8 = 0x08000100
)

type fileEventsAPI struct {
	stringCreate   func(uintptr, string, uint32) uintptr
	arrayCreate    func(uintptr, *uintptr, int, uintptr) uintptr
	arrayCallbacks uintptr
	release        func(uintptr)
	queueCreate    func(string, uintptr) uintptr
	queueRelease   func(uintptr)
	queueSync      func(uintptr, uintptr, uintptr)
	currentID      func() uint64
	streamCreate   func(uintptr, uintptr, uintptr, uintptr, uint64, float64, uint32) uintptr
	streamSetQueue func(uintptr, uintptr)
	streamStart    func(uintptr) bool
	streamFlush    func(uintptr)
	streamStop     func(uintptr)
	streamInvalid  func(uintptr)
	streamRelease  func(uintptr)
	callback       uintptr
	barrier        uintptr
}

var macFileEvents = sync.OnceValues(func() (*fileEventsAPI, error) {
	const frames = "/System/Library/Frameworks/"
	cf, err := purego.Dlopen(frames+"CoreFoundation.framework/CoreFoundation", purego.RTLD_LAZY|purego.RTLD_LOCAL)
	if err != nil {
		return nil, err
	}
	fs, err := purego.Dlopen(frames+"CoreServices.framework/CoreServices", purego.RTLD_LAZY|purego.RTLD_LOCAL)
	if err != nil {
		return nil, err
	}
	dispatch, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LAZY|purego.RTLD_LOCAL)
	if err != nil {
		return nil, err
	}
	api := &fileEventsAPI{}
	api.arrayCallbacks, err = purego.Dlsym(cf, "kCFTypeArrayCallBacks")
	if err != nil {
		return nil, err
	}
	purego.RegisterLibFunc(&api.stringCreate, cf, "CFStringCreateWithCString")
	purego.RegisterLibFunc(&api.arrayCreate, cf, "CFArrayCreate")
	purego.RegisterLibFunc(&api.release, cf, "CFRelease")
	purego.RegisterLibFunc(&api.queueCreate, dispatch, "dispatch_queue_create")
	purego.RegisterLibFunc(&api.queueRelease, dispatch, "dispatch_release")
	purego.RegisterLibFunc(&api.queueSync, dispatch, "dispatch_sync_f")
	purego.RegisterLibFunc(&api.currentID, fs, "FSEventsGetCurrentEventId")
	purego.RegisterLibFunc(&api.streamCreate, fs, "FSEventStreamCreate")
	purego.RegisterLibFunc(&api.streamSetQueue, fs, "FSEventStreamSetDispatchQueue")
	purego.RegisterLibFunc(&api.streamStart, fs, "FSEventStreamStart")
	purego.RegisterLibFunc(&api.streamFlush, fs, "FSEventStreamFlushSync")
	purego.RegisterLibFunc(&api.streamStop, fs, "FSEventStreamStop")
	purego.RegisterLibFunc(&api.streamInvalid, fs, "FSEventStreamInvalidate")
	purego.RegisterLibFunc(&api.streamRelease, fs, "FSEventStreamRelease")
	api.callback = purego.NewCallback(deliverFileEvents)
	api.barrier = purego.NewCallback(func(uintptr) {})
	return api, nil
})

var fileEventStreams sync.Map

func deliverFileEvents(stream, _ uintptr, count int, paths **byte, flags *uint32, _ uintptr) {
	value, ok := fileEventStreams.Load(stream)
	if !ok {
		return
	}
	watcher := value.(*FileWatcher)
	names := unsafe.Slice(paths, count)
	for i, flag := range unsafe.Slice(flags, count) {
		if flag&fseHistoryDone != 0 {
			continue
		}
		if flag&fseMustScanSubDirs != 0 {
			watcher.reportGap()
		}
		var op fsnotify.Op
		if flag&fseItemCreated != 0 {
			op |= fsnotify.Create
		}
		if flag&fseItemRemoved != 0 {
			op |= fsnotify.Remove
		}
		if flag&fseItemRenamed != 0 {
			op |= fsnotify.Rename
		}
		if op == 0 {
			op = fsnotify.Write
		}
		select {
		case watcher.Events <- fsnotify.Event{Name: unix.BytePtrToString(names[i]), Op: op}:
		default:
			watcher.reportGap()
		}
	}
}

// FileWatcher uses one recursive FSEvents stream for all roots. A kqueue
// directory watch opens every entry, which ties descriptor usage to history size.
type FileWatcher struct {
	Events chan fsnotify.Event
	Errors chan error

	mu     sync.Mutex
	api    *fileEventsAPI
	queue  uintptr
	stream uintptr
	paths  map[string]bool
	roots  []string
}

func NewFileWatcher() (*FileWatcher, error) {
	api, err := macFileEvents()
	if err != nil {
		return nil, err
	}
	queue := api.queueCreate("arc.file-events", 0)
	if queue == 0 {
		return nil, errors.New("could not create FSEvents dispatch queue")
	}
	return &FileWatcher{Events: make(chan fsnotify.Event, 4096), Errors: make(chan error, 1), api: api, queue: queue, paths: make(map[string]bool)}, nil
}

func (w *FileWatcher) Add(path string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.queue == 0 {
		return fsnotify.ErrClosed
	}
	w.paths[filepath.Clean(path)] = true
	return w.updateRoots()
}

func (w *FileWatcher) Remove(path string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.paths, filepath.Clean(path))
	return w.updateRoots()
}

func (w *FileWatcher) reportGap() {
	select {
	case w.Errors <- fsnotify.ErrEventOverflow:
	default:
	}
}

func (w *FileWatcher) updateRoots() error {
	var roots []string
	for path := range w.paths {
		covered := false
		for child, parent := path, filepath.Dir(path); child != parent; child, parent = parent, filepath.Dir(parent) {
			if w.paths[parent] {
				covered = true
				break
			}
		}
		if !covered {
			roots = append(roots, path)
		}
	}
	slices.Sort(roots)
	if slices.Equal(roots, w.roots) {
		return nil
	}
	stream, err := w.start(roots)
	if err != nil {
		w.reportGap()
		return err
	}
	if w.stream != 0 {
		// The replacement starts before flushing the old stream. Any events
		// in the overlap are harmless because Core deduplicates changed paths.
		w.api.streamFlush(w.stream)
		w.dispose(w.stream, true)
	}
	w.stream, w.roots = stream, roots
	return nil
}

func (w *FileWatcher) start(roots []string) (uintptr, error) {
	if len(roots) == 0 {
		return 0, nil
	}
	api := w.api
	since := api.currentID()
	paths := make([]uintptr, 0, len(roots))
	defer func() {
		for _, path := range paths {
			api.release(path)
		}
	}()
	for _, path := range roots {
		value := api.stringCreate(0, path, cfStringEncodingUTF8)
		if value == 0 {
			return 0, errors.New("could not encode FSEvents watch path")
		}
		paths = append(paths, value)
	}
	array := api.arrayCreate(0, &paths[0], len(paths), api.arrayCallbacks)
	if array == 0 {
		return 0, errors.New("could not allocate FSEvents watch paths")
	}
	defer api.release(array)
	stream := api.streamCreate(0, api.callback, 0, array, since, 0.01, fseNoDefer|fseFileEvents)
	if stream == 0 {
		return 0, errors.New("could not create FSEvents stream")
	}
	fileEventStreams.Store(stream, w)
	api.streamSetQueue(stream, w.queue)
	if !api.streamStart(stream) {
		w.dispose(stream, false)
		return 0, errors.New("could not start FSEvents stream")
	}
	return stream, nil
}

func (w *FileWatcher) dispose(stream uintptr, started bool) {
	if started {
		w.api.streamStop(stream)
	}
	w.api.streamInvalid(stream)
	w.api.queueSync(w.queue, 0, w.api.barrier)
	fileEventStreams.Delete(stream)
	w.api.streamRelease(stream)
}

func (w *FileWatcher) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.queue != 0 {
		if w.stream != 0 {
			w.dispose(w.stream, true)
		}
		w.api.queueRelease(w.queue)
		w.queue, w.stream = 0, 0
		w.paths, w.roots = nil, nil
		close(w.Events)
		close(w.Errors)
	}
	return nil
}

package platform

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

func TestWindowsFileWatcherUpdatesRegistrationWhileDeliveryIsPaused(t *testing.T) {
	// Recurring bug class: lifecycle native event delivery must not block watcher registration or shutdown.
	watcher, err := NewFileWatcher()
	if err != nil {
		t.Fatal(err)
	}
	defer watcher.Close()
	parent, replacement := t.TempDir(), t.TempDir()
	if err := watcher.Add(parent); err != nil {
		t.Fatal(err)
	}

	for i := range 64 {
		if err := os.Mkdir(filepath.Join(parent, fmt.Sprint(i)), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	select {
	case <-watcher.Events:
	case <-timer.C:
		t.Fatal("Windows did not report any directory creations")
	}

	updated := make(chan error, 1)
	go func() {
		if err := watcher.Add(replacement); err != nil {
			updated <- err
			return
		}
		updated <- watcher.Remove(parent)
	}()
	select {
	case err := <-updated:
		if err != nil {
			t.Fatal(err)
		}
	case <-timer.C:
		// Resume delivery before closing so a blocked registration can unwind.
		for {
			select {
			case <-watcher.Events:
			case <-watcher.Errors:
			case <-updated:
				t.Fatal("watch registration waited for the event consumer")
			}
		}
	}

	created := filepath.Join(replacement, "created")
	if err := os.Mkdir(created, 0o700); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case change := <-watcher.Events:
			if change.Name == created && change.Has(fsnotify.Create) {
				return
			}
		case err := <-watcher.Errors:
			t.Fatal(err)
		case <-timer.C:
			t.Fatal("Windows did not report a change from the replacement watch")
		}
	}
}

package platform

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestFileWatcherDeliversChangesWithBoundedDescriptors(t *testing.T) {
	// Recurring bug class: lifecycle opening and closing watches on retained history must not consume descriptors per file.
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for i := range 300 {
		path := filepath.Join(directory, strconv.Itoa(i)+".json")
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	other, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	count := func() uint64 {
		t.Helper()
		fds, err := DescriptorCount(os.Getpid())
		if err != nil {
			t.Fatal(err)
		}
		return fds
	}
	baseline := count()
	for range 3 {
		func() {
			watcher, err := NewFileWatcher()
			if err != nil {
				t.Fatal(err)
			}
			defer watcher.Close()
			if err := watcher.Add(directory); err != nil {
				t.Fatal(err)
			}
			if err := watcher.Add(other); err != nil {
				t.Fatal(err)
			}
			if open := count(); open > baseline+32 {
				t.Fatalf("watch raised open descriptors from %d to %d", baseline, open)
			}
			await := func(path string) {
				t.Helper()
				timer := time.NewTimer(3 * time.Second)
				defer timer.Stop()
				for {
					select {
					case event := <-watcher.Events:
						if event.Name == path {
							return
						}
					case err := <-watcher.Errors:
						t.Fatal(err)
					case <-timer.C:
						t.Fatalf("no event for %s", path)
					}
				}
			}
			target := filepath.Join(directory, "0.json")
			if err := os.WriteFile(target, []byte(time.Now().String()), 0o600); err != nil {
				t.Fatal(err)
			}
			await(target)
			if err := watcher.Remove(directory); err != nil {
				t.Fatal(err)
			}
			temporary, published := filepath.Join(other, "incoming"), filepath.Join(other, "published")
			if err := os.WriteFile(temporary, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(temporary, published); err != nil {
				t.Fatal(err)
			}
			await(published)
		}()
		if open := count(); open > baseline+8 {
			t.Fatalf("descriptors remained open after closing the watch: %d, started with %d", open, baseline)
		}
	}
}

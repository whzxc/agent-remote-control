package core

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestWindowsUninstallWorker(t *testing.T) {
	// Recurring bug class: lifecycle deferred cleanup must publish its result after the CLI exits.
	const childPath = "ARC_TEST_UNINSTALL_WORKER_PATH"
	if path := os.Getenv(childPath); path != "" {
		result, err := scheduleWindowsUninstall("", []string{path}, true, []any{})
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintln(os.Stdout, text(result, "resultPath"))
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}

	path := filepath.Join(t.TempDir(), "ARC uninstall payload")
	if err := os.WriteFile(path, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	child := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestWindowsUninstallWorker$")
	child.Env = append(child.Environ(), childPath+"="+path)
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = child.Process.Kill()
		_ = child.Wait()
	})
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		t.Fatalf("cleanup process was not scheduled: %v", scanner.Err())
	}
	resultPath := scanner.Text()
	t.Cleanup(func() { _ = os.Remove(resultPath) })
	time.Sleep(750 * time.Millisecond)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("payload must survive while the CLI is running: %v", err)
	}
	if _, err := os.Stat(resultPath); !os.IsNotExist(err) {
		t.Fatalf("receipt appeared while the CLI was running: %v", err)
	}
	_ = stdin.Close()
	_, _ = io.Copy(io.Discard, stdout)
	if err := child.Wait(); err != nil {
		t.Fatal(err)
	}

	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		data, err := os.ReadFile(resultPath)
		if os.IsNotExist(err) {
			continue
		}
		var result struct {
			State   string
			Removed []string
		}
		if err != nil || json.Unmarshal(data, &result) != nil || result.State != "completed" ||
			len(result.Removed) != 1 || result.Removed[0] != path {
			t.Fatalf("unexpected cleanup receipt %s (%v)", data, err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("cleanup left its payload: %v", err)
		}
		return
	}
	t.Fatal("cleanup did not publish a result after the CLI exited")
}

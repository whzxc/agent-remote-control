package core

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestWindowsCoreShutdownDeadlineReleasesOwnership(t *testing.T) {
	// Recurring bug class: lifecycle stalled shutdown held Core ownership across a new Desktop launch.
	const childFlag = "ARC_TEST_STALLED_CORE_SHUTDOWN"
	if os.Getenv(childFlag) == "1" {
		lock, err := lockCore()
		if err != nil || lock == nil {
			t.Fatalf("could not acquire Core ownership: %v", err)
		}
		defer lock.Close()
		defer coreShutdownWatchdog(time.Second).Stop()
		endpoint := newInProcess(nil)
		write := requestForEndpoint(endpoint, object{"Management": object{"route": "preferences", "method": "PUT"}}, object{})
		_, release, err := endpoint.begin(t.Context(), write, false)
		if err != nil {
			t.Fatal(err)
		}
		defer release()
		drain, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		if _, err := endpoint.drainRequests(drain); err == nil {
			t.Fatal("shutdown acknowledged an active write")
		}
		fmt.Println("core lock held")
		<-time.After(5 * time.Second)
		t.Fatal("stalled Core did not exit")
	}
	t.Setenv("ARC_STATE_DIR", t.TempDir())
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, executable, "-test.run=^TestWindowsCoreShutdownDeadlineReleasesOwnership$")
	child.Env = append(os.Environ(), childFlag+"=1")
	var stderr bytes.Buffer
	child.Stderr = &stderr
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || strings.TrimSpace(line) != "core lock held" {
		t.Fatalf("stalled owner did not start: %q, %v", line, err)
	}
	if info, err := runtimeOwnerForStartup(ctx, "unused-build"); err != nil || info != nil {
		t.Fatalf("new launch could not wait for ownership: %v, %v", info, err)
	}
	var stopped *exec.ExitError
	if err := child.Wait(); !errors.As(err, &stopped) || stopped.ExitCode() != 1 || !strings.Contains(stderr.String(), "CORE_SHUTDOWN_DEADLINE") {
		t.Fatalf("stalled owner exit = %v, %q", err, stderr.String())
	}
	lock, err := lockCore()
	if err != nil || lock == nil {
		t.Fatalf("new launch could not acquire released Core ownership: %v", err)
	}
	_ = lock.Close()
}

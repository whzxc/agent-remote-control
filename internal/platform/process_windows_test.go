package platform

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWindowsExitedProcessIdentity(t *testing.T) {
	// Recurring bug class: lifecycle an exited process must not appear live while its handle is held.
	child := exec.CommandContext(t.Context(), "cmd.exe", "/d", "/c", "pause >nul")
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	pid := child.Process.Pid
	handle := testProcessHandle(t, pid)
	if ProcessStart(pid) == "" {
		t.Fatal("live process had no identity")
	}
	_ = stdin.Close()
	if err := child.Wait(); err != nil {
		t.Fatal(err)
	}
	waitForTestProcessExit(t, handle)
	if ProcessStart(pid) != "" {
		t.Fatal("exited process still appears live")
	}
}

func TestWindowsVerifiedTree(t *testing.T) {
	// Recurring bug class: security tree termination must preserve unrelated processes and reject a stale root identity.
	const role = "ARC_TEST_WINDOWS_TREE_ROLE"
	switch os.Getenv(role) {
	case "root":
		child := exec.Command(os.Args[0], "-test.run=^TestWindowsVerifiedTree$")
		child.Env = append(child.Environ(), role+"=child")
		child.Stdin = os.Stdin
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		fmt.Println(child.Process.Pid)
		_ = child.Wait()
		return
	case "child":
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	}
	startInstance := func(name string) (*exec.Cmd, *bufio.Scanner) {
		cmd := exec.CommandContext(t.Context(), os.Args[0], "-test.run=^TestWindowsVerifiedTree$")
		cmd.Env = append(cmd.Environ(), role+"="+name)
		stdin, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() })
		return cmd, bufio.NewScanner(stdout)
	}

	independent, _ := startInstance("child")
	root, output := startInstance("root")
	if !output.Scan() {
		t.Fatalf("owned child did not start: %v", output.Err())
	}
	childPID, err := strconv.Atoi(output.Text())
	if err != nil {
		t.Fatal(err)
	}
	child := testProcessHandle(t, childPID)
	rootHandle := testProcessHandle(t, root.Process.Pid)
	rootStart, independentStart := ProcessStart(root.Process.Pid), ProcessStart(independent.Process.Pid)
	if rootStart == "" || independentStart == "" || rootStart == independentStart {
		t.Fatal("test requires two distinct live process identities")
	}

	SignalVerifiedTree(independent.Process.Pid, rootStart, true)
	if ProcessStart(independent.Process.Pid) != independentStart {
		t.Fatal("stale identity stopped another process")
	}
	SignalVerifiedTree(root.Process.Pid, rootStart, true)
	waitForTestProcessExit(t, rootHandle)
	waitForTestProcessExit(t, child)
	if ProcessStart(independent.Process.Pid) != independentStart {
		t.Fatal("stopping the owned tree stopped its independent peer")
	}
}

func testProcessHandle(t *testing.T, pid int) windows.Handle {
	t.Helper()
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(handle) })
	return handle
}

func waitForTestProcessExit(t *testing.T, handle windows.Handle) {
	t.Helper()
	if state, err := windows.WaitForSingleObject(handle, uint32((5 * time.Second).Milliseconds())); state != windows.WAIT_OBJECT_0 || err != nil {
		t.Fatalf("process did not exit: wait=%d err=%v", state, err)
	}
}

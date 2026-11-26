package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "Usage: build-lock LOCK LABEL COMMAND [ARGS...]")
		os.Exit(2)
	}
	if err := run(os.Args[1:]); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() > 0 {
			os.Exit(exit.ExitCode())
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	file, err := os.OpenFile(args[0], os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	locked, err := platform.TryLock(file)
	if err != nil {
		return err
	}
	// Store the label beside the kernel lock. Windows disallows reading the
	// locked byte from a separate handle, even for the wait diagnostic.
	label := args[0] + ".owner"
	if !locked {
		owner, _ := os.ReadFile(label)
		fmt.Fprintf(os.Stderr, "Waiting for native build lock (%s)\n", strings.TrimSpace(string(owner)))
		if err := platform.Lock(file, false); err != nil {
			return err
		}
	}
	if err := os.WriteFile(label, []byte(args[1]), 0600); err != nil {
		return err
	}
	defer os.Remove(label)

	command := exec.Command(args[2], args[3:]...)
	command.Env = append(os.Environ(), "ARC_HEAVY_BUILD_HELD=1")
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case sig := <-signals:
			if err := command.Process.Signal(sig); err != nil {
				_ = command.Process.Kill()
			}
		case <-done:
		}
	}()
	return command.Wait()
}

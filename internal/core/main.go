package core

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"slices"
	"syscall"
)

const PortPending = "GO_PORT_PENDING"
const operatingSystem = runtime.GOOS

const topLevelHelp = "arc start | stop | status | daemon | systemd install | stdio | cli <command>\nConfigure MCP with cli ingress add --stdin; see cli help. daemon runs in the foreground; start detaches."
const topLevelUsage = "Usage: arc [start | stop | status | daemon | systemd install | stdio | serve | cli <command> | --version]"

func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if len(args) > 0 && args[0] == "cli" {
		return runCLI(ctx, args[1:], stdin, stdout, stderr)
	}
	return exitResult(stderr, runCommand(ctx, args, stdin, stdout, stderr))
}

func exitResult(stderr io.Writer, err error) int {
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func runCommand(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 1 {
		switch args[0] {
		case "help", "--help", "-h":
			return outputLine(stdout, topLevelHelp)
		case "--version":
			return outputLine(stdout, buildVersion)
		case "context-provider-stdio":
			return contextProviderStdio(ctx, stdin, stdout, stderr)
		case "stdio":
			return stdioProxy(ctx, stdin, stdout)
		case "status":
			status, err := headlessStatus(ctx)
			if err != nil {
				return err
			}
			return outputLine(stdout, wire(status))
		case "serve", "daemon":
			return serveRuntime(ctx, args[0] == "daemon")
		case "front-door":
			return runFrontDoor(ctx)
		case "start":
			return printResult(stdout, func() (object, error) { return startHeadless(ctx) })
		case "stop":
			return printResult(stdout, func() (object, error) { return stopHeadless(ctx) })
		case "front-door-prepare":
			return prepareFrontDoorCommand(ctx, stdin, stdout, false)
		case "codex-host", "task-host":
			return errors.New(PortPending)
		}
	}
	if slices.Equal(args, []string{"systemd", "install"}) {
		return printResult(stdout, installSystemd)
	}
	if slices.Equal(args, []string{"front-door-prepare", "--hold"}) {
		return prepareFrontDoorCommand(ctx, stdin, stdout, true)
	}
	if runtime.GOOS == "darwin" && len(args) == 2 && args[0] == "package-check" {
		return errors.New(PortPending)
	}
	return errors.New(topLevelUsage)
}

func printResult(out io.Writer, action func() (object, error)) error {
	value, err := action()
	if err != nil {
		return err
	}
	return outputLine(out, wire(value))
}

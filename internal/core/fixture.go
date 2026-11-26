//go:build arcfixture

package core

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

func RunFixture(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if len(args) > 0 {
		switch args[0] {
		case "cli":
			return runCLI(ctx, args[1:], stdin, stdout, stderr)
		case "stdio", "front-door":
			return exitResult(stderr, runCommand(ctx, args, stdin, stdout, stderr))
		case "desktop-get":
			if len(args) < 2 {
				return exitResult(stderr, errors.New("A desktop route is required"))
			}
			value, err := forwardRequest(ctx, args[1], http.MethodGet, object{})
			if err == nil {
				err = outputLine(stdout, wire(value))
			}
			return exitResult(stderr, err)
		}
	}
	mode := "mcp"
	if len(args) != 0 {
		mode = args[0]
	}
	return exitResult(stderr, runFixtureService(ctx, mode, stdin, stdout))
}

// The fixture binds a loopback listener without detached providers or a Desktop.
func runFixtureService(parent context.Context, mode string, stdin io.Reader, stdout io.Writer) error {
	ctx, stop := context.WithCancel(parent)
	defer stop()
	lock, err := lockCore()
	if err != nil {
		return err
	}
	if lock == nil {
		return nil
	}
	defer lock.Close()
	recordLog("INFO", "Service starting", nil)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	build, err := processBuildID()
	if err != nil {
		return err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	token, err := ensureFrontDoorSecret()
	if err != nil {
		return err
	}
	pid := os.Getpid()
	metadata := object{"port": port, "token": token, "pid": pid, "processStart": platform.ProcessStart(pid), "instance": id(),
		"runtime": "go", "version": buildVersion, "owner": "core", "daemon": false, "build": build}
	product := "custom"
	policy := any("all")
	if config, err := load(filepath.Join(root(), "ingresses/default/config.json")); err == nil {
		if controlSource, ok := field(config, "controlSource").(string); ok {
			product = controlSource
		}
		if value := field(config, "toolPolicy"); value != nil {
			policy = value
		}
	}
	s := &service{metadata: metadata, runtime: &runtimeState{leases: make(map[string]lease), stop: stop},
		source: requestSource{origin: object{"controlSource": product}, profile: object{"product": product}, policy: policy}}
	if snapshot, ok := os.LookupEnv("ARC_FIXTURE_SNAPSHOT"); ok {
		s.desktop = fixtureDesktop(snapshot)
	}
	privateCore := newInProcess(s)
	ipc, err := listenPrivate(ctx, "core", token, privateCore)
	if err != nil {
		return err
	}
	defer ipc.Close()
	defer privateCore.drain()
	server := &http.Server{Handler: localHandler(s, port, token), ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 16 * 1024}
	server.SetKeepAlivesEnabled(false)
	ended := make(chan error, 1)
	go func() { ended <- server.Serve(listener) }()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), drainTimeout)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
		}
	}()
	info := filepath.Join(root(), "app/native.json")
	if err := save(info, metadata); err != nil {
		return err
	}
	defer os.Remove(info)
	switch mode {
	case "runtime":
		select {
		case <-ctx.Done():
			return nil
		case err := <-ended:
			return err
		}
	case "http":
		if err := outputLine(stdout, wire(object{"port": port, "token": token})); err != nil {
			return err
		}
		_, err := bufio.NewReader(stdin).ReadString('\n')
		if err == io.EOF {
			return nil
		}
		return err
	default:
		return serveJSONLines(stdin, stdout, func(r object) (any, error) {
			reply, err := s.mcp(ctx, "", r)
			if reply == nil {
				return nil, err
			}
			return reply, err
		})
	}
}

func fixtureDesktop(scenario string) func(context.Context, string, string, object) (any, error) {
	var requests atomic.Uint64
	return func(_ context.Context, route, method string, body object) (any, error) {
		ready := requests.Add(1) > 1
		if route != "app/snapshot" || method != http.MethodPost || body["modelOnly"] != true {
			return nil, fmt.Errorf("FIXTURE_DESKTOP_UNSUPPORTED")
		}
		var state, detail any
		if scenario != "native" {
			state = object{"ready": ready}
		}
		if panel := obj(body["taskPanel"]); panel != nil {
			return nil, errors.New(PortPending)
		}
		return object{"model": object{"layoutSettled": ready, "scenario": state, "taskDetail": detail}}, nil
	}
}

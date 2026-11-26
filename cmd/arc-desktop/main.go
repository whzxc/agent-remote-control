package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"

	"github.com/egoist/mygo"
	"github.com/whzxc/agent-remote-control/internal/core"
)

const (
	productName      = "Agent Remote Control"
	productionID     = "com.whzxc.agent-remote-control"
	productionScheme = "agent-remote-control"
)

var (
	// Packaging sets these for a development build with its own bundle identity.
	bundleID   = productionID
	appName    = productName
	linkScheme = productionScheme
)

type object = map[string]any

type DesktopService struct {
	requests   chan struct{}
	ctx        context.Context
	core       *core.DesktopClient
	closing    atomic.Bool
	window     *mygo.Window // main thread
	ready      bool
	pending    *desktopMessage
	opened     bool
	quitting   bool
	tray       trayState
	appearance appearanceState
	snapshot   snapshotState
	sources    sourceState
	updates    updateState
	locale     atomic.Bool
}

func main() {
	service := &DesktopService{requests: make(chan struct{}, 16)}
	mygo.Bind(service)
	if os.Getenv("MYGO_GENERATE") != "" {
		if err := mygo.App.Run(); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := runDesktop(service); err != nil {
		log.Fatal(err)
	}
}

func runDesktop(service *DesktopService) error {
	if err := initUpdateFixture(); err != nil {
		return err
	}
	args := os.Args[1:]
	for i, argument := range args {
		if argument == "--state-dir" && i+1 < len(args) {
			if err := os.Setenv("ARC_STATE_DIR", args[i+1]); err != nil {
				return err
			}
			break
		}
	}
	if len(args) > 0 && (args[0] == "cli" || args[0] == "stdio") {
		os.Exit(core.RunBundledCLI(args, os.Stdin, os.Stdout, os.Stderr))
	}
	development := bundleID != productionID
	if development {
		if err := validateDevelopmentIdentity(); err != nil {
			return err
		}
	}
	mygo.App.SetName(appName)
	mygo.App.SetVersion(core.DesktopVersion())
	mygo.App.SetWindowStateStore(windowStateStore{})
	if !mygo.App.RequestSingleInstanceLock() {
		return nil
	}
	if development {
		front := filepath.Join(resources(), "frontend")
		if info, err := os.Stat(front); err == nil && info.IsDir() {
			mygo.SetFrontend(os.DirFS(front))
		}
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	service.ctx = ctx
	client, err := core.ConnectDesktop(service.desktopRequest)
	if err != nil {
		return err
	}
	service.core = client
	defer service.close()
	if os.Getenv("ARC_DEV_SUPERVISED") != "" && development {
		go func() {
			var buffer [1024]byte
			for {
				if _, err := os.Stdin.Read(buffer[:]); err != nil {
					cancel()
					return
				}
			}
		}()
	}

	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { service.quitting = true })
	mygo.App.OnQuitCanceled(func() { service.quitting = false })
	mygo.App.OnSecondInstance(func(args []string, _ string) {
		service.show(nil)
		if runtime.GOOS == "windows" && development {
			for _, arg := range args {
				service.openLink(arg)
			}
		}
	})
	mygo.App.OnActivate(func(visible bool) {
		if service.opened && !visible && !isUpdateFixture() {
			service.show(nil)
		}
	})
	mygo.App.OnOpenURL(service.openLink)
	mygo.App.OnNotificationClick(service.notificationActivated)
	mygo.App.WhenReady(func() {
		if err := service.installTray(); err != nil {
			log.Print(err)
		}
		if runtime.GOOS == "darwin" {
			if err := service.installAppearance(); err != nil {
				log.Print(err)
			}
		}
		if runtime.GOOS == "windows" && development {
			for _, arg := range args {
				service.openLink(arg)
			}
		}
		service.installSources()
		window := service.ensureWindow()
		if !service.opened && !isUpdateFixture() {
			service.opened = true
			if development {
				window.ShowInactive()
			} else {
				window.Show()
			}
		}
		go service.observeCore(ctx)
		go func() {
			<-ctx.Done()
			mygo.App.Quit()
		}()
	})
	err = mygo.App.Run()
	cancel()
	return err
}

func validateDevelopmentIdentity() error {
	home, homeErr := os.UserHomeDir()
	state, hasState := os.LookupEnv("ARC_STATE_DIR")
	if homeErr != nil || !filepath.IsAbs(home) || !hasState || !filepath.IsAbs(state) ||
		appName == productName || linkScheme == productionScheme ||
		!strings.HasPrefix(bundleID, productionID+".") ||
		!filepath.IsLocal(relative(home, state)) || home == state ||
		!strings.HasPrefix(filepath.Base(home), "arc-godev-home") {
		return errors.New("Development Desktop requires a distinct name, identifier, URL scheme, isolated home and ARC state directory")
	}
	return nil
}

func relative(base, path string) string {
	value, _ := filepath.Rel(base, path)
	return value
}

func resources() string {
	exe, _ := os.Executable()
	if runtime.GOOS == "darwin" {
		return filepath.Join(filepath.Dir(exe), "..", "Resources")
	}
	return filepath.Dir(exe)
}

func stringAt(body object, key string) string {
	value, _ := body[key].(string)
	return value
}

func objectValue(value any) object {
	row, _ := value.(map[string]any)
	return row
}

func rows(value any) []any {
	list, _ := value.([]any)
	return list
}

func fallback(value, defaultValue string) string {
	if value == "" {
		return defaultValue
	}
	return value
}

func logError(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}

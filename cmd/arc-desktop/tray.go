package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/egoist/mygo"
	"github.com/whzxc/agent-remote-control/internal/core"
)

type trayState struct {
	tray   *mygo.Tray
	menu   *mygo.Menu
	status *mygo.MenuItem
	items  map[*mygo.MenuItem]string
}

func (s *DesktopService) installTray() error {
	state := &s.tray
	state.items = map[*mygo.MenuItem]string{}
	state.status = &mygo.MenuItem{Label: s.trayStatus("unknown"), Disabled: true}
	items := []*mygo.MenuItem{state.status}
	for _, key := range [][2]string{{"overview", "trayOpen"}, {"tasks", "trayTasks"}, {"logs", "trayLogs"}, {"settings", "traySettings"}, {"quit", "trayQuit"}} {
		action, label := key[0], key[1]
		item := &mygo.MenuItem{Label: s.translate(label), Click: func(*mygo.MenuItem, *mygo.Window) {
			if action == "quit" {
				mygo.App.Quit()
			} else {
				s.show(&desktopMessage{"navigate", action})
			}
		}}
		items = append(items, item)
		state.items[item] = label
	}
	state.menu = mygo.NewMenu(items)
	if runtime.GOOS == "darwin" {
		settings := &mygo.MenuItem{Label: s.translate("traySettings"), Accelerator: "Cmd+,", Click: func(*mygo.MenuItem, *mygo.Window) {
			s.show(&desktopMessage{"navigate", "settings"})
		}}
		updates := &mygo.MenuItem{Label: s.translate("checkForUpdates"), Click: func(*mygo.MenuItem, *mygo.Window) {
			s.show(&desktopMessage{"updates:check", nil})
		}}
		state.items[settings], state.items[updates] = "traySettings", "checkForUpdates"
		mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
			{Role: mygo.RoleAppMenu, Submenu: []*mygo.MenuItem{
				{Role: mygo.RoleAbout}, settings, updates, mygo.Separator(), {Role: mygo.RoleServices},
				mygo.Separator(), {Role: mygo.RoleHide}, {Role: mygo.RoleHideOthers}, {Role: mygo.RoleUnhide},
				mygo.Separator(), {Role: mygo.RoleQuit},
			}}, {Role: mygo.RoleEditMenu}, {Role: mygo.RoleViewMenu}, {Role: mygo.RoleWindowMenu},
		}))
	}
	return s.setTrayVisible(true)
}

func (s *DesktopService) setTrayVisible(visible bool) error {
	state := &s.tray
	if visible == (state.tray != nil) {
		return nil
	}
	if !visible {
		state.tray.Destroy()
		state.tray = nil
		return nil
	}
	file := "tray-logo.png"
	if runtime.GOOS == "darwin" {
		file = "menubar-18Template@2x.png"
	}
	png, err := os.ReadFile(filepath.Join(resources(), file))
	if err != nil {
		return err
	}
	tray, err := mygo.NewTray(mygo.TrayOptions{ID: "main-tray", Icon: png, IconIsTemplate: runtime.GOOS == "darwin", ToolTip: appName})
	if err != nil {
		return err
	}
	bindTrayClicks(tray, state.menu, func() { s.show(nil) })
	state.tray = tray
	return nil
}

func (s *DesktopService) trayStatus(key string) string {
	return s.translate("trayConnectionStatus") + ": " + s.translate(key)
}

func (s *DesktopService) observeTray(ctx context.Context) {
	notified := map[string]bool{}
	for ctx.Err() == nil {
		wait, cancel := context.WithTimeout(ctx, 4*time.Second)
		status, err := s.request(wait, "status", http.MethodGet, nil)
		cancel()
		key := "unknown"
		if err == nil {
			value := objectValue(status)
			switch running := number(objectValue(value["ingressSummary"])["running"]); {
			case running > 0:
				key = "trayConnected"
			case running == 0:
				key = "trayDisconnected"
			}
			focused := false
			mygo.RunOnMain(func() { focused = s.window != nil && s.window.IsFocused() })
			current := map[string]bool{}
			for _, ingress := range rows(value["ingresses"]) {
				for _, pending := range rows(objectValue(objectValue(ingress)["oauth"])["pending"]) {
					request := objectValue(pending)
					if stringAt(request, "status") != "pending" {
						continue
					}
					id := stringAt(request, "id")
					current[id] = notified[id]
					if !focused && !current[id] {
						name := fallback(core.DesktopSourceName(fallback(stringAt(request, "product"), "custom")), "MCP client")
						body := strings.NewReplacer("{name}", name, "{code}", stringAt(request, "pairingCode")).Replace(s.translate("connect.notification"))
						if err := notify(ctx, appName, body, "oauth:"+id); err == nil {
							current[id] = true
						}
					}
				}
			}
			notified = current
		}
		mygo.RunOnMain(func() {
			if s.tray.status != nil {
				s.tray.status.SetLabel(s.trayStatus(key))
			}
			for item, message := range s.tray.items {
				item.SetLabel(s.translate(message))
			}
		})
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestDarwinApplicationMenuIncludesStandardSystemShortcuts(t *testing.T) {
	// Contract: macOS application menu must expose standard system menus and shortcuts (Cmd+W, Cmd+Q, Cmd+H, Cmd+M, Cmd+,, Edit/View).
	settings := &mygo.MenuItem{Label: "Settings", Accelerator: "Cmd+,"}
	updates := &mygo.MenuItem{Label: "Check for Updates"}
	menu := darwinApplicationMenu(settings, updates)

	var topRoles []mygo.MenuRole
	byRole := map[mygo.MenuRole]*mygo.MenuItem{}
	var walk func(items []*mygo.MenuItem)
	walk = func(items []*mygo.MenuItem) {
		for _, item := range items {
			if item.Role != "" {
				byRole[item.Role] = item
			}
			if len(item.Submenu) > 0 {
				walk(item.Submenu)
			}
		}
	}
	for _, item := range menu.Items() {
		topRoles = append(topRoles, item.Role)
	}
	walk(menu.Items())

	expectedTop := []mygo.MenuRole{
		mygo.RoleAppMenu,
		mygo.RoleFileMenu,
		mygo.RoleEditMenu,
		mygo.RoleViewMenu,
		mygo.RoleWindowMenu,
	}
	if len(topRoles) != len(expectedTop) {
		t.Fatalf("top-level menus = %v, want %v", topRoles, expectedTop)
	}
	for i, want := range expectedTop {
		if topRoles[i] != want {
			t.Fatalf("top-level menu[%d] = %q, want %q", i, topRoles[i], want)
		}
	}

	requiredShortcuts := map[mygo.MenuRole]string{
		mygo.RoleClose:            "CmdOrCtrl+W",
		mygo.RoleMinimize:         "CmdOrCtrl+M",
		mygo.RoleHide:             "Cmd+H",
		mygo.RoleHideOthers:       "Alt+Cmd+H",
		mygo.RoleQuit:             "Cmd+Q",
		mygo.RoleUndo:             "CmdOrCtrl+Z",
		mygo.RoleRedo:             "Shift+CmdOrCtrl+Z",
		mygo.RoleCut:              "CmdOrCtrl+X",
		mygo.RoleCopy:             "CmdOrCtrl+C",
		mygo.RolePaste:            "CmdOrCtrl+V",
		mygo.RoleSelectAll:        "CmdOrCtrl+A",
		mygo.RoleToggleFullScreen: "Ctrl+Cmd+F",
	}
	for role, wantAccel := range requiredShortcuts {
		item, ok := byRole[role]
		if !ok {
			t.Errorf("missing standard macOS role %q", role)
			continue
		}
		if item.Accelerator != wantAccel {
			t.Errorf("role %q accelerator = %q, want %q", role, item.Accelerator, wantAccel)
		}
	}

	services, ok := byRole[mygo.RoleServices]
	if !ok {
		t.Fatal("missing Services menu item")
	}
	if services.Submenu == nil {
		t.Fatal("Services menu item must have a non-nil submenu so AppKit registers NSApp.servicesMenu")
	}
}

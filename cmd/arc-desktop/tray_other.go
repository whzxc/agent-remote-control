//go:build !darwin

package main

import (
	"runtime"

	"github.com/egoist/mygo"
)

func bindTrayClicks(tray *mygo.Tray, menu *mygo.Menu, show func()) {
	tray.OnClick(show)
	if runtime.GOOS == "windows" {
		tray.SetMenu(menu)
	} else {
		tray.OnRightClick(func() { menu.Popup(nil) })
	}
}

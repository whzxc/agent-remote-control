package main

import (
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

func bindTrayClicks(tray *mygo.Tray, menu *mygo.Menu, show func()) {
	// AppKit tracks menus in a nested event loop. Ignore reentrant actions
	// while the menu is temporarily attached to the status item.
	tracking := false
	tray.OnClick(func() {
		if !tracking {
			show()
		}
	})
	tray.OnRightClick(func() {
		if tracking {
			return
		}
		tracking = true
		defer func() { tracking = false }()
		defer cocoaPool()()

		app := cocoaClass("NSApplication").Send(objc.RegisterName("sharedApplication"))
		event := app.Send(objc.RegisterName("currentEvent"))
		content := event.Send(objc.RegisterName("window")).Send(objc.RegisterName("contentView"))
		button := clickedStatusButton(content)

		tray.SetMenu(menu)
		defer tray.SetMenu(nil)
		if button != 0 {
			// The clicked button may be the copy on a secondary display.
			// Let AppKit position the attached menu and keep it highlighted.
			button.Send(objc.RegisterName("performClick:"), objc.ID(0))
		} else {
			// Accessibility actions can arrive without a window event.
			tray.PopUpMenu()
		}
	})
}

func clickedStatusButton(view objc.ID) objc.ID {
	if objc.Send[bool](view, objc.RegisterName("isKindOfClass:"), cocoaClass("NSStatusBarButton")) &&
		objc.Send[objc.SEL](view, objc.RegisterName("action")) == objc.RegisterName("mygoTrayClicked:") {
		return view
	}
	children := view.Send(objc.RegisterName("subviews"))
	for i, count := uint(0), objc.Send[uint](children, objc.RegisterName("count")); i < count; i++ {
		if button := clickedStatusButton(children.Send(objc.RegisterName("objectAtIndex:"), i)); button != 0 {
			return button
		}
	}
	return 0
}

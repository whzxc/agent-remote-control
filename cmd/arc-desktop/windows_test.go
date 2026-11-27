package main

import (
	"testing"

	"github.com/egoist/mygo"
)

func TestMainWindowKeepsNativeHiddenTitleBarControls(t *testing.T) {
	// Contract: main desktop window must use MyGo hidden title bar controls rather than hiding Windows caption buttons.
	opts := mainWindowOptions()
	if opts.TitleBarStyle != mygo.TitleBarHidden {
		t.Fatalf("TitleBarStyle = %q, want %q", opts.TitleBarStyle, mygo.TitleBarHidden)
	}
	if opts.TitleBarHeight != 38 {
		t.Fatalf("TitleBarHeight = %d, want 38", opts.TitleBarHeight)
	}
	if opts.HideWindowButtons {
		t.Fatal("HideWindowButtons = true, want false so Windows renders operable caption controls")
	}
	if opts.Transparent {
		t.Fatal("Transparent = true, want false so the opaque canvas window avoids redirection-bitmap conflicts")
	}
	if opts.BackgroundColor != "light-dark(#f3eee7, #171412)" {
		t.Fatalf("BackgroundColor = %q, want %q", opts.BackgroundColor, "light-dark(#f3eee7, #171412)")
	}
	if got := windowsButtonsTheme(true); got != mygo.ThemeDark {
		t.Fatalf("windowsButtonsTheme(true) = %q, want %q", got, mygo.ThemeDark)
	}
	if got := windowsButtonsTheme(false); got != mygo.ThemeLight {
		t.Fatalf("windowsButtonsTheme(false) = %q, want %q", got, mygo.ThemeLight)
	}
}

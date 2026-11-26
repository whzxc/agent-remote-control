//go:build !windows

package main

import "github.com/egoist/mygo"

func installWindowsFrame(*mygo.Window)           {}
func applyWindowsFrame(*mygo.Window, bool) error { return nil }

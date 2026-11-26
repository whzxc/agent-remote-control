//go:build unix

package platform

import "os/exec"

func ConfigureCommand(_ *exec.Cmd) {}

func DecodeOEM(_ []byte) (string, bool) { return "", false }

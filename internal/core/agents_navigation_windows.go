package core

import (
	"encoding/base64"
	"encoding/binary"
	"os/exec"
	"strings"
	"syscall"
	"unicode/utf16"
)

func openWindowsNativeAgentLauncher(home, executable, suffix string) error {
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	script := "Set-Location -LiteralPath " + quote(home) + "; & " + quote(executable) + suffix
	var encoded []byte
	for _, unit := range utf16.Encode([]rune(script)) {
		encoded = binary.LittleEndian.AppendUint16(encoded, unit)
	}
	command := exec.Command("powershell.exe", "-NoLogo", "-NoExit", "-EncodedCommand", base64.StdEncoding.EncodeToString(encoded))
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x10}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/sys/windows"
)

func connectNativeDesktop(ctx context.Context, _ string) (net.Conn, error) {
	const pipe = `\\.\pipe\codex-ipc`
	stream, err := platform.DialIPC(ctx, pipe)
	if err != nil {
		return nil, nativeDesktopEndpointError(pipe, err)
	}
	if err := verifyDesktopPipeUser(stream); err != nil {
		_ = stream.Close()
		return nil, err
	}
	return stream, nil
}

func verifyDesktopPipeUser(stream net.Conn) error {
	unavailable := errors.New("DESKTOP_PIPE_OWNER_UNAVAILABLE")
	pipe, ok := stream.(interface{ Fd() uintptr })
	if !ok {
		return unavailable
	}
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(windows.Handle(pipe.Fd()), &pid); err != nil {
		return unavailable
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return unavailable
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return unavailable
	}
	defer token.Close()
	owner, err := token.GetTokenUser()
	if err != nil {
		return unavailable
	}
	current, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return unavailable
	}
	if !owner.User.Sid.Equals(current.User.Sid) {
		return errors.New("DESKTOP_PIPE_OWNER_MISMATCH")
	}
	return nil
}

var nativeWindowsCodexInstallation struct {
	sync.Mutex
	app, binary, root string
}

func discoverWindowsCodexInstallation() (string, string) {
	cache := &nativeWindowsCodexInstallation
	cache.Lock()
	defer cache.Unlock()
	exists := func(path string) bool {
		info, err := os.Stat(path)
		return err == nil && info.Mode().IsRegular()
	}
	if cache.root == root() && exists(cache.app) && exists(cache.binary) {
		return cache.app, cache.binary
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	const command = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation"
	output, err := nativeCommand(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command).Output()
	if err != nil || strings.TrimSpace(string(output)) == "" {
		return "", ""
	}
	app := filepath.Join(strings.TrimSpace(string(output)), "app", "ChatGPT.exe")
	if !exists(app) {
		return "", ""
	}
	resources := filepath.Join(filepath.Dir(app), "resources")
	names := []string{"codex.exe", "codex-code-mode-host.exe", "codex-windows-sandbox-setup.exe", "codex-command-runner.exe"}
	digest := sha256.New()
	for _, name := range names {
		digest.Write([]byte(name))
		file, err := os.Open(filepath.Join(resources, name))
		if err != nil {
			return "", ""
		}
		_, issue := io.Copy(digest, file)
		if err := errors.Join(issue, file.Close()); err != nil {
			return "", ""
		}
	}
	directory := filepath.Join(root(), "bin", "codex-desktop", hex.EncodeToString(digest.Sum(nil)))
	if err := platform.PrivateDir(directory); err != nil {
		return "", ""
	}
	for _, name := range names {
		source, destination := filepath.Join(resources, name), filepath.Join(directory, name)
		info, err := os.Stat(source)
		if err != nil {
			return "", ""
		}
		if copy, err := os.Stat(destination); err == nil && copy.Mode().IsRegular() && copy.Size() == info.Size() {
			continue
		}
		if err := copyWindowsCodexResource(source, destination); err != nil {
			return "", ""
		}
	}
	cache.app, cache.binary, cache.root = app, filepath.Join(directory, "codex.exe"), root()
	return cache.app, cache.binary
}

func copyWindowsCodexResource(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.CreateTemp(filepath.Dir(destination), ".codex-copy-")
	if err != nil {
		return err
	}
	defer os.Remove(output.Name())
	_, err = io.Copy(output, input)
	if err := errors.Join(err, output.Close()); err != nil {
		return err
	}
	return platform.ReplaceFile(output.Name(), destination)
}

func openWindowsCodexURL(target string) error {
	if target == "" {
		target = "codex://"
	}
	encoded, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	shellExecute := windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteW")
	// ShellExecute's return value is the launch result. The OS may leave last-error unchanged.
	result, _, _ := shellExecute.Call(0, 0, uintptr(unsafe.Pointer(encoded)), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("DESKTOP_OPEN_FAILED:%d", result)
	}
	return nil
}

func init() {
	nativeWindowsCodexBinary = func() string {
		_, binary := discoverWindowsCodexInstallation()
		return binary
	}
	nativeWindowsCodexOpen = openWindowsCodexURL
}

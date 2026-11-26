package core

import (
	"bytes"
	"cmp"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
	"github.com/whzxc/agent-remote-control/internal/platform"
	"golang.org/x/sys/unix"
)

type nativeDesktopInstance struct {
	pid                          int
	start, profile, endpoint, id string
}

func (i nativeDesktopInstance) identity() object {
	return object{"pid": i.pid, "start": i.start}
}

func (i nativeDesktopInstance) running() bool {
	return i.start != "" && platform.ProcessStart(i.pid) == i.start
}

func (i nativeDesktopInstance) independent() bool {
	if !isNativeIndependentDesktopProfile(i.profile) {
		return false
	}
	record, err := cachedLoad(nativeDesktopLaunchRecord(i.profile))
	return err == nil && (i.id != "" && i.id == field(record, "launchId") || wire(field(record, "legacyInstance")) == wire(i.identity()))
}

func (i nativeDesktopInstance) uses(socket string) bool {
	return i.endpoint == nativeDesktopSocketURL(socket)
}

func nativeIndependentDesktopProfile(alternate bool) string {
	name := "codex-desktop"
	if alternate {
		name += "-alternate"
	}
	return filepath.Join(root(), name)
}

func isNativeIndependentDesktopProfile(profile string) bool {
	return profile == nativeIndependentDesktopProfile(false) || profile == nativeIndependentDesktopProfile(true)
}

func nativeDesktopLaunchRecord(profile string) string {
	if profile == nativeIndependentDesktopProfile(true) {
		return filepath.Join(root(), "desktop-launch-alternate.json")
	}
	return filepath.Join(root(), "desktop-launch.json")
}

func nativeDesktopSocketURL(socket string) string { return "ws+unix://localhost" + socket + ":/rpc" }

func nativeSharedDesktopSocket() (string, error) {
	home, err := nativeCodexHome()
	if err != nil {
		return "", err
	}
	socket, err := filepath.EvalSymlinks(filepath.Join(home, "app-server-control", "app-server-control.sock"))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(socket)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || stat.Uid != uint32(os.Geteuid()) {
		return "", errors.New("DESKTOP_DAEMON_SOCKET_OWNER_MISMATCH")
	}
	return socket, nil
}

type nativeDesktopProcess struct {
	uid, pid, parent int
	tty, executable  string
}

func listNativeDesktopProcesses(ctx context.Context) ([]nativeDesktopProcess, error) {
	output, err := commandOutput(ctx, "/bin/ps", "-axww", "-o", "uid=,pid=,ppid=,tty=,comm=")
	if err != nil {
		return nil, err
	}
	rows := []nativeDesktopProcess{}
	for line := range strings.SplitSeq(output, "\n") {
		var uid, pid, parent int
		var tty string
		if n, _ := fmt.Sscan(line, &uid, &pid, &parent, &tty); n != 4 {
			continue
		}
		rest := strings.TrimSpace(line)
		for range 4 {
			i := strings.IndexAny(rest, " \t")
			if i < 0 {
				rest = ""
				break
			}
			rest = strings.TrimSpace(rest[i:])
		}
		if strings.HasPrefix(tty, "?") || tty == "-" {
			tty = ""
		}
		rows = append(rows, nativeDesktopProcess{uid, pid, parent, tty, rest})
	}
	return rows, nil
}

var nativeDesktopProcArgs = sync.OnceValues(func() (func(int, int) ([]byte, error), error) {
	lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_LOCAL|purego.RTLD_LAZY)
	if err != nil {
		return nil, err
	}
	var call func(*int32, uint32, *byte, *uintptr, *byte, uintptr) int32
	purego.RegisterLibFunc(&call, lib, "sysctl")
	return func(kind, pid int) ([]byte, error) {
		mib := [...]int32{unix.CTL_KERN, int32(kind), int32(pid)}
		var size uintptr
		if call(&mib[0], uint32(len(mib)), nil, &size, nil, 0) != 0 || size < 4 || size > 1<<20 {
			return nil, errors.New("DESKTOP_PROCESS_SCOPE_UNAVAILABLE")
		}
		data := make([]byte, size)
		if call(&mib[0], uint32(len(mib)), &data[0], &size, nil, 0) != 0 || size < 4 || size > uintptr(len(data)) {
			return nil, errors.New("DESKTOP_PROCESS_SCOPE_UNAVAILABLE")
		}
		return data[:size], nil
	}, nil
})

func nativeDesktopProcessScope(pid int) (map[string]string, error) {
	read, err := nativeDesktopProcArgs()
	if err != nil {
		return nil, err
	}
	const kernProcargs2 = 49
	data, err := read(kernProcargs2, pid)
	if err != nil {
		return nil, err
	}
	argc := int(binary.NativeEndian.Uint32(data[:4]))
	_, data, ok := bytes.Cut(data[4:], []byte{0})
	if !ok || argc <= 0 {
		return nil, errors.New("DESKTOP_PROCESS_SCOPE_UNAVAILABLE")
	}
	data = bytes.TrimLeft(data, "\x00")
	for range argc {
		_, data, ok = bytes.Cut(data, []byte{0})
		if !ok {
			return nil, errors.New("DESKTOP_PROCESS_SCOPE_UNAVAILABLE")
		}
	}
	result := map[string]string{}
	for raw := range bytes.SplitSeq(data, []byte{0}) {
		if len(raw) == 0 {
			break
		}
		name, value, found := strings.Cut(string(raw), "=")
		switch name {
		case "CODEX_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CODEX_APP_SERVER_WS_URL", "ARC_DESKTOP_LAUNCH_ID":
			if found {
				result[name] = value
			}
		}
	}
	return result, nil
}

func nativeDesktopAppBundle(binary string) string {
	for directory := filepath.Dir(binary); ; directory = filepath.Dir(directory) {
		if strings.HasSuffix(directory, ".app") && filepath.Base(directory) != "CodexCLI.app" {
			return directory
		}
		if directory == filepath.Dir(directory) {
			return ""
		}
	}
}

func nativeDesktopInstances(rows []nativeDesktopProcess) ([]nativeDesktopInstance, error) {
	if fixtureUsesDesktop != nil {
		return nil, nil
	}
	binary := desktopCodexBinary()
	if binary == "" {
		return nil, nil
	}
	app := nativeDesktopAppBundle(binary)
	executable := filepath.Join(app, "Contents", "MacOS", strings.TrimSuffix(filepath.Base(app), ".app"))
	userHome, err := os.UserHomeDir()
	if err != nil {
		return nil, errors.New("CODEX_HOME_UNAVAILABLE")
	}
	home, err := nativeCodexHome()
	if err != nil {
		return nil, err
	}
	canonical := func(directory string) string {
		if actual, err := filepath.EvalSymlinks(directory); err == nil {
			return actual
		}
		return directory
	}
	home = canonical(home)
	var result []nativeDesktopInstance
	for _, row := range rows {
		if row.uid != os.Geteuid() || row.executable != executable {
			continue
		}
		start := platform.ProcessStart(row.pid)
		if start == "" {
			continue
		}
		environment, err := nativeDesktopProcessScope(row.pid)
		if err != nil {
			return nil, err
		}
		ownerHome := nonemptyTaskText(environment["CODEX_HOME"], filepath.Join(userHome, ".codex"))
		if canonical(ownerHome) == home {
			result = append(result, nativeDesktopInstance{row.pid, start, environment["CODEX_ELECTRON_USER_DATA_PATH"],
				environment["CODEX_APP_SERVER_WS_URL"], environment["ARC_DESKTOP_LAUNCH_ID"]})
		}
	}
	return result, nil
}

func nativeDesktopPeerPID(socket string) (int, error) {
	conn, err := net.DialTimeout("unix", socket, 2*time.Second)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	stream, ok := conn.(*net.UnixConn)
	if !ok {
		return 0, errors.New("DESKTOP_DAEMON_IDENTITY_UNAVAILABLE")
	}
	control, err := stream.SyscallConn()
	if err != nil {
		return 0, err
	}
	var pid int
	var socketErr error
	err = control.Control(func(fd uintptr) {
		pid, socketErr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	})
	if err != nil || socketErr != nil || pid <= 0 {
		return 0, errors.New("DESKTOP_DAEMON_IDENTITY_UNAVAILABLE")
	}
	return pid, nil
}

func nativeDesktopConnected(ctx context.Context, socket, profile string) (*nativeDesktopInstance, error) {
	rows, err := listNativeDesktopProcesses(ctx)
	if err != nil {
		return nil, err
	}
	instances, err := nativeDesktopInstances(rows)
	if err != nil {
		return nil, err
	}
	candidates := slices.DeleteFunc(instances, func(value nativeDesktopInstance) bool {
		return !value.uses(socket) || profile != "" && value.profile != profile
	})
	if len(candidates) == 0 {
		return nil, nil
	}
	slices.SortFunc(candidates, func(a, b nativeDesktopInstance) int {
		if (a.profile == "") != (b.profile == "") {
			if a.profile == "" {
				return -1
			}
			return 1
		}
		return cmp.Compare(a.pid, b.pid)
	})
	peer, err := nativeDesktopPeerPID(socket)
	if err != nil {
		return nil, nil
	}
	parents := map[int]int{}
	for _, row := range rows {
		if row.uid == os.Geteuid() {
			parents[row.pid] = row.parent
		}
	}
	owner := func(pid int) int {
		for range 12 {
			for _, candidate := range candidates {
				if candidate.pid == pid {
					return candidate.pid
				}
			}
			parent, known := parents[pid]
			if !known || parent <= 0 {
				break
			}
			pid = parent
		}
		return 0
	}
	pids := []string{strconv.Itoa(peer)}
	for pid := range parents {
		if pid != peer && owner(pid) != 0 {
			pids = append(pids, strconv.Itoa(pid))
		}
	}
	wait, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	output, err := nativeCommand(wait, "/usr/sbin/lsof", "-nP", "-U", "-a", "-p", strings.Join(pids, ","), "-Fpfdn").Output()
	if wait.Err() != nil {
		return nil, nil
	}
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return nil, fmt.Errorf("DESKTOP_SOCKET_OBSERVATION_FAILED: %w", err)
	}
	type descriptor struct {
		pid    int
		device string
		name   string
	}
	var descriptors []descriptor
	var current descriptor
	for line := range strings.SplitSeq(string(output), "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			current.pid, _ = strconv.Atoi(line[1:])
			current.device = ""
		case 'f':
			current.device = ""
		case 'd':
			current.device = line[1:]
		case 'n':
			current.name = line[1:]
			if current.pid != 0 && current.device != "" {
				descriptors = append(descriptors, current)
			}
		}
	}
	server := map[string]bool{}
	for _, descriptor := range descriptors {
		if descriptor.pid == peer && descriptor.name == socket {
			server[descriptor.device] = true
		}
	}
	for _, instance := range candidates {
		if instance.running() && slices.ContainsFunc(descriptors, func(descriptor descriptor) bool {
			device, linked := strings.CutPrefix(descriptor.name, "->")
			return linked && owner(descriptor.pid) == instance.pid && server[device]
		}) {
			return &instance, nil
		}
	}
	return nil, nil
}

func nativePrivateDesktopRunning(ctx context.Context) bool {
	if fixtureUsesDesktop != nil {
		return false
	}
	rows, err := listNativeDesktopProcesses(ctx)
	if err != nil {
		return true
	}
	instances, err := nativeDesktopInstances(rows)
	if err != nil {
		return true
	}
	path, err := codexHostLocation(primaryCodexProfile, ".sock")
	if err == nil {
		path, err = filepath.EvalSymlinks(path)
	}
	for _, instance := range instances {
		if err != nil && instance.independent() || err == nil && instance.uses(path) {
			return true
		}
	}
	return false
}

func runNativeDesktopCommand(ctx context.Context, binary string, timeout time.Duration, args ...string) error {
	home, err := nativeCodexHome()
	if err != nil {
		return err
	}
	wait, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := nativeCommand(wait, binary, args...)
	command.Env = append(command.Environ(), "CODEX_HOME="+home)
	err = command.Run()
	if wait.Err() != nil {
		return errors.New("DESKTOP_RECOVERY_TIMEOUT")
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return fmt.Errorf("DESKTOP_RECOVERY_COMMAND_FAILED: %s exited %s", filepath.Base(binary), exit.ProcessState)
	}
	return err
}

func startNativeSharedDesktopDaemon(ctx context.Context) error {
	if socket, err := nativeSharedDesktopSocket(); err == nil {
		if _, err := nativeDesktopPeerPID(socket); err == nil {
			return nil
		}
	} else if err.Error() == "DESKTOP_DAEMON_SOCKET_OWNER_MISMATCH" {
		return err
	}
	binary := desktopCodexBinary()
	if binary == "" {
		return errors.New("Install Codex Desktop and ensure its bundled Codex CLI is available")
	}
	return runNativeDesktopCommand(ctx, binary, 12*time.Second, "app-server", "daemon", "start")
}

func launchNativeDesktopInstance(ctx context.Context, profile, socket string) error {
	binary := desktopCodexBinary()
	if binary == "" {
		return errors.New("Install Codex Desktop and ensure its bundled Codex CLI is available")
	}
	app := nativeDesktopAppBundle(binary)
	home, err := nativeCodexHome()
	if err != nil {
		return err
	}
	args := []string{"-g", "--env", "CODEX_HOME=" + home, "--env", "CODEX_APP_SERVER_WS_URL=" + nativeDesktopSocketURL(socket)}
	if isNativeIndependentDesktopProfile(profile) {
		launch := id()
		if err := save(nativeDesktopLaunchRecord(profile), object{"launchId": launch}); err != nil {
			return err
		}
		args = append(args, "--env", "ARC_DESKTOP_LAUNCH_ID="+launch)
	}
	if profile != "" {
		if err := platform.PrivateDir(profile); err != nil {
			return err
		}
		args = append(args, "-n", "--env", "CODEX_ELECTRON_USER_DATA_PATH="+profile, "-a", app, "--args", "--user-data-dir="+profile)
	} else {
		args = append(args, "-a", app)
	}
	return runNativeDesktopCommand(ctx, "/usr/bin/open", 5*time.Second, args...)
}

var attachNativeFoundation = sync.OnceValue(func() error {
	_, err := purego.Dlopen("/System/Library/Frameworks/Foundation.framework/Foundation", purego.RTLD_LOCAL|purego.RTLD_LAZY)
	return err
})

func sendNativeDesktopEvent(instance nativeDesktopInstance, class, kind uint32, value string) error {
	if !instance.running() {
		return errors.New("DESKTOP_RECOVERY_TARGET_CHANGED")
	}
	if err := attachNativeFoundation(); err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	sel := objc.RegisterName
	pool := objc.Send[objc.ID](objc.ID(objc.GetClass("NSAutoreleasePool")), sel("new"))
	defer objc.Send[objc.ID](pool, sel("drain"))
	descriptor := objc.ID(objc.GetClass("NSAppleEventDescriptor"))
	target := objc.Send[objc.ID](descriptor, sel("descriptorWithProcessIdentifier:"), int32(instance.pid))
	event := objc.Send[objc.ID](descriptor, sel("appleEventWithEventClass:eventID:targetDescriptor:returnID:transactionID:"),
		class, kind, target, int16(-1), int32(0))
	if value != "" {
		text := objc.Send[objc.ID](objc.ID(objc.GetClass("NSString")), sel("stringWithUTF8String:"), value)
		param := objc.Send[objc.ID](descriptor, sel("descriptorWithString:"), text)
		objc.Send[objc.ID](event, sel("setParamDescriptor:forKeyword:"), param, uint32(0x2d2d2d2d))
	}
	if !instance.running() {
		return errors.New("DESKTOP_RECOVERY_TARGET_CHANGED")
	}
	var issue objc.ID
	const waitForReplyAndNeverInteract = uintptr(0x3 | 0x10)
	reply := objc.Send[objc.ID](event, sel("sendEventWithOptions:timeout:error:"), waitForReplyAndNeverInteract, 4.0, &issue)
	if reply == 0 {
		if issue != 0 {
			reason := objc.Send[objc.ID](issue, sel("localizedDescription"))
			message := objc.Send[string](reason, sel("UTF8String"))
			return errors.New("DESKTOP_EVENT_FAILED: " + message)
		}
		return errors.New("DESKTOP_EVENT_FAILED: no reply")
	}
	status := objc.Send[objc.ID](reply, sel("paramDescriptorForKeyword:"), uint32(0x6572726e))
	if status != 0 {
		if code := objc.Send[int32](status, sel("int32Value")); code != 0 {
			return fmt.Errorf("DESKTOP_EVENT_FAILED: Apple event error %d", code)
		}
	}
	return nil
}

func init() {
	codexDesktopAttached = nativePrivateDesktopRunning
	rpcDesktopPeer = nativeDesktopPeerPID
	nativeDesktopSharedSocket = nativeSharedDesktopSocket
}

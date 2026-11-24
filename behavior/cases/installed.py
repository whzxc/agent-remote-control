#!/usr/bin/env python3
"""Installed handback runbooks. Run over SSH on the dedicated MacBook."""
import fcntl
import json
import os
from pathlib import Path
import plistlib
import select
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid


def host_time_ns():
    # System Python 3.9 on macOS offsets monotonic_ns() per interpreter.
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def stop(reason):
    raise SystemExit(reason)


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def cli(*args, body=None):
    reply = subprocess.run([arc, "cli", "--state-dir", state, *args],
                          input=json.dumps(body) if body is not None else None,
                          text=True, capture_output=True)
    if reply.returncode:
        print(reply.stdout, end="")
        print(reply.stderr, end="", file=sys.stderr)
        raise SystemExit(reply.returncode)
    return reply.stdout


def process_identity(pid):
    return output("/bin/ps", "-p", str(pid), "-o", "uid=,lstart=,comm=")


def desktop_processes():
    matches = []
    for row in output("/bin/ps", "-axww", "-o", "pid=,uid=,comm=").splitlines():
        pid, uid, exe = row.split(None, 2)
        if int(uid) != os.getuid() or exe != str(desktop):
            continue
        args = output("/bin/ps", "-ww", "-p", pid, "-o", "command=").split()
        matches.append((int(pid), f"--user-data-dir={state}/codex-desktop" in args))
    return matches


def independent():
    matches = [pid for pid, in_profile in desktop_processes() if in_profile]
    if len(matches) != 1:
        stop(f"Expected one Codex Desktop in the case profile, found {matches}")
    pid = matches[0]
    return pid, process_identity(pid)


if (sys.platform != "darwin" or not output("/usr/sbin/sysctl", "-n", "hw.model").startswith("MacBook")
        or output("/usr/bin/id", "-un") != "wh"
        or not os.environ.get("SSH_CONNECTION")):
    stop("Run on the dedicated MacBook as wh.")
if len(sys.argv) < 2:
    stop("Usage: installed.py init | RUN arc-start|configure|dispatch|main-start|instance|crash|core-cycle|ctl ...")
if sys.argv[1:] == ["init"]:
    root = Path(tempfile.mkdtemp(prefix="arc-handback-", dir="/private/tmp"))
    (root / "project").mkdir(mode=0o700)
    (root / "macbook-case").touch(mode=0o600)
    print(root)
    sys.exit()

root = Path(sys.argv[1])
if (root != root.resolve() or root.parent != Path("/private/tmp") or
        not root.name.startswith("arc-handback-") or not (root / "macbook-case").is_file()):
    stop("Pass the fresh root returned by init.")
for directory in [root, root / "project"]:
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        stop(f"Invalid private case directory: {directory}")
plist = Path.home() / "Library/LaunchAgents/com.whzxc.agent-remote-control.plist"
with plist.open("rb") as job_file:
    job = plistlib.load(job_file)
job_env = job["EnvironmentVariables"]
state = Path(job_env["ARC_STATE_DIR"])
home = Path(job_env.get("CODEX_HOME", Path.home() / ".codex"))
if not state.is_absolute() or not state.is_dir() or not home.is_dir():
    stop("Verify the existing LaunchAgent state and native Codex home.")
arc_app = Path("/Applications/Agent Remote Control.app")
arc = arc_app / "Contents/Resources/bin/arc"
bundles = [Path("/Applications") / (name + ".app") for name in ["ChatGPT", "Codex"]]
native_cli = Path("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
app = next((p for p in bundles if (p / native_cli).is_file()), None)
if not app or not arc.is_file():
    stop("Install the case ARC and Codex Desktop bundles on the MacBook first.")
desktop = app / "Contents/MacOS" / app.stem
os.environ.update(CODEX_HOME=str(home), ARC_STATE_DIR=str(state))
os.environ.pop("CODEX_APP_SERVER_WS_URL", None)
os.chdir(root / "project")
cmd, *args = sys.argv[2:]


if cmd == "login":
    subprocess.run([app / native_cli, "login", "status"], check=True)
elif cmd == "arc-start":
    subprocess.run(["/bin/launchctl", "kickstart", f"gui/{os.getuid()}/{job['Label']}"], check=True)
    print(cli("wait", "--op", "app.status", "--until", "/pid exists", "--timeout", "60"))
elif cmd == "configure":
    cli("wait", "--op", "app.status", "--until", "/pid exists", "--timeout", "60")
    print(cli("call", "tasks.settings.set", "--stdin", body={"body": {
        "autoOpenCodex": True, "desktopRecovery": "independent"}}))
elif cmd == "dispatch":
    if any(not in_profile for _, in_profile in desktop_processes()):
        stop("Quit the MacBook main Desktop before seeding independent dispatch.")
    title, prompt = args
    print(cli("control", "codex_create", "--stdin", body={
        "project": str(root / "project"), "title": title, "prompt": prompt,
        "purpose": "self-test", "notify": None}))
elif cmd == "main-start":
    if any(not in_profile for _, in_profile in desktop_processes()):
        stop("Main Desktop already running; select its window through ARC screen.")
    subprocess.run(["/usr/bin/open", "-n", "-g", "--env", f"CODEX_HOME={home}", "-a", app], check=True)
elif cmd == "instance":
    pid, identity = independent()
    print(json.dumps({"pid": pid, "identity": identity, "profile": str(state / "codex-desktop")}))
elif cmd in {"crash", "terminate", "watch-exit"}:
    expected = json.loads((root / "instance-before.json").read_text())
    pid, identity = independent()
    if expected != {"pid": pid, "identity": identity, "profile": str(state / "codex-desktop")}:
        stop("The recorded independent instance changed.")
    if cmd == "watch-exit":
        with select.kqueue() as queue:
            event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD,
                                  fflags=select.KQ_NOTE_EXIT)
            queue.control([event], 0, 0)
            print(f"Armed for independent PID {pid}", file=sys.stderr, flush=True)
            if not queue.control(None, 1, 300):
                stop("Exit observation timed out")
            print(json.dumps({"event": "instance-exit", "pid": pid, "monotonicNs": host_time_ns()}))
    else:
        os.kill(pid, signal.SIGKILL if cmd == "crash" else signal.SIGTERM)
elif cmd in {"core-cycle", "core-crash"}:
    status = json.loads(output(arc, "status"))
    if status.get("stateDirectory") != str(state) or status.get("running") is not True:
        stop("Could not identify the Core for this run.")
    pid = int(status["pid"])
    identity = process_identity(pid)
    if identity.split()[0] != str(os.getuid()) or json.loads(output(arc, "status")).get("pid") != pid:
        stop("Core identity changed.")
    if process_identity(pid) != identity:
        stop("Core launch identity changed.")
    os.kill(pid, signal.SIGKILL if cmd == "core-crash" else signal.SIGTERM)
    print("Reconnect to this ARC instance and verify a new Core PID before continuing.")
elif cmd in {"locks", "sample"}:
    for identifier in args:
        thread = str(uuid.UUID(identifier))
        lock = home / "thread-writer-locks" / (thread + ".lock")
        if lock.parent.resolve() != lock.parent:
            stop("Invalid case lock directory.")
        try:
            fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            status = "clear"
        else:
            with os.fdopen(fd, "rb") as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    status = "clear"
                except BlockingIOError:
                    status = "held"
        row = {"threadId": thread, "writer": status, "monotonicNs": host_time_ns()}
        if cmd == "sample":
            row["owner"] = json.loads(cli("control", "codex_owner", "--stdin", body={"threadId": thread}))
            row["observedNs"] = host_time_ns()
        print(json.dumps(row), flush=True)
elif cmd == "subscribe":
    thread = str(uuid.UUID(args[0]))
    endpoint = home / "app-server-control/app-server-control.sock"
    if endpoint.resolve() != endpoint or not stat.S_ISSOCK(endpoint.stat().st_mode) or endpoint.stat().st_uid != os.getuid():
        stop("Invalid MacBook daemon endpoint.")
    script = Path(__file__).resolve().parent / "foreign-holder-reported/subscriber.mjs"
    local, remote = socket.socketpair()
    with local, remote:
        proxy = subprocess.Popen([app / native_cli, "app-server", "proxy", "--sock", endpoint],
                                 stdin=remote, stdout=remote)
        remote.close()
        try:
            subprocess.run(["node", script, str(local.fileno()), thread], pass_fds=(local.fileno(),), check=True)
        finally:
            local.close()
            try:
                proxy.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait()
elif cmd == "capture-detail":
    thread, = args
    def read_call(name, body):
        return json.loads(cli("call", name, "--stdin", body=body))["result"]
    activity = read_call("agents.activity", {})
    session = next(row for row in activity["agents"]["codex"]["sessions"] if row["id"] == thread)
    print(json.dumps({"session": session, "runtime": read_call("tasks.runtime", {"id": thread}),
                      "timeline": read_call("agents.timeline", {"id": thread})}))
elif cmd == "ctl":
    operation, raw = args
    body = json.loads(raw)
    if operation not in {"codex_owner", "codex_read", "codex_send", "receipt", "codex_queue", "codex_interrupt"}:
        stop("Unknown case operation")
    print(cli("control", operation, "--stdin", body=body))
elif cmd == "stamp":
    print(json.dumps({"monotonicNs": host_time_ns(), "event": args}))
else:
    stop(f"Unknown step: {cmd}")

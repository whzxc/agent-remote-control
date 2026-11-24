#!/usr/bin/env python3
"""Installed handback runbooks. Run inside a disposable Apple Silicon macOS VM."""
import json
import os
from pathlib import Path
import select
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time


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


def independent():
    matches = []
    for row in output("/bin/ps", "-axww", "-o", "pid=,uid=,comm=").splitlines():
        pid, uid, exe = row.split(None, 2)
        if int(uid) != os.getuid() or exe != str(desktop):
            continue
        args = output("/bin/ps", "-ww", "-p", pid, "-o", "command=").split()
        if f"--user-data-dir={state}/codex-desktop" in args:
            matches.append(int(pid))
    if len(matches) != 1:
        stop(f"Expected one Codex Desktop in the case profile, found {matches}")
    pid = matches[0]
    return pid, process_identity(pid)


if sys.platform != "darwin" or not output("/usr/sbin/sysctl", "-n", "hw.model").startswith("VirtualMac"):
    stop("Use a disposable Apple Silicon macOS guest with no host homes or app bundles mounted.")
if output("/usr/bin/id", "-un") != "arc-handback":
    stop("Use the disposable guest's arc-handback GUI account.")
if len(sys.argv) < 2:
    stop("Usage: installed.py init | RUN arc-start|configure|dispatch|main-start|instance|crash|core-cycle|ctl ...")
if sys.argv[1:] == ["init"]:
    commands = output("/bin/ps", "-U", str(os.getuid()), "-o", "comm=").splitlines()
    active = {"ChatGPT", "Codex", "codex", "agent-remote-control", "agent-remote-control-desktop", "arc"}
    if any(Path(command.strip()).name in active for command in commands):
        stop("Restore the clean guest snapshot before starting a case.")
    root = Path(tempfile.mkdtemp(prefix="arc-handback-", dir="/private/tmp"))
    for child in ["arc", "codex", "main-profile", "project"]:
        (root / child).mkdir(mode=0o700)
    (root / "handback-guest").touch(mode=0o600)
    print(root)
    sys.exit()

root = Path(sys.argv[1])
if (root != root.resolve() or root.parent != Path("/private/tmp") or
        not root.name.startswith("arc-handback-") or not (root / "handback-guest").is_file()):
    stop("Pass the fresh root returned by init.")
for directory in [root, *(root / name for name in ["arc", "codex", "main-profile", "project"])]:
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        stop(f"Invalid private case directory: {directory}")
state, home = root / "arc", root / "codex"
arc_app = Path("/Applications/Agent Remote Control.app")
arc = arc_app / "Contents/Resources/bin/arc"
bundles = [Path("/Applications") / (name + ".app") for name in ["ChatGPT", "Codex"]]
native_cli = Path("Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
app = next((p for p in bundles if (p / native_cli).is_file()), None)
if not app or not arc.is_file():
    stop("Install the case ARC and Codex Desktop bundles in the guest first.")
desktop = app / "Contents/MacOS" / app.stem
os.environ.update(CODEX_HOME=str(home), ARC_STATE_DIR=str(state))
os.environ.pop("CODEX_APP_SERVER_WS_URL", None)
os.chdir(root / "project")
cmd, *args = sys.argv[2:]


def launch(bundle, arguments, extra_env=()):
    subprocess.run(["/usr/bin/open", "-n", "-g", "--env", f"CODEX_HOME={home}",
                    "--env", f"ARC_STATE_DIR={state}", *extra_env,
                    "-a", bundle, "--args", *arguments], check=True)


if cmd == "login":
    subprocess.run([app / native_cli, "login"], check=True)
elif cmd == "arc-start":
    # The installed updater relaunches the production bundle through LaunchServices.
    for key in ["CODEX_HOME", "ARC_STATE_DIR"]:
        subprocess.run(["/bin/launchctl", "setenv", key, os.environ[key]], check=True)
    if subprocess.run(["/bin/launchctl", "getenv", "CODEX_APP_SERVER_WS_URL"],
                      text=True, capture_output=True).stdout.strip():
        stop("The guest GUI session already has a shared-server override.")
    subprocess.run([app / native_cli, "app-server", "daemon", "start"], check=True)
    control = home / "app-server-control/app-server-control.sock"
    if control.resolve() != control or not stat.S_ISSOCK(control.stat().st_mode) or control.stat().st_uid != os.getuid():
        stop("The case Codex home's control socket is unavailable.")
    with socket.socket(socket.AF_UNIX) as probe:
        probe.connect(str(control))
    launch(arc_app, ["--state-dir", str(state)])
elif cmd == "configure":
    cli("wait", "--op", "app.status", "--until", "/pid exists", "--timeout", "60")
    print(cli("call", "tasks.settings.set", "--stdin", body={"body": {
        "autoOpenCodex": True, "desktopRecovery": "independent"}}))
elif cmd == "dispatch":
    title, prompt = args
    print(cli("control", "codex_create", "--stdin", body={
        "project": str(root / "project"), "title": title, "prompt": prompt,
        "purpose": "self-test", "notify": None}))
elif cmd == "main-start":
    profile = root / "main-profile"
    launch(app, [f"--user-data-dir={profile}"], ["--env", f"CODEX_ELECTRON_USER_DATA_PATH={profile}"])
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
            print(json.dumps({"event": "instance-exit", "pid": pid, "monotonicNs": time.monotonic_ns()}))
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
elif cmd == "capture-detail":
    thread, = args
    def read_call(name, body):
        return json.loads(cli("call", name, "--stdin", body=body))["result"]
    activity = read_call("agents.activity", {})
    session = next(row for row in activity["agents"]["codex"]["sessions"] if row["id"] == thread)
    print(json.dumps({"session": session, "runtime": read_call("tasks.runtime", {"id": thread}),
                      "timeline": read_call("agents.timeline", {"id": thread})}))
elif cmd in {"status-shown", "reopen"}:
    app_status = json.loads(cli("app", "status"))["result"]
    pid = int(app_status["pid"])
    exe = Path(output("/bin/ps", "-p", str(pid), "-o", "comm="))
    if arc_app not in exe.parents or process_identity(pid).split()[0] != str(os.getuid()):
        stop("Task details must belong to the installed case ARC Desktop.")
    script = Path(__file__).resolve().parent / "instance-exit-unlocks-tasks/detail.js"
    subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", script, str(pid), args[0], cmd], check=True)
elif cmd == "ctl":
    operation, raw = args
    body = json.loads(raw)
    if operation not in {"codex_owner", "codex_read", "codex_send", "receipt", "codex_queue", "codex_interrupt"}:
        stop("Unknown case operation")
    print(cli("control", operation, "--stdin", body=body))
elif cmd == "stamp":
    print(json.dumps({"monotonicNs": time.monotonic_ns(), "event": args}))
else:
    stop(f"Unknown step: {cmd}")

"""Verify one no-fault finished family's public owner and lock observations."""
import argparse
import json
import sys
from pathlib import Path


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def gap(message):
    print("EVIDENCE GAP: " + message, file=sys.stderr)
    raise SystemExit(2)


def fail(message):
    raise SystemExit("FAIL own-backend-unlocks-promptly/clear-within-30s: " + message)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--receipt", required=True, type=Path)
parser.add_argument("--before", required=True, type=Path)
parser.add_argument("--shared-pid", required=True, type=int)
parser.add_argument("--private-pid", type=int)
parser.add_argument("--exit", type=Path)
parser.add_argument("--trigger", type=Path)
parser.add_argument("--after", type=Path)
parser.add_argument("--child", action="append", default=[])
args = parser.parse_args()
receipt = json.loads(args.receipt.read_text())["result"]
parent = receipt.get("threadId")
if not parent or not receipt.get("turnId") or receipt.get("state") != "completed":
    gap("Resolve the original dispatch receipt and confirm terminal turn history.")
before = read_rows(args.before)
held = [r["owner"]["result"] for r in before if r["threadId"] == parent and r["writer"] == "held"]
writers = {p["pid"] for r in held if r["threadId"] == parent for p in r.get("processes", [])}
if args.shared_pid in writers:
    fail("The healthy independent dispatch used the shared writer for " + parent)
if not args.private_pid or args.private_pid not in writers:
    gap("Identify the independent backend peer and its writer before exit.")
if not all([args.exit, args.trigger, args.after]):
    gap("Provide process exit, pre-trigger bookmark and post-exit observations.")
event = json.loads(args.exit.read_text())
if event["event"] != "instance-exit" or event["pid"] != receipt["desktopRecovery"]["targetPid"]:
    gap("The observed process exit does not match this dispatch.")
start = json.loads(args.trigger.read_text())["monotonicNs"]
end = event["monotonicNs"]
if start > end:
    gap("Invalid exit interval.")
rows = read_rows(args.after)
failed, missing = [], []
for thread in [parent, *args.child]:
    observations = [r for r in rows if r["threadId"] == thread and r["monotonicNs"] >= end
                    and r["owner"]["result"]["threadId"] == thread]
    for row in observations:
        owner = row["owner"]["result"]
        if (row["writer"] == "clear" and (owner.get("handback") or {}).get("state") == "handed-back"
                and row["observedNs"] - start <= 30_000_000_000):
            break
    else:
        if any(r["monotonicNs"] - end >= 30_000_000_000 and r["writer"] == "held"
               for r in observations):
            failed.append(thread)
        else:
            missing.append(thread)
if missing:
    print("Missing timely lock and handback observations:", *missing, file=sys.stderr)
if failed:
    fail("Writer remained held beyond the deadline for " + ", ".join(failed))
if missing:
    gap("Incomplete family timing.")
print("PASS own-backend-unlocks-promptly/clear-within-30s", parent, *args.child)

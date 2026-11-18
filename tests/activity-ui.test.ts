import test from "node:test";
import assert from "node:assert/strict";
import { mergeActivity, trackActivity, visibleActivity, reorderActivity, orderActivity, beginApproval, finishApproval, permissionResponse, interactionKey } from "../ui/state/activityModel.ts";
import type { AgentActivitySession, AgentActivitySnapshot, AgentInteraction } from "../ui/types.ts";
import { taskHierarchy } from '../ui/state/taskHierarchy.ts';
import { activityFamilyAccounts } from '../ui/state/activityModel.ts';
const permission: AgentInteraction = { kind: "permission", summary: "Run example command", respond: { via: "act", op: "agent_respond", args: { agent: "claude", taskId: "task-example", interactionId: 1 } }, options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }] };
function session(id: string, interaction?: AgentInteraction): AgentActivitySession {
  return { id, source: "arc-task", phase: interaction ? "interaction" : "command", phaseSince: "2026-01-01T00:00:00Z", headline: "printf example", timeline: true, interaction };
}
function snapshot(at: number, sessions: AgentActivitySession[]): AgentActivitySnapshot {
  return { observedAt: `2026-01-01T00:00:0${at}Z`, activeAgents: [], agents: { claude: { sessions } } };
}
test('nested activity keeps ancestors visible and preserves session identity', () => {
  // Algorithmic core: activity hierarchy and session identity
  const parent = { ...session('parent'), nativeSessionId: 'native-parent', orderAt: 8, endedAt: 1 };
  const child = { ...session('child'), parentSessionId: 'native-parent', orderAt: 1 };
  const grandchild = { ...session('grandchild'), parentSessionId: 'child', orderAt: 0 };
  const others = Array.from({ length: 6 }, (_, i) => ({ ...session(`other-${i}`), orderAt: i + 2 }));
  const shown = visibleActivity([grandchild, child, ...others, parent]);
  const ids = shown.sessions.map(s => s.id);
  assert.ok(ids.indexOf('parent') < ids.indexOf('child'));
  assert.ok(ids.indexOf('child') < ids.indexOf('grandchild'));
  assert.equal(shown.sessions.find(s => s.id === 'parent'), parent);
  assert.equal(shown.sessions.find(s => s.id === 'child'), child);
  assert.equal(shown.hidden + shown.sessions.length, 9);
});
test('parent tasks and descendants always resolve to the same account', () => {
  // Algorithmic core: activity account ancestry resolution
  for (const rootAccount of ['account-a', null, undefined]) for (const count of [1, 3, 8]) {
    const root = { ...session('root'), nativeSessionId: 'native-root', agentAccountId: rootAccount, orderAt: 0 };
    const children = Array.from({ length: count }, (_, i) => ({ ...session(`child-${i}`),
      parentSessionId: i ? `child-${i - 1}` : 'native-root', agentAccountId: i % 2 ? null : 'account-b', orderAt: i + 1 }));
    for (const sessions of [[root, ...children], [...children.slice().reverse(), root]]) {
      const accounts = activityFamilyAccounts(sessions, id => id ?? undefined);
      assert.equal(accounts.get('root'), rootAccount ?? undefined);
      for (const child of children) assert.equal(accounts.get(child.id), accounts.get('root'));
    }
  }
});
test('task ancestry terminates for cycles and never invents missing parents', () => {
  // Algorithmic core: every input task appears exactly once and each emitted parent precedes its child.
  for (const rows of [
    [{ id: 'a', parentTaskId: 'b' }, { id: 'b', parentTaskId: 'a' }, { id: 'c', parentTaskId: 'b' }],
    [{ id: 'a', parentTaskId: 'a' }, { id: 'b', parentTaskId: 'missing' }],
    [{ id: 'c', parentTaskId: 'b' }, { id: 'b', parentTaskId: 'a' }, { id: 'a' }],
  ]) {
    const family = taskHierarchy(rows), ids = family.map(row => row.task.id);
    assert.deepEqual([...ids].sort(), rows.map(row => row.id).sort());
    for (const row of family) if (row.parentTaskId) assert.ok(ids.indexOf(row.parentTaskId) < ids.indexOf(row.task.id));
  }
});
test("full snapshots update sessions, remove completed ones and reject older observations", () => {
  // Algorithmic core: full snapshots update sessions, remove completed ones and reject older observations.
  const first = snapshot(1, [session("one"), session("two")]);
  const next = snapshot(2, [session("two", permission)]);
  assert.equal(mergeActivity(undefined, first), first);
  assert.equal(mergeActivity(first, next), next);
  assert.equal(mergeActivity(next, first), next);
  assert.equal(mergeActivity(next, snapshot(3, [])).agents.claude.sessions.length, 0);
});
test("overflow keeps unfinished work ahead of completions and can reveal every task", () => {
  // Recurring bug class: completed bubbles occupied the visible slots while running tasks were hidden in overflow.
  const tracked = trackActivity([], Array.from({ length: 9 }, (_, i) => session(String(i), i === 8 ? permission : undefined)), 100);
  const sessions = tracked.map(s => Number(s.id) < 5 ? { ...s, endedAt: 200 } : s);
  const shown = visibleActivity(sessions);
  assert.deepEqual(shown.sessions.map(s => s.id), ["8", "5", "6", "7"]);
  assert.equal(shown.hidden, 5);
  const expanded = visibleActivity(sessions, undefined, true);
  assert.deepEqual(expanded.sessions.slice(0, shown.sessions.length), shown.sessions);
  assert.equal(expanded.hidden, 0);
  assert.equal(expanded.count, sessions.length);
  assert.equal(new Set(expanded.sessions.map(s => s.id)).size, sessions.length);
  assert.deepEqual(visibleActivity(sessions), shown);
  const fewerRunning = sessions.map(s => s.id === "7" ? { ...s, endedAt: 200 } : s);
  assert.deepEqual(visibleActivity(fewerRunning).sessions.map(s => s.id), ["8", "5", "6", "0"]);
});
test("moving a visible overflow task settles inside its completion group without hiding unfinished work", () => {
  // Algorithmic core: activity overflow relocation
  const rows = ['C1','C2','C3','C4','C5','R1','R2','R3'].map((id, orderAt) => ({ ...session(id), orderAt, ...(id.startsWith('C') ? { endedAt: 1 } : {}) }));
  const baseline = visibleActivity(rows, undefined, true).sessions.map(row => row.id);
  const visible = baseline.slice(0, 4);
  assert.deepEqual(visible, ['R1','R2','R3','C1']);
  assert.equal(reorderActivity(rows, visible, []), undefined);
  assert.equal(reorderActivity(rows, visible, baseline), undefined);
  for (const moved of visible) for (let position = 0; position < visible.length; position++) {
    const ids = visible.filter(id => id !== moved); ids.splice(position, 0, moved);
    const stored = reorderActivity(rows, ids, []);
    const settledPosition = moved.startsWith('R') ? Math.min(position, 2) : Math.max(position, 3);
    if (visible.indexOf(moved) === settledPosition) assert.equal(stored, undefined);
    else assert.ok(stored);
    const ordered = orderActivity(rows, stored ?? []);
    const projected = visibleActivity(ordered, undefined, true).sessions;
    const collapsed = visibleActivity(ordered).sessions;
    assert.equal(projected.findIndex(row => row.id === moved), settledPosition);
    assert.ok(collapsed.some(row => row.id === moved));
    assert.ok(projected.slice(0, 3).every(row => row.endedAt === undefined));
    assert.ok(projected.slice(3).every(row => row.endedAt !== undefined));
    assert.deepEqual(projected.filter(row => row.id !== moved).map(row => row.id), baseline.filter(id => id !== moved));
    assert.deepEqual([...projected].map(row => row.id).sort(), rows.map(row => row.id).sort());
    assert.equal(projected.find(row => row.id === 'C1')?.readAt, undefined);
    assert.equal(reorderActivity(rows, ids, stored ?? []), undefined);
  }
});
test("later completions and new running tasks retain overflow priority after stored manual moves", () => {
  // Recurring bug class: 45370de7 let a full stored list hide running R3 behind completed C1 and R2 after R2 completed and R4 started.
  const rows = ['C1','C2','C3','C4','C5','R1','R2','R3'].map((id, orderAt) => ({ ...session(id), orderAt, ...(id.startsWith('C') ? { endedAt: 1 } : {}) }));
  const move = reorderActivity(rows, ['R2','R1','R3','C1'], []);
  assert.ok(move);
  const changed = [...rows.map(row => row.id === 'R2' ? { ...row, endedAt: 2 } : row), { ...session('R4'), orderAt: 8 }];
  for (const stored of [move, ['R1','C1','R2','R3','C2','C3','C4','C5'], rows.map(row => row.id)]) {
    const presented = visibleActivity(orderActivity(changed, stored), undefined, true).sessions;
    assert.deepEqual(presented.slice(0, 3).map(row => row.id).sort(), ['R1','R3','R4']);
    assert.ok(presented.slice(3).every(row => row.endedAt !== undefined));
    const collapsed = visibleActivity(orderActivity(changed, stored)).sessions;
    assert.ok(['R1','R3','R4'].every(id => collapsed.some(row => row.id === id)));
  }
});
test("start order is stable across phases, payload order and corrected timestamps; only attention reorders", () => {
  // Algorithmic core: activity overflow priority persistence
  const first = { ...session("first"), startedAt: "2026-01-01T00:00:01Z" };
  const second = { ...session("second"), startedAt: "2026-01-01T00:00:02Z" };
  let tracked = trackActivity([], [second, first], 10);
  assert.deepEqual(tracked.map(s => s.id), ["first", "second"]);
  tracked = trackActivity(tracked, [{ ...second, phase: "thinking", startedAt: "2025-01-01T00:00:00Z" }, { ...first, headline: "changed" }], 20);
  assert.deepEqual(tracked.map(s => s.id), ["first", "second"]);
  tracked = trackActivity(tracked, [first, { ...second, interaction: permission }], 30);
  assert.deepEqual(tracked.map(s => s.id), ["second", "first"]);
  tracked = trackActivity(tracked, [second, first], 40);
  assert.deepEqual(tracked.map(s => s.id), ["first", "second"]);
  const fallback = trackActivity([], [session("b"), session("a")], 100);
  assert.deepEqual(trackActivity(fallback, [session("a"), session("b")], 200).map(s => s.orderAt), [100, 100]);
});
test("activity disappearance stays unconfirmed until terminal evidence arrives", () => {
  // Algorithmic core: activity scheduling order
  const active = trackActivity([], [session("one", permission)], 100);
  const missing = trackActivity(active, [], 500);
  assert.equal(missing[0].endedAt, undefined);
  assert.equal(missing[0].observed, false);
  assert.equal(missing[0].interaction, undefined);
  const ended = [{ ...missing[0], status: "completed", endedAt: 700 }];
  assert.equal(trackActivity(ended, [], 2499)[0].endedAt, 700);
  assert.equal(trackActivity([{ ...ended[0], readAt: 700 }], [], 3000).length, 0);
  assert.equal(trackActivity(ended, [], 3000).length, 1);
  assert.equal(trackActivity(ended, [session("one")], 1000)[0].endedAt, undefined);
  assert.equal(trackActivity(ended, [session("one")], 1000)[0].orderAt, active[0].orderAt);
});
test("an open task keeps its origin and branch for focus restoration, even beyond the visible cap", () => {
  // Recurring bug class: lifecycle: activity disappearance awaits terminal evidence
  const active = trackActivity([], Array.from({ length: 7 }, (_, i) => session(String(i))), 100);
  const shown = visibleActivity(active, "6");
  assert.deepEqual(shown.sessions.map(s => s.id), ["0", "1", "2", "6"]);
  assert.equal(shown.hidden, 3);
  const ended = trackActivity(active, [], 500).map(s => ({ ...s, status: "completed", endedAt: 500, readAt: 500 }));
  assert.deepEqual(trackActivity(ended, [], 5000, "6").map(s => s.id), ["6"]);
  assert.equal(trackActivity(ended, [], 5000).length, 0);
});
test("approvals use ACP single-use choices, Pi confirmation and Codex decisions; questions do not submit", () => {
  // Contract: activity origin and branch fields
  assert.equal(permissionResponse(permission, "allow")?.args.optionId, "yes");
  assert.equal(permissionResponse(permission, "deny")?.args.optionId, "no");
  assert.equal(permissionResponse({ ...permission, options: [{ kind: "allow_always", optionId: "always" }] }, "allow"), undefined);
  assert.equal(permissionResponse({ ...permission, options: [] }, "deny")?.args.cancelled, true);
  assert.equal(permissionResponse({ ...permission, respond: { op: "agent_respond", args: { agent: "pi" } } }, "allow")?.args.confirmed, true);
  assert.deepEqual(permissionResponse({ ...permission, respond: { op: "codex_respond", args: { id: "interaction" } } }, "deny")?.args.result, { decision: "decline" });
  assert.equal(permissionResponse({ ...permission, kind: "question" }, "allow"), undefined);
  assert.equal(permissionResponse({ ...permission, canRespond: false }, "allow"), undefined);
});
test("submission locks immediately, survives snapshot refresh and retries only the identical UUID/payload", () => {
  // Contract: approval interaction protocol choices
  const payload = permissionResponse(permission, "allow")!;
  let ids = 0;
  const first = beginApproval(undefined, "allow", payload, () => `request-${++ids}`)!;
  assert.equal(first.status, "submitting");
  assert.equal(beginApproval(first, "allow", payload, () => "unused"), undefined);
  const failed = finishApproval(first, { state: "failed", error: "connection lost" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "connection lost");
  assert.equal(beginApproval(failed, "deny", payload, () => "unused"), undefined);
  const retry = beginApproval(failed, "allow", payload, () => `request-${++ids}`)!;
  assert.equal(retry.payload, first.payload);
  assert.equal(retry.requestId, first.requestId);
  const pending = finishApproval(retry, { state: "executing" });
  assert.equal(pending.status, "pending");
  assert.equal(beginApproval(pending, "allow", payload, () => "unused")?.payload, first.payload);
  assert.equal(beginApproval(finishApproval(retry, { state: "completed" }), "allow", payload, () => "unused"), undefined);
  assert.equal(beginApproval(finishApproval(retry, { state: "unconfirmed" }), "allow", payload, () => "unused"), undefined);
  const s = session("task", permission);
  assert.equal(interactionKey("claude", s), interactionKey("claude", { ...s, headline: "updated summary" }));
  assert.notEqual(interactionKey("claude", s), interactionKey("claude", { ...s, phaseSince: "2026-01-01T00:00:01Z" }));
});

test("Pi choice and input answers use the native response and stable retry payload", async () => {
  // Recurring bug class: retry-replay: approval submission retries the same request payload
  const { questionResponse } = await import("../ui/state/activityModel.ts");
  const question: AgentInteraction = { kind: "question", summary: "Choose a branch", method: "select", options: ["One", "Two"], respond: { op: "agent_respond", args: { agent: "pi", interactionId: "question-1" } } };
  assert.equal(questionResponse(question, "Other"), undefined);
  assert.equal(questionResponse(question, "Two")?.args.value, "Two");
  assert.equal(questionResponse(question, "", true)?.args.cancelled, true);
  const input = { ...question, method: "input" as const };
  const payload = questionResponse(input, "A response")!;
  const first = beginApproval(undefined, "answer", payload, () => "answer-uuid")!;
  assert.equal(beginApproval(first, "answer", payload, () => "unused"), undefined);
  const failed = finishApproval(first, { state: "failed" });
  assert.equal(beginApproval(failed, "answer", questionResponse(input, "Changed")!, () => "unused")?.payload, first.payload);
  assert.equal(beginApproval(failed, "cancel", payload, () => "unused"), undefined);
});

test("timeline replaces by item id, retains unchanged entries, and orders backfilled items", async () => {
  // Contract: Pi response payload protocol
  const { mergeTimeline } = await import("../ui/state/timelineModel.ts");
  const current = timeline([entry("live", 1, "partial", 0)]);
  const next = timeline([entry("old", 2, "history", 0), entry("live", 3, "complete", 1)]);
  const merged = mergeTimeline(current, next);
  assert.deepEqual(merged.entries.map(e => [e.id, e.text]), [["old", "history"], ["live", "complete"]]);
  assert.equal(merged.cursor, 3);
  assert.equal(mergeTimeline(merged, timeline([entry("live", 4, "latest", 1)])).entries.length, 2);
  assert.equal(current.entries[0].text, "partial");
});

test("expired timeline cursor discards old state and retries once without after", async () => {
  // Recurring bug class: persistence: timeline item replacement and backfill identity
  const { refreshTimeline } = await import("../ui/state/timelineModel.ts");
  const restored = timeline([entry("restored", 1, "restored", 0)]);
  const stale = timeline([entry("old", 50, "stale", 0)]);
  let expired = false;
  const result = await refreshTimeline(stale, async after => {
    if (after === stale.cursor) { expired = true; throw new Error("TIMELINE_CURSOR_EXPIRED: fetch again without after"); }
    if (after === undefined && expired) return restored;
    throw new Error("Invalid timeline resume cursor");
  });
  assert.equal(result, restored);
  assert.deepEqual(result.entries.map(e => e.id), ["restored"]);
  let available = false;
  await assert.rejects(refreshTimeline(restored, async () => {
    if (!available) { available = true; throw new Error("offline"); }
    return restored;
  }), /offline/);
});

function entry(id: string, cursor: number, text: string, position: number): import("../ui/types.ts").AgentTimelineEntry {
  return { id, cursor, text, position, type: "text", status: "completed", startedAt: null, updatedAt: "2026-01-01T00:00:00Z", turnId: "turn" };
}
function timeline(entries: import("../ui/types.ts").AgentTimelineEntry[]): import("../ui/types.ts").AgentTimeline {
  return { sessionId: "example", entries, cursor: Math.max(0, ...entries.map(e => e.cursor)), coverage: { state: "complete", truncated: false }, executionEvidence: false };
}

;

;


test("approval details match only an unambiguous preceding object in the same turn", async () => {
  // Algorithmic core: approval associations require the same turn and exact structured object.
  const { interactionTool } = await import("../ui/state/timelineModel.ts");
  const tool = { ...entry("write", 1, "", 1), type: "file" as const, status: "pending" as const, path: "/workspace/example/file.txt", operation: "write" as const };
  const interaction = { ...entry("approval", 2, "", 2), type: "interaction" as const, status: "pending" as const, interaction: { ...permission, path: tool.path } };
  const other = { ...tool, id: "other-turn", turnId: "other" };
  assert.equal(interactionTool([other, tool, interaction], interaction), tool);
  assert.equal(interactionTool([other, interaction], interaction), undefined);
  assert.equal(interactionTool([{ ...tool, path: "/workspace/example/other.txt" }, interaction], interaction), undefined);
  assert.equal(interactionTool([tool, { ...tool, id: "parallel" }, interaction], interaction), undefined);
  const command = { ...tool, type: "command" as const, path: undefined, command: "printf example" };
  const commandApproval = { ...interaction, interaction: { ...permission, command: command.command } };
  assert.equal(interactionTool([command, commandApproval], commandApproval), command);
  const summaryOnly = { ...commandApproval, interaction: { ...permission, summary: command.command } };
  assert.equal(interactionTool([command, summaryOnly], summaryOnly), undefined);
});

;




test("dispatch records use their own turn results and keep submission separate", async () => {
  // Algorithmic core: approval association within a turn
  const { sourceDispatches, dispatchState } = await import("../ui/state/sourceDispatch.ts");
  const row = (id: string, source: string, date: string) => ({ requestId: id, turnId: id, threadId: "thread", origin: { sourceId: source }, state: "completed", createdAt: date,
    updatedAt: date, approval: { decision: "allowed", source: "local", at: date }, task: { kind: "create", prompt: "Fixture", input: {}, settings: {} } });
  const older = row("older", "left", "2026-01-01"), latest = row("latest", "left", "2026-01-02"), other = row("other", "right", "2026-01-03");
  assert.deepEqual(sourceDispatches([older, other, latest], "left").map(r => r.requestId), ["latest", "older"]);
  const execution = { status: "running", turnId: "other", turnStatuses: { older: "completed", latest: "failed", other: "running" }, interactions: [] };
  const live = { ...session("thread", permission), turnId: "other" };
  assert.equal(dispatchState(older, execution, live), "done");
  assert.equal(dispatchState(latest, execution, live), "failed");
  assert.equal(dispatchState(other, execution, live), "needsYou");
  assert.equal(dispatchState(latest, undefined, live), "unknown");
  assert.equal(dispatchState({ ...latest, state: "awaiting-approval" }, undefined, live), "awaitingApproval");
  assert.equal(dispatchState({ ...latest, state: "failed" }, undefined, undefined), "submissionFailed");
  assert.equal(dispatchState({ ...latest, state: "unconfirmed" }, undefined, undefined), "submissionUnknown");
  for (const state of ["reserved", "executing"]) {
    assert.equal(dispatchState({ ...latest, state }, undefined, undefined), "submitting");
  }
  assert.equal(dispatchState({ ...latest, state: "not-executed" }, undefined, undefined), "notExecuted");
});

test("timeline turns keep every work kind together and preserve steering requests", async () => {
  // Contract: persisted dispatch receipt and turn result fields
  const { timelineGroups, turnEntries } = await import("../ui/state/timelineGroups.ts");
  const prompt = { ...entry("prompt", 1, "Request", 1), type: "user" as const };
  const command = { ...entry("cmd", 2, "", 2), type: "command" as const };
  const thinking = { ...entry("think", 3, "Reasoning", 3), type: "thinking" as const };
  const steering = { ...prompt, id: "steering", text: "Also handle this" };
  const answer = { ...entry("answer", 5, "Done", 5), phase: "final_answer" };
  const entries = [prompt, command, thinking, steering, answer];
  assert.equal(timelineGroups(entries).length, 1);
  const turn = turnEntries(entries, false);
  assert.equal(turn.prompt, prompt); assert.equal(turn.final, answer);
  assert.deepEqual(turn.work.map(item => item.id), ["cmd", "think", "steering"]);
  assert.equal(timelineGroups([...entries, { ...prompt, id: "next", turnId: "next" }]).length, 2);
  assert.equal(timelineGroups(entries.map(item => ({ ...item, turnId: "" }))).length, 1);
});

test("work blocks preserve manual choices and count observed work without adding concurrent durations", async () => {
  // Algorithmic core: timeline work-kind grouping
  const { workState, workBlockOpen, entryDuration, turnDuration } = await import("../ui/state/timelineGroups.ts");
  const base = { ...entry("cmd", 1, "", 1), type: "command" as const, durationMs: 2000 };
  const running = { ...base, id: "running", status: "running" as const, durationMs: undefined, startedAt: "2026-01-01T00:00:00Z" };
  const now = Date.parse("2026-01-01T00:00:03Z");
  const state = workState([base, running, { ...base, id: "failed", status: "failed" }, { ...base, id: "file", type: "file", operation: "read", path: "/project/a" }]);
  assert.equal(state.failed, 1); assert.equal(state.counts.command, 3); assert.equal(state.counts.read, 1);
  assert.deepEqual(state.kinds, ["command", "file"]);
  assert.equal(workBlockOpen(true), true); assert.equal(workBlockOpen(false), false);
  assert.equal(workBlockOpen(false, true), true); assert.equal(workBlockOpen(true, false), false);
  assert.equal(entryDuration({ ...base, durationMs: undefined }, now), undefined);
  assert.equal(entryDuration({ ...base, durationMs: -2 }, now), 0);
  assert.equal(turnDuration([base, running], now, true, running.startedAt), 3000);
  assert.equal(turnDuration([base], now, false), undefined);
  assert.equal(turnDuration([{ ...base, type: "user", startedAt: running.startedAt, endedAt: "2026-01-01T00:00:01Z" }], now, false), 1000);
  assert.equal(turnDuration([{ ...base, type: "user", startedAt: running.startedAt, endedAt: running.startedAt }, { ...base, id: "parallel-a", endedAt: "2026-01-01T00:00:10Z" }, { ...base, id: "parallel-b", endedAt: "2026-01-01T00:00:03Z" }], now, false), 10000);
});

test("task execution totals exclude gaps between turns and retain native lifecycle timing", async () => {
  // Algorithmic core: timeline work duration aggregation
  const { timelineDuration, turnDuration } = await import("../ui/state/timelineGroups.ts");
  const { mergeTimeline } = await import("../ui/state/timelineModel.ts");
  const time = (seconds: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + seconds * 1000).toISOString();
  const first = { ...entry("first", 1, "Request", 1), type: "user" as const, turnId: "first", startedAt: null, endedAt: null };
  const second = { ...first, id: "second", turnId: "second", position: 2 };
  for (const gap of [0, 60, 3600]) {
    const timings = { first: { startedAt: time(0), endedAt: time(10) }, second: { startedAt: time(10 + gap), endedAt: time(30 + gap) } };
    const now = Date.parse(time(40 + gap));
    assert.equal(timelineDuration([first, second], now, false, undefined, timings), 30000);
    assert.equal(turnDuration([first], now, false, undefined, timings.first), 10000);
    assert.equal(timelineDuration([second], now, false, undefined, timings), 30000);
    const current = { ...timings, second: { startedAt: time(10 + gap) } };
    assert.equal(timelineDuration([first, second], now, true, "second", current), 40000);
    assert.equal(timelineDuration([first, second], now, false, undefined, { first: timings.first }), undefined);
    const merged = mergeTimeline({ ...timeline([first]), turnTimings: { first: timings.first } }, { ...timeline([second]), turnTimings: { second: timings.second } });
    assert.equal(timelineDuration(merged.entries, now, false, undefined, merged.turnTimings), 30000);
  }
});

test("incremental timeline backfill retains turn identities and updated entry content", async () => {
  // Algorithmic core: task execution duration calculation
  const { mergeTimeline } = await import("../ui/state/timelineModel.ts");
  const { timelineGroups } = await import("../ui/state/timelineGroups.ts");
  const first = { ...entry("first", 1, "", 1), type: "command" as const, status: "running" as const };
  const initial = timeline([first]);
  const merged = mergeTimeline(initial, timeline([{ ...first, cursor: 2, status: "completed" }, { ...entry("second", 3, "", 2), type: "thinking" }]));
  const id = timelineGroups(initial.entries)[0].id;
  assert.equal(timelineGroups(merged.entries)[0].id, id);
  const backfilled = mergeTimeline(merged, timeline([{ ...entry("older", 4, "Earlier", 0), type: "user" }, { ...entry("previous", 5, "Previous", -1), turnId: "previous" }]));
  const groups = timelineGroups(backfilled.entries);
  assert.equal(groups[1].id, id);
  assert.deepEqual(groups[1].entries.map(item => item.id), ["older", "first", "second"]);
  assert.equal(groups[1].entries.find(item => item.id === "first")?.status, "completed");
  assert.equal(new Set(groups.map(group => group.id)).size, groups.length);
});


;

test("final answers prefer native markers and only infer trailing text after completion", async () => {
  // Recurring bug class: persistence: timeline incremental backfill identity
  const { turnEntries } = await import("../ui/state/timelineGroups.ts");
  const text = entry("text", 1, "Interim", 1);
  const tool = { ...entry("tool", 2, "", 2), type: "command" as const };
  const final = { ...entry("final", 3, "Answer", 3), phase: "final_answer" };
  assert.equal(turnEntries([text, tool, final], true).final, final);
  assert.deepEqual(turnEntries([text, tool, final], true).work, [text, tool]);
  assert.equal(turnEntries([text], true).final, undefined);
  assert.equal(turnEntries([text], false, false).final, undefined);
  assert.equal(turnEntries([{ ...text, status: "failed" }], false).final, undefined);
  assert.equal(turnEntries([{ ...tool, status: "failed" }, text], false, true).final, text);
  assert.equal(turnEntries([text], false).final, text);
  assert.equal(turnEntries([text, tool], false).final, undefined);
  const unmarked = { ...final, phase: undefined };
  assert.equal(turnEntries([text, tool, unmarked], false).final, unmarked);
});

test("durable activity reads retain only recent unique agent-task acknowledgements within the capacity", async () => {
  // Algorithmic core: final answer marker parser
  const { pruneActivityReads, activityReadRetention } = await import("../ui/state/activityModel.ts");
  const now = Date.now();
  const invalid = [null, {}, { agent: "codex", id: "expired", readAt: now - activityReadRetention.maxAge }, { agent: "codex", id: "future", readAt: now + 1 }];
  assert.deepEqual(pruneActivityReads(invalid, now), []);
  const duplicate = { agent: "codex", id: "same", readAt: now };
  const otherAgent = { agent: "claude", id: "same", readAt: now - 1 };
  const rows = pruneActivityReads([duplicate, { ...duplicate, readAt: now - 2 }, otherAgent, ...invalid], now);
  assert.deepEqual(rows, [duplicate, otherAgent]);
  const crowded = Array.from({ length: activityReadRetention.maxEntries + 20 }, (_, index) => ({ agent: "codex", id: String(index), readAt: now - index }));
  const bounded = pruneActivityReads(crowded.reverse(), now);
  assert.equal(bounded.length, activityReadRetention.maxEntries);
  assert.equal(bounded.every(row => now - row.readAt < activityReadRetention.maxAge), true);
  assert.deepEqual(bounded.map(row => row.readAt), Array.from({ length: activityReadRetention.maxEntries }, (_, index) => now - index));
});

test('large families share overflow without hiding independent roots or pending children', () => {
  // Recurring bug class: persistence: durable activity acknowledgement retention
  const parent = { ...session('parent'), orderAt: 0 };
  const children = Array.from({ length: 7 }, (_, index) => ({ ...session(`child-${index}`, index === 6 ? permission : undefined), parentSessionId: parent.id, relationKind: index === 0 ? 'side-chat' as const : 'subagent' as const, orderAt: index + 1 }));
  const root = { ...session('independent'), orderAt: 9 };
  const rows = [parent, ...children, root];
  const shown = visibleActivity(rows);
  assert.ok(shown.sessions.includes(root));
  assert.ok(shown.sessions.includes(children[6]));
  assert.deepEqual(shown.hiddenGroups.map(group => ({ parentId: group.parentId, ids: group.sessions.map(row => row.id) })), [{ parentId: parent.id, ids: ['child-3', 'child-4', 'child-5'] }]);
  assert.equal(visibleActivity(rows, children[5].id).sessions.includes(children[5]), true);
  assert.equal(visibleActivity(rows, undefined, true).sessions.length, rows.length);
  const otherChildren = Array.from({ length: 5 }, (_, index) => ({ ...session(`other-child-${index}`), parentSessionId: root.id, orderAt: index + 10 }));
  const expandedFamily = visibleActivity([...rows, ...otherChildren], undefined, parent.id);
  assert.ok(children.every(child => expandedFamily.sessions.includes(child)));
  assert.deepEqual(expandedFamily.hiddenGroups.map(group => group.parentId), [root.id]);
  const grandchild = { ...session('pending-grandchild', permission), parentSessionId: children[4].id, orderAt: 10 };
  const nested = visibleActivity([...rows, grandchild]);
  assert.ok(nested.sessions.includes(grandchild));
  assert.ok(nested.sessions.includes(children[4]));
  const tracked = trackActivity([children[0]], [{ ...children[0], relationKind: undefined, parentSessionId: undefined }], 100);
  assert.equal(tracked[0].relationKind, 'side-chat');
  assert.equal(tracked[0].parentSessionId, parent.id);
});

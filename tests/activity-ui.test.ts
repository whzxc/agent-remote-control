import test from "node:test";
import assert from "node:assert/strict";
import { mergeActivity, trackActivity, agentPanelSelection, visibleActivity, beginApproval, finishApproval, permissionResponse, interactionKey } from "../ui/state/activityModel.ts";
import type { AgentActivitySession, AgentActivitySnapshot, AgentInteraction } from "../ui/types.ts";
const permission: AgentInteraction = { kind: "permission", summary: "Run example command", respond: { via: "act", op: "agent_respond", args: { agent: "claude", taskId: "task-example", interactionId: 1 } }, options: [{ kind: "allow_once", optionId: "yes" }, { kind: "reject_once", optionId: "no" }] };
function session(id: string, interaction?: AgentInteraction): AgentActivitySession {
  return { id, source: "arc-task", phase: interaction ? "interaction" : "command", phaseSince: "2026-01-01T00:00:00Z", headline: "printf example", timeline: true, interaction };
}
function snapshot(at: number, sessions: AgentActivitySession[]): AgentActivitySnapshot {
  return { observedAt: `2026-01-01T00:00:0${at}Z`, activeAgents: [], agents: { claude: { sessions } } };
}
test("full snapshots update sessions, remove completed ones and reject older observations", () => {
  // Property: full snapshots update sessions, remove completed ones and reject older observations.
  const first = snapshot(1, [session("one"), session("two")]);
  const next = snapshot(2, [session("two", permission)]);
  assert.equal(mergeActivity(undefined, first), first);
  assert.equal(mergeActivity(first, next), next);
  assert.equal(mergeActivity(next, first), next);
  assert.equal(mergeActivity(next, snapshot(3, [])).agents.claude.sessions.length, 0);
});
test("five tasks stay individual; overflow replaces slot five and counts every hidden task", () => {
  // Property: five tasks stay individual; overflow replaces slot five and counts every hidden task.
  for (let n = 0; n <= 9; n++) {
    const tracked = trackActivity([], Array.from({ length: n }, (_, i) => session(String(i))), 1000);
    const shown = visibleActivity(tracked);
    assert.equal(shown.count, Math.min(n, 5));
    assert.equal(shown.sessions.length, n > 5 ? 4 : n);
    assert.equal(shown.hidden, n > 5 ? n - 4 : 0);
    assert.equal(shown.sessions.length + shown.hidden, n);
  }
});
test("overflow keeps unfinished work ahead of completions and can reveal every task", () => {
  // Regression: completed bubbles occupied the visible slots while running tasks were hidden in overflow.
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
test("start order is stable across phases, payload order and corrected timestamps; only attention reorders", () => {
  // Property: start order is stable across phases, payload order and corrected timestamps; only attention reorders.
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
  // Regression: disappearing activity was marked successful without a terminal event.
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
  // Property: an open task keeps its origin and branch for focus restoration, even beyond the visible cap.
  const active = trackActivity([], Array.from({ length: 7 }, (_, i) => session(String(i))), 100);
  const shown = visibleActivity(active, "6");
  assert.deepEqual(shown.sessions.map(s => s.id), ["0", "1", "2", "6"]);
  assert.equal(shown.hidden, 3);
  const ended = trackActivity(active, [], 500).map(s => ({ ...s, status: "completed", endedAt: 500, readAt: 500 }));
  assert.deepEqual(trackActivity(ended, [], 5000, "6").map(s => s.id), ["6"]);
  assert.equal(trackActivity(ended, [], 5000).length, 0);
});
test("approvals use ACP single-use choices, Pi confirmation and Codex decisions; questions do not submit", () => {
  // Property: approvals use ACP single-use choices, Pi confirmation and Codex decisions; questions do not submit.
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
  // Property: submission locks immediately, survives snapshot refresh and retries only the identical UUID/payload.
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
  const pending = finishApproval(retry, { state: "pending" });
  assert.equal(pending.status, "pending");
  assert.equal(beginApproval(pending, "allow", payload, () => "unused")?.payload, first.payload);
  assert.equal(beginApproval(finishApproval(retry, { state: "completed" }), "allow", payload, () => "unused"), undefined);
  assert.equal(beginApproval(finishApproval(retry, { state: "unconfirmed" }), "allow", payload, () => "unused"), undefined);
  const s = session("task", permission);
  assert.equal(interactionKey("claude", s), interactionKey("claude", { ...s, headline: "updated summary" }));
  assert.notEqual(interactionKey("claude", s), interactionKey("claude", { ...s, phaseSince: "2026-01-01T00:00:01Z" }));
});

test("Pi choice and input answers use the native response and stable retry payload", async () => {
  // Property: Pi choice and input answers use the native response and stable retry payload.
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
  // Property: timeline replaces by item id, retains unchanged entries, and orders backfilled items.
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
  // Regression: TIMELINE_CURSOR_EXPIRED requires a fresh timeline without stale entries.
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

test("scroll follows live snapshots until upward movement, resumes at bottom, and leaves finished history still", async () => {
  // Property: scroll follows live snapshots until upward movement, resumes at bottom, and leaves finished history still.
  const { followsTimeline, timelineScrollTarget } = await import("../ui/state/timelineModel.ts");
  assert.equal(followsTimeline(600, 400, 1000, 590), true);
  assert.equal(followsTimeline(590, 400, 1000, 600), false);
  assert.equal(followsTimeline(100, 400, 1000, 90), false);
  assert.equal(timelineScrollTarget(true, true, false, 1200), 1200);
  assert.equal(timelineScrollTarget(false, true, false, 1200), undefined);
  assert.equal(timelineScrollTarget(true, false, false, 1200), undefined);
  assert.equal(timelineScrollTarget(true, false, true, 1200), 1200);
});

function entry(id: string, cursor: number, text: string, position: number): import("../ui/types.ts").AgentTimelineEntry {
  return { id, cursor, text, position, type: "text", status: "completed", startedAt: null, updatedAt: "2026-01-01T00:00:00Z", turnId: "turn" };
}
function timeline(entries: import("../ui/types.ts").AgentTimelineEntry[]): import("../ui/types.ts").AgentTimeline {
  return { sessionId: "example", entries, cursor: Math.max(0, ...entries.map(e => e.cursor)), coverage: { state: "complete", truncated: false }, executionEvidence: false };
}

test("file labels are relative only inside the project and keep the filename separate from the elided directory", async () => {
  // Property: file labels are relative only inside the project and keep the filename separate from the elided directory.
  const { filePathParts } = await import("../ui/state/activityModel.ts");
  assert.deepEqual(filePathParts("/workspace/example/src/deep/file_name.ts", "/workspace/example"), {
    fullPath: "/workspace/example/src/deep/file_name.ts", displayPath: "src/deep/file_name.ts", directory: "src/deep/", filename: "file_name.ts",
  });
  assert.equal(filePathParts("/workspace/example-other/file.ts", "/workspace/example").displayPath, "/workspace/example-other/file.ts");
  assert.equal(filePathParts("/workspace/example/../other/file.ts", "/workspace/example").displayPath, "/workspace/other/file.ts");
  assert.equal(filePathParts("src/file.ts", "/workspace/example/").fullPath, "/workspace/example/src/file.ts");
  assert.equal(filePathParts("/workspace/example/file.ts", "/workspace/example").directory, "");
  assert.equal(filePathParts("C:\\Workspace\\Example\\src\\file.ts", "c:\\workspace\\example\\").displayPath, "src/file.ts");
  assert.equal(filePathParts("D:\\other\\file.ts", "C:\\Workspace\\Example").displayPath, "D:/other/file.ts");
  const unicodeName = "文件.ts";
  const unicodePath = `/example/目录/${unicodeName}`;
  assert.equal(filePathParts(unicodePath, "/").filename, unicodeName);
  assert.equal(filePathParts("/example/very/long/directory/file.ts").filename, "file.ts");
});

test("file approvals use path labels in interaction bubbles and timeline cards", async () => {
  // Property: file approvals use path labels in interaction bubbles and timeline cards.
  const { activityHeadline, filePathParts } = await import("../ui/state/activityModel.ts");
  const project = "/workspace/example";
  const path = `${project}/nested/deep/approval-file.txt`;
  const interaction = { ...permission, path, summary: path };
  const bubble = { ...session("task", interaction), project, headline: interaction.summary };
  const card = { ...bubble, phase: "interaction" as const, headline: interaction.summary, interaction };
  for (const item of [bubble, card]) {
    const label = activityHeadline(item);
    assert.equal(label.path, path);
    assert.equal(label.fullText, path);
    assert.deepEqual(filePathParts(label.path!, item.project), {
      fullPath: path, displayPath: "nested/deep/approval-file.txt", directory: "nested/deep/", filename: "approval-file.txt",
    });
  }
  const relative = activityHeadline({ ...bubble, interaction: { ...interaction, path: "src/approval-file.txt" } });
  assert.equal(relative.fullText, `${project}/src/approval-file.txt`);
  const outside = activityHeadline({ ...bubble, interaction: { ...interaction, path: "/other/approval-file.txt" } });
  assert.equal(filePathParts(outside.path!, project).displayPath, "/other/approval-file.txt");
  const command = activityHeadline({ ...bubble, phase: "file", interaction: permission, headline: permission.summary });
  assert.equal(command.path, undefined);
  assert.equal(command.text, permission.summary);
  assert.equal(activityHeadline({ ...bubble, phase: "file", interaction: undefined, headline: path }).path, path);
});


test("approval details match only an unambiguous preceding object in the same turn", async () => {
  // Property: approval associations require the same turn and exact structured object.
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

test("approval wording uses structured operations and retains generic file access when unknown", async () => {
  // Property: approval wording uses structured operations and retains generic file access when unknown.
  const { permissionRequestLabel } = await import("../ui/state/timelineModel.ts");
  const tool = { ...entry("file", 1, "", 1), type: "file" as const };
  assert.equal(permissionRequestLabel({ ...tool, operation: "read" }), "timeline.readRequest");
  for (const operation of ["write", "edit", "create"] as const)
    assert.equal(permissionRequestLabel({ ...tool, operation }), "timeline.writeRequest");
  assert.equal(permissionRequestLabel({ ...tool, type: "command" }), "timeline.commandRequest");
  assert.equal(permissionRequestLabel({ ...tool, title: "Write file.txt" }), "timeline.fileRequest");
  assert.equal(permissionRequestLabel(), "timeline.fileRequest");
});

test("timeline tools only expand when there is detail beyond the summary object", async () => {
  // Property: timeline tools only expand when there is detail beyond the summary object.
  const { expandableTimelineEntry } = await import("../ui/state/timelineModel.ts");
  const file = { ...entry("file", 1, "", 1), type: "file" as const, path: "src/file.ts" };
  assert.equal(expandableTimelineEntry(file), false);
  assert.equal(expandableTimelineEntry({ ...file, changes: [{ path: file.path, operation: "edit" }] }), false);
  assert.equal(expandableTimelineEntry({ ...file, changes: [{ path: "src/other.ts", operation: "edit" }] }), true);
  assert.equal(expandableTimelineEntry({ ...file, exitCode: 0 }), true);
  assert.equal(expandableTimelineEntry({ ...file, output: { text: "result", state: "available", truncated: false, sha256: "example", hashScope: "excerpt" } }), true);
});


test("bubble headlines prefer current content, then recent readable content, then title", async () => {
  // Property: bubble headlines prefer current content, then recent readable content, then title.
  const { activityHeadline } = await import("../ui/state/activityModel.ts");
  const base = { ...session("one"), title: "Task title", fallbackHeadline: "Previous readable command" };
  assert.equal(activityHeadline(base).text, "printf example");
  assert.equal(activityHeadline(base).fallback, false);
  const thinking = { ...base, phase: "thinking" as const, headline: " \n " };
  assert.equal(activityHeadline(thinking).text, "Previous readable command");
  assert.equal(activityHeadline(thinking).fallback, true);
  assert.equal(activityHeadline({ ...thinking, fallbackHeadline: " " }).text, "Task title");
  assert.equal(activityHeadline({ ...thinking, phase: "file" }).path, undefined);
  assert.equal(activityHeadline({ ...base, phase: "file", headline: "src/main.rs" }).path, "src/main.rs");
});
test("every source and phase has a visible fallback even before readable content arrives", async () => {
  // Property: every source and phase has a visible fallback even before readable content arrives.
  const { activityHeadline } = await import("../ui/state/activityModel.ts");
  for (const source of ["arc-task", "codex-thread", "transcript"] as const) {
    for (const phase of ["thinking", "command", "file", "tool", "text", "interaction", "idle"] as const) {
      const headline = activityHeadline({ ...session("one"), ...{ source }, phase, headline: "" }, "Task details");
      assert.equal(headline.text, "Task details");
      assert.equal(headline.fallback, true);
    }
  }
});


test("Agent panel toggles the current node, switches peers in place, and returns from bubble detail", () => {
  // Property: Agent panel toggles the current node, switches peers in place, and returns from bubble detail.
  const first = { ...session("one"), orderAt: 1 };
  let view = agentPanelSelection(undefined, { type: "toggle", agent: "claude" });
  assert.deepEqual(view, { agent: "claude" });
  view = agentPanelSelection(view, { type: "task", agent: "claude", session: first });
  assert.equal(view?.session, first);
  view = agentPanelSelection(view, { type: "back" });
  assert.deepEqual(view, { agent: "claude" });
  view = agentPanelSelection(view, { type: "toggle", agent: "codex" });
  assert.deepEqual(view, { agent: "codex" });
  view = agentPanelSelection(view, { type: "toggle", agent: "codex" });
  assert.equal(view?.closing, true);
  assert.equal(agentPanelSelection(view, { type: "closed" }), undefined);
  view = agentPanelSelection(undefined, { type: "task", agent: "claude", session: first });
  assert.deepEqual(agentPanelSelection(view, { type: "back" }), { agent: "claude" });
  assert.equal(agentPanelSelection(view, { type: "dismiss" })?.session, first);
  view = agentPanelSelection(view, { type: "platform", agent: "claude", toggle: true });
  assert.deepEqual(view, { agent: "claude", platform: true });
  assert.equal(agentPanelSelection(view, { type: "platform", agent: "claude", toggle: true })?.closing, true);
  view = agentPanelSelection(view, { type: "toggle", agent: "claude", accountId: "account-one" });
  assert.deepEqual(view, { agent: "claude", accountId: "account-one" });
  view = agentPanelSelection(view, { type: "platform", agent: "claude", toggle: true });
  assert.deepEqual(view, { agent: "claude", platform: true });
  assert.deepEqual(agentPanelSelection(view, { type: "toggle", agent: "claude" }), { agent: "claude" });
});

test("dispatch records use their own turn results and keep submission separate", async () => {
  // Regression: old dispatches became unknown or borrowed another turn's live state.
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
  assert.equal(dispatchState({ ...latest, state: "reserved" }, undefined, undefined), "submitting");
  assert.equal(dispatchState({ ...latest, state: "not-executed" }, undefined, undefined), "notExecuted");
});

test("timeline turns keep every work kind together and preserve steering requests", async () => {
  // Property: each turn preserves every entry except its primary prompt and final response in one work block.
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
  // Property: manual disclosure overrides live state and turn duration uses observed wall time.
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
  // Property: total execution is the sum of known turn spans, excluding idle gaps and never inventing missing time.
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
  // Property: turn ids remain stable when earlier work and earlier turns are backfilled.
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


test("timeline resumes at the bottom threshold despite layout clamping and follows the next increment", async () => {
  // Property: timeline resumes at the bottom threshold despite layout clamping and follows the next increment.
  const { followsTimeline, timelineScrollTarget } = await import("../ui/state/timelineModel.ts");
  let following = followsTimeline(100, 710, 3482, 2772); // User scrolls upward.
  assert.equal(following, false);
  following = followsTimeline(2748, 710, 3482, 100); // Return within 24px.
  assert.equal(following, true);
  following = followsTimeline(2728, 754, 3482, 2748); // Latest button disappears; browser clamps top.
  assert.equal(following, true);
  assert.equal(timelineScrollTarget(following, true, false, 3750), 3750);
  assert.equal(followsTimeline(2727, 754, 3482, 2748), true, "fractional rounding at the clamped bottom is tolerated");
  assert.equal(followsTimeline(2718, 754, 3482, 2728), false, "real upward movement within the threshold still pauses");
  assert.equal(followsTimeline(599, 400, 1000, 600), false, "even small upward movement is not treated as layout rounding");
  assert.equal(timelineScrollTarget(true, false, false, 4000), undefined, "finished history still does not jump");
});

test("final answers prefer native markers and only infer trailing text after completion", async () => {
  // Property: native final markers win and unmarked live text remains work.
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
  // Property: read retention keeps the newest unique agent-task records within both age and count limits.
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

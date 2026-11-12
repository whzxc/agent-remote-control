import test from "node:test";
import assert from "node:assert/strict";
import { changedFiles, processRows, processOpen, projectTurn, taskState } from "../ui/state/taskProjection.ts";
import type { AgentTimelineEntry } from "../ui/types.ts";
const entry = (id: string, type: AgentTimelineEntry["type"], extra: Partial<AgentTimelineEntry> = {}): AgentTimelineEntry => ({ id, type, status: "completed", turnId: "turn", startedAt: null, updatedAt: "", cursor: 1, ...extra });
test("tool runs merge without absorbing narrative or interaction boundaries", () => {
  // Property: grouping preserves tool order and narrative boundaries without duplicating entries.
  const entries = [entry("a", "file"), entry("b", "command"), entry("c", "text"), entry("d", "tool"), entry("e", "interaction"), entry("f", "command")];
  const rows = processRows(entries);
  assert.deepEqual(rows.map(row => row.kind), ["tools", "entry", "tools", "entry", "tools"]);
  assert.deepEqual(rows.flatMap(row => row.kind === "tools" ? row.entries : [row.entry]), entries);
});
test("only the latest plan and live thinking survive projection", () => {
  // Property: plan replacement and thinking removal are independent of historical item count.
  const entries = [entry("p1", "plan"), entry("t1", "thinking", { text: "First" }), entry("p2", "plan"), entry("t2", "thinking", { text: "Latest" }), entry("answer", "text", { phase: "final_answer", text: "Result" })];
  const live = projectTurn(entries, "running");
  assert.equal(live.plan?.id, "p2");
  assert.equal(live.thinking?.id, "t2");
  assert.deepEqual(live.rows.flatMap(row => row.kind === "entry" ? [row.entry.id] : []), ["p2"]);
  assert.equal(projectTurn(entries, "done").thinking, undefined);
  assert.equal(projectTurn(entries, "done").final?.id, "answer");
});
test("terminal state and process folding preserve explicit disclosure choices", () => {
  // Regression: failed and interrupted process disclosures ignored user clicks after starting expanded.
  assert.equal(taskState("completed", false), "done");
  assert.equal(taskState("failed", false), "failed");
  assert.equal(taskState("cancelled", false), "interrupted");
  assert.equal(taskState(undefined, false), "unknown");
  assert.equal(taskState("completed", true), "running");
  assert.equal(taskState("running", true, true), "needsYou");
  assert.equal(processOpen("done"), false);
  assert.equal(processOpen("done", true), true);
  for (const state of ["failed", "interrupted"] as const) {
    assert.equal(processOpen(state), true);
    assert.equal(processOpen(state, false), false);
    assert.equal(processOpen(state, true), true);
  }
  assert.equal(processOpen("needsYou", false), true);
  assert.equal(projectTurn([entry("failed-command", "command", { status: "failed" }), entry("final", "text")], "done").final?.id, "final");
});
test("changed files omit failed writes and never invent missing counts", () => {
  // Property: only completed writes contribute changes and unknown line counts stay unknown.
  assert.deepEqual(changedFiles([entry("read", "file", { path: "a", operation: "read" }), entry("fail", "file", { path: "b", operation: "edit", status: "failed" })]), []);
  const files = changedFiles([entry("edit", "file", { changes: [{ path: "a", added: 2, removed: 1 }] }), entry("edit2", "file", { changes: [{ path: "a", added: 3, removed: 0 }, { path: "b" }] })]);
  assert.deepEqual(files, [{ path: "a", added: 5, removed: 1 }, { path: "b", added: undefined, removed: undefined }]);
  const operations = changedFiles([
    entry("new", "file", { path: "new", operation: "create" }),
    entry("edit-new", "file", { changes: [{ path: "new", operation: "edit" }] }),
    entry("removed", "file", { changes: [{ path: "old", operation: "delete" }] }),
    entry("empty-edit", "file", { changes: [{ path: "emptied", added: 0, removed: 10 }] }),
  ]);
  assert.equal(operations.find(file => file.path === "new")?.operation, "create");
  assert.equal(operations.find(file => file.path === "old")?.operation, "delete");
  assert.equal(operations.find(file => file.path === "emptied")?.operation, undefined);
});

test("questions preserve all IDs and explicit multi choice answers through the native respond path", async () => {
  // Property: one synchronous question response covers every question ID and never dispatches a new task.
  const { inputResponse, interactionQuestions } = await import("../ui/state/taskInteractions.ts");
  const interaction = { kind: "question" as const, summary: "Choose", method: "item/tool/requestUserInput", questions: [{ id: "one", question: "First", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }, { id: "two", question: "Second" }], respond: { op: "codex_respond" as const, args: { respondToken: "example" } } };
  assert.equal(interactionQuestions(interaction)[0].multiple, true);
  assert.equal(inputResponse(interaction, { one: ["A"] }), undefined);
  assert.deepEqual(inputResponse(interaction, { one: ["A", "B"], two: ["Custom"] }), { op: "codex_respond", args: { respondToken: "example", result: { answers: { one: { answers: ["A", "B"] }, two: { answers: ["Custom"] } } } } });
  assert.equal(inputResponse({ ...interaction, canRespond: false }, {}, true), undefined);
  assert.equal(inputResponse({ ...interaction, method: "unsupported" }, {}, true), undefined);
});
test("asynchronous questions and Pi selectors keep distinct native answer formats", async () => {
  // Property: asynchronous text and Pi choices retain their owner's response schema and selection constraints.
  const { inputResponse } = await import("../ui/state/taskInteractions.ts");
  const question = { kind: "question" as const, summary: "Choose", method: "request_user_input_async", respond: { op: "codex_respond" as const, args: { id: "question" } } };
  assert.deepEqual(inputResponse(question, { answer: ["Custom"] })?.args.result, { answer: "Custom" });
  assert.equal(inputResponse(question, {}, true, "Skipped")?.args.skipped, true);
  const pi = { ...question, method: "select", options: ["A"], respond: { op: "agent_respond" as const, args: { agent: "pi", interactionId: "question" } } };
  assert.equal(inputResponse(pi, { answer: ["Other"] }), undefined);
  assert.equal(inputResponse(pi, { answer: ["A"] })?.args.value, "A");
  assert.equal(inputResponse(pi, {}, true)?.args.cancelled, true);
});

test("native command action metadata counts searches and reads without guessing from shell text", async () => {
  // Property: structured command actions determine exploration counts while opaque commands remain commands.
  const { toolCounts } = await import("../ui/state/taskProjection.ts");
  const counts = toolCounts([entry("a", "command", { commandActions: [{ type: "read", path: "a" }, { type: "search" }] }), entry("b", "command", { command: "cat hidden", status: "running" })]);
  assert.equal(counts.read, 1);
  assert.equal(counts.search, 1);
  assert.equal(counts.running, 1);
  assert.equal(counts.command, 0);
  assert.equal(toolCounts([entry("list", "command", { commandActions: [{ type: "listFiles" }] })]).list, 1);
  assert.equal(toolCounts([entry("stale", "command", { status: "running" })], false).command, 1);
  assert.equal(toolCounts([entry("stale", "command", { status: "running" })], false).running, 0);
});


test('answered questions remain available outside collapsed process rows', async () => {
  // Regression: answered questions and selected options were hidden behind both turn and process expansion.
  const { interactionSummary }=await import('../ui/state/taskInteractions.ts');
  const interaction={kind:'question' as const,summary:'Interaction required',respond:{},questions:[{id:'q',question:'Pick one',options:[{label:'A'},{label:'B'}]}]};
  const result=projectTurn([entry('answer','interaction',{status:'completed',interaction})],'done');
  assert.equal(result.answeredInteractions.length,1);assert.equal(result.rows.length,0);
  assert.match(interactionSummary(interaction),/Pick one.*A.*B/);
});


test('lifecycle notices do not displace the final reply or create error rows', () => {
  // Regression: a trailing lifecycle notice displaced an unmarked final reply and rendered as an error.
  const answer = entry('final', 'text', { text: 'Retained reply' });
  const notice = entry('notice', 'notice');
  const result = projectTurn([entry('request', 'user'), answer, notice], 'done');
  assert.equal(result.final, answer);
  assert.equal(result.rows.length, 0);
});


test("task evidence is scoped to its turn and idle is not completion", async () => {
  // Regression: idle and a newer turn's result were presented as successful execution.
  const { executionStatus, activityState, executionPhase } = await import("../ui/state/taskExecutionModel.ts");
  const execution = { status: "completed", turnId: "new", turnStatuses: { old: "failed", new: "completed" }, interactions: [] };
  const session = { id: "task", source: "transcript" as const, turnId: "old", phase: "tool" as const, phaseSince: null, headline: "", timeline: true, observed: false };
  assert.equal(executionStatus(execution, "old"), "failed");
  assert.equal(executionStatus(execution, "missing"), undefined);
  assert.equal(activityState(session, execution), "failed");
  assert.equal(activityState({ ...session, observed: true, turnId: "new" }, execution), "running");
  assert.equal(taskState("idle", false), "unknown");
  assert.equal(taskState("running", false), "unknown");
  assert.equal(taskState("completed", false, true), "done");
  assert.equal(executionPhase("interaction", "needsYou"), undefined);
  assert.equal(executionPhase("idle", "running"), undefined);
  assert.equal(executionPhase("tool", "done"), undefined);
  assert.equal(executionPhase("tool", "running"), "tool");
});


test("resolved and previous-turn interactions do not recreate waiting input", async () => {
  // Regression: historical or answered pending entries disagreed with the task header's input state.
  const { pendingSessions } = await import("../ui/state/taskInteractions.ts");
  const interaction = { kind: "question" as const, summary: "Choose", respond: { op: "codex_respond" as const, args: { id: "question" } } };
  const session = { id: "task", source: "codex-thread" as const, turnId: "current", phase: "text" as const, phaseSince: null, headline: "", timeline: true };
  const old = entry("old", "interaction", { turnId: "previous", status: "pending", interaction });
  const answered = entry("answered", "interaction", { turnId: "current", status: "pending", interaction, response: { origin: {}, resolvedAt: "2026-01-01" } });
  assert.equal(pendingSessions("codex", session, [old, answered]).length, 0);
  const pending = entry("new", "interaction", { turnId: "current", status: "pending", interaction });
  assert.equal(pendingSessions("codex", session, [old, answered, pending])[0].turnId, "current");
});

test('homepage activity preserves chronological observations and recorded plan counts', async () => {
  // Property: bounded card projection preserves observed step order and counts only recorded plan items.
  const { taskCardActivity } = await import('../ui/state/taskProjection.ts');
  const content = (text: string) => ({ state: 'available' as const, text, truncated: false, sha256: 'fixture', hashScope: 'excerpt' as const });
  const result = taskCardActivity([
    entry('read', 'file', { operation: 'read', path: 'a.ts' }),
    entry('edit', 'file', { operation: 'edit', path: 'a.ts', changes: [{ path: 'a.ts', added: 4 }] }),
    entry('wait', 'tool', { status: 'pending', title: 'Queued operation' }),
    entry('plan', 'plan', { plan: [{ content: content('Read'), status: 'completed' }, { content: content('Check'), status: 'in_progress' }] }),
  ]);
  assert.deepEqual(result.steps.map(step => step.kind), ['reading', 'editing', 'waiting']);
  assert.equal(result.plan?.completed, 1);
  assert.equal(result.plan?.total, 2);
  assert.equal(result.change?.added, 4);
  assert.equal(result.change?.removed, undefined);
});

test('homepage task groups keep missing observations unconfirmed', async () => {
  // Property: only observed live work contributes active counts and acknowledged completions enter recent history.
  const { homepageTaskGroup, nodeTaskState, capsuleItems } = await import('../ui/state/activityModel.ts');
  const session = { id: 'sample', source: 'arc-task' as const, phase: 'thinking' as const, headline: '', phaseSince: null, timeline: false, orderAt: 0 };
  assert.equal(homepageTaskGroup({ ...session, observed: false }, false), 'unconfirmed');
  assert.equal(homepageTaskGroup(session, true), 'needs-me');
  assert.equal(homepageTaskGroup({ ...session, endedAt: 1, readAt: 2 }, false), 'recent');
  const task = { key: 'sample', agent: 'codex', session, group: 'running' as const, sourceIds: [], activity: { steps: [] }, partial: true };
  const offline = nodeTaskState([task], 'offline');
  assert.equal(offline.running, 0);
  assert.equal(offline.attention, 0);
  assert.equal(offline.unconfirmed, true);
  const items = capsuleItems({ attention: 3, running: 12, unread: 2, steps: [] }, true);
  assert.deepEqual(items.map(item => item.kind), ['attention', 'overflow']);
  assert.deepEqual(capsuleItems({ attention: 0, running: 0, unread: 2, steps: [] }, false), []);
});

test('remote cards keep controller scope, receipt uncertainty and offline freshness', async () => {
  // Regression: remote records were unavailable to the homepage and receipt completion could be mistaken for task completion.
  const { projectDeviceTasks } = await import('../ui/state/activityModel.ts');
  const device = { id: 'member', state: 'online', lastSeen: '2026-01-01T00:00:00Z' };
  const snapshot = { observedAt: device.lastSeen, agents: { codex: { sessions: [{ id: 'running', source: 'arc-task', phase: 'thinking', headline: 'Inspect queue', phaseSince: null, timeline: false }] } }, records: [
    { agent: 'codex', taskId: 'unknown', state: 'completed', createdAt: device.lastSeen, task: { title: 'Acknowledged dispatch' } },
  ] };
  const projected = projectDeviceTasks(device, { snapshot }, []);
  assert.deepEqual(projected.map(task => task.group), ['running', 'unconfirmed']);
  assert.ok(projected.every(task => task.deviceId === device.id));
  const offline = projectDeviceTasks({ ...device, state: 'offline' }, { snapshot }, []);
  assert.ok(offline.every(task => task.group === 'unconfirmed' && !task.session.interaction && !task.startedAt));
});


test('recorded timestamps preserve epoch units and omit unknown starts', async () => {
  // Regression: a remote card displayed hundreds of thousands of elapsed minutes from an invalid start.
  const { recordedTimestamp } = await import('../ui/state/taskProjection.ts');
  const milliseconds = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(recordedTimestamp(milliseconds / 1000), milliseconds);
  assert.equal(recordedTimestamp(String(milliseconds)), milliseconds);
  assert.equal(recordedTimestamp('2026-01-01T00:00:00Z'), milliseconds);
  assert.equal(recordedTimestamp(null), undefined);
  assert.equal(recordedTimestamp(''), undefined);
  assert.equal(recordedTimestamp(0), undefined);
});


test('online devices keep a neutral capsule for unknown task observations', async () => {
  // Regression: an online LAN device inherited the unconfirmed ring from a retained remote dispatch record.
  const { nodeTaskState, capsuleItems } = await import('../ui/state/activityModel.ts');
  const task = { key: 'remote', agent: 'codex', session: { id: 'remote', orderAt: 0 }, group: 'unconfirmed', sourceIds: [], activity: { steps: [] }, partial: true };
  const online = nodeTaskState([task], 'online');
  assert.equal(online.unconfirmed, false);
  assert.equal(online.running, 0);
  assert.deepEqual(capsuleItems(online, true), []);
  assert.equal(nodeTaskState([task], 'offline').unconfirmed, true);
});

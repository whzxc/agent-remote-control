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

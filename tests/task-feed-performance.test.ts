import test from "node:test";
import assert from "node:assert/strict";
import { nativeControl } from "./helpers/native-control.ts";

const fakeCodex = `
  import { createInterface } from "node:readline";
  import { randomUUID } from "node:crypto";
  const threads = new Map();
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) continue;
    let thread = threads.get(params?.threadId), result = {};
    if (method === "thread/start") {
      thread = { id: randomUUID(), cwd: "/fixture", status: { type: "idle" }, turns: [] };
      threads.set(thread.id, thread);
      result = { thread };
    }
    if (method === "thread/read") result = { thread };
    if (method === "thread/turns/list") {
      const all = [...(thread?.turns ?? [])].reverse();
      const start = Number(params.cursor ?? 0), end = start + (params.limit ?? 100);
      result = { data: all.slice(start, end), nextCursor: end < all.length ? String(end) : null };
    }
    if (method === "thread/items/list") {
      const turn = thread.turns.find(turn => turn.id === params.turnId);
      const items = [...turn.items].reverse();
      result = { data: items.slice(0, params.limit).map(item => ({ turnId: turn.id, item })),
        nextCursor: items.length > params.limit ? String(params.limit) : null };
    }
    if (method === "turn/start") {
      const turn = { id: randomUUID(), status: "completed", items: Array.from({ length: 80 }, (_, i) => ({
        id: randomUUID(), type: "agentMessage", text: (thread.turns.length + 1) + ":" + (i + 1),
      })) };
      thread.turns.push(turn);
      result = { turn };
    }
    process.stdout.write(JSON.stringify({ id, result }) + "\\n");
  }
`;

test("task feed sends only changes and recovers when the client misses a revision", async () => {
  // Regression: unchanged desktop polls transferred the entire task list every five seconds.
  const fixture = await nativeControl(fakeCodex);
  try {
    await fixture.api("task-settings", { autoOpenCodex: false }, "PUT");
    const empty = await fixture.api("tasks/snapshot", {});
    assert.deepEqual(empty.records, []);
    assert.deepEqual(await fixture.api("tasks/snapshot", { revision: empty.revision }), { revision: empty.revision });

    const first = await fixture.completed("codex_create", { prompt: "First" });
    const update = await fixture.api("tasks/snapshot", { revision: empty.revision });
    assert.deepEqual(update.records.map(row => row.requestId), [first.requestId]);
    assert.deepEqual(update.removed, []);
    assert.deepEqual(await fixture.api("tasks/snapshot", { revision: update.revision }), { revision: update.revision });

    const second = await fixture.completed("codex_create", { prompt: "Second" });
    const recovered = await fixture.api("tasks/snapshot", { revision: empty.revision });
    assert.deepEqual(new Set(recovered.records.map(row => row.requestId)), new Set([first.requestId, second.requestId]));
    assert.equal(recovered.removed, undefined);
  } finally {
    await fixture.close();
  }
});

test("a cold Codex timeline previews recent items and keeps the older history available", async () => {
  // Regression: opening a long Codex task had to load and project the entire history before showing a reply.
  const fixture = await nativeControl(fakeCodex);
  try {
    await fixture.api("task-settings", { autoOpenCodex: false }, "PUT");
    const first = await fixture.completed("codex_create", { prompt: "First turn" });
    const id = first.threadId;
    const second = await fixture.completed("codex_send", { threadId: id, prompt: "Second turn" });
    assert.equal(second.state, "completed");
    const args = { agent: "codex", id };
    const preview = await fixture.api("agents/conversations/timeline", { ...args, recent: true });
    assert.equal(preview.preview, true);
    assert.ok(preview.entries.some(row => row.text === "2:80"));
    assert.ok(preview.entries.every(row => row.turnId === second.turnId));
    assert.ok(!preview.entries.some(row => row.text === "2:1"));
    const bubblePreview = await fixture.api(`agents/timeline/${id}?recent=1`);
    assert.equal(bubblePreview.preview, true);
    assert.ok(bubblePreview.entries.some(row => row.text === "2:80"));
    const full = await fixture.api("agents/conversations/timeline", args);
    assert.ok(full.entries.some(row => row.text === "1:1"));
    assert.ok(full.entries.some(row => row.text === "2:1"));
    assert.ok(full.entries.some(row => row.text === "2:80"));
    assert.equal(full.preview, undefined);
  } finally {
    await fixture.close();
  }
});

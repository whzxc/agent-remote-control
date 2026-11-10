import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const text = 'A fictional task checks the repository, updates the requested behavior, and records the result. ';
export function retainedReceipt(requestId: string, threadId: string, agent = false) {
  return {
    requestId, threadId, turnId: randomUUID(), operation: agent ? 'agent_send' : 'send', state: 'completed',
    backendSession: 'previous-core', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    origin: { ingressId: 'local-cli', sourceId: 'fixture-source', controlSource: 'local-cli' },
    task: { kind: 'send', title: 'Fixture task', prompt: text.repeat(3), input: [{ type: 'text', text: text.repeat(5) }] },
    arguments: { threadId, input: [{ type: 'text', text: text.repeat(6) }], cwd: '/fictional/workspace' },
    result: { thread: { id: threadId, name: 'Fixture thread', cwd: '/fictional/workspace' },
      turn: { id: randomUUID(), status: 'completed', items: Array.from({ length: agent ? 112 : 10 }, (_, n) => ({
        id: `item-${n}`, type: n % 2 ? 'agentMessage' : 'commandExecution',
        text: text.repeat(3), status: 'completed', exitCode: 0,
      })) }, usage: { inputTokens: 2000, outputTokens: 800 } },
  };
}
export function retainedBinding(threadId: string, n: number) {
  return {
    threadId, turnId: `turn-${n}`, sourceId: 'fixture-source', channel: 'mcp-events', target: null,
    agent: 'codex', project: 'fixture', title: 'Fixture task', createdAt: Math.floor(Date.now() / 1000),
    waiting: [], scopeEnd: 'scope-ended', observation: { state: 'completed', recordedStatus: 'completed', reconciliation: 'reconciled' },
    deliveries: Array.from({ length: 5 }, (_, i) => ({
      key: `delivery-${i}`, eventId: `event-${i}`, subscription: `subscription-${i}`, channel: 'mcp-events', target: '',
      state: 'completed', taskState: 'completed', status: 'callback-accepted', failures: 0, attempts: [['fixture', 100]],
      timing: { queuedAt: 100, startedAt: 101, finishedAt: 102, queueMs: 1, sendMs: 1 },
      finalResponse: { text: text.repeat(12) }, changes: { files: Array.from({ length: 5 }, (_, k) => ({ path: `src/file-${k}.ts`, added: 5, removed: 2 })) },
      externalUserInputs: [{ type: 'text', text: text.repeat(4) }],
    })),
  };
}
export async function writeRetainedState(state: string, receipts = 7860, bindings = 1080, agents = 52) {
  await Promise.all(['', 'agents/requests', 'notifications/tasks'].map(dir => mkdir(path.join(state, dir, '.activity-index/dirty'), { recursive: true })));
  const ids: string[] = [];
  const totals = { receipts: 0, bindings: 0, agents: 0 };
  // Bound fixture creation too, without a promise or buffer for every retained file.
  for (let offset = 0; offset < Math.max(receipts, bindings, agents); offset += 64) {
    const writes: Promise<void>[] = [];
    for (let n = offset; n < offset + 64; n++) {
      if (n < receipts) {
        const id = randomUUID(); ids.push(id);
        const row = retainedReceipt(id, randomUUID());
        row.task = { kind: 'send', title: 'Fixture task', prompt: text, input: [] };
        row.arguments = { threadId: row.threadId, input: [], cwd: '/fictional/workspace' };
        row.result.turn.items = [];
        // Match the installed receipt corpus: 7860 records, about 16 MB.
        (row.result as any).payload = 'x'.repeat(2048 - Buffer.byteLength(JSON.stringify(row)));
        // Exercise actual legacy provenance conversion, as well as unchanged records.
        if (n % 8 === 0) delete (row.origin as any).sourceId;
        const bytes = JSON.stringify(row); totals.receipts += Buffer.byteLength(bytes);
        writes.push(writeFile(path.join(state, `${id}.json`), bytes));
        // Leftovers from an interrupted per-key migration must also clear in one batch.
        writes.push(writeFile(path.join(state, '.activity-index/dirty', `${id}.json`), 'dirty'));
      }
      if (n < bindings) {
        const b = retainedBinding(randomUUID(), n);
        const key = createHash('sha256').update(JSON.stringify([b.threadId, b.turnId])).digest('hex');
        const bytes = JSON.stringify(b); totals.bindings += Buffer.byteLength(bytes);
        writes.push(writeFile(path.join(state, 'notifications/tasks', `${key}.json`), bytes));
        writes.push(writeFile(path.join(state, 'notifications/tasks/.activity-index/dirty', `${key}.json`), 'dirty'));
      }
      if (n < agents) {
        const id = randomUUID(), bytes = JSON.stringify(retainedReceipt(id, randomUUID(), true));
        totals.agents += Buffer.byteLength(bytes);
        writes.push(writeFile(path.join(state, 'agents/requests', `${id}.json`), bytes));
      }
    }
    await Promise.all(writes);
  }
  return { ids, totals };
}

// Observe fixture-owned canonical files without coupling assertions to index layout.
export async function canonicalSnapshot(state: string) {
  const files = new Map<string, { bytes: string; mtime: number }>();
  for (const owner of ['', 'agents/requests', 'notifications/tasks']) {
    const directory = path.join(state, owner);
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json') || (!owner && !/^[0-9a-f-]{36}\.json$/.test(name))) continue;
      const file = path.join(directory, name);
      files.set(file, { bytes: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs });
    }
  }
  return files;
}

export async function indexPublications(state: string) {
  const publications: { at: number; profile: any }[] = [];
  for (const name of await readdir(path.join(state, 'logs'))) {
    for (const line of (await readFile(path.join(state, 'logs', name), 'utf8')).split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.msg.startsWith('Index startup ')) publications.push({ at: Date.parse(row.time), profile: JSON.parse(row.msg.slice('Index startup '.length)) });
    }
  }
  return publications;
}

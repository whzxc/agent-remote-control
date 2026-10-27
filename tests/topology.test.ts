import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, conversationKey, LINGER_MS, type Session, type Candidate } from '../ui/topology/solve.ts';
const now = 1_000_000;
const candidates: Candidate[] = ['claude', 'codex'].map(agent => ({ id: agent, side: 'local', label: agent, agent, sourceIds: [] }));
function chain(length: number): Session[] {
  return Array.from({ length }, (_, i) => ({ agent: 'codex', session: { id: `node-${i}`, source: 'codex-thread', title: `Task ${i}`, headline: '', phase: 'command', phaseSince: null,
    timeline: true, orderAt: now - 1000, dispatchSummary: { caller: i ? { agent: 'codex', conversationId: `node-${i - 1}` } : { agent: 'claude', conversationId: 'root' } } } }));
}
for (const orientation of ['landscape', 'portrait'] as const) {
  test(`every live conversation is placed exactly once in ${orientation}`, () => {
    // Property: connected and floating conversations appear exactly once regardless of session input order or shared callers.
    for (let n = 1; n <= 80; n += 7) {
      const sessions = chain(n);
      sessions.push({ ...sessions[0], session: { ...sessions[0].session, id: 'branch' } });
      sessions.push({ agent: 'claude', session: { ...sessions[0].session, id: 'floating', dispatchSummary: undefined } });
      const model = solve({ sessions: sessions.reverse(), candidates, width: 900, height: 700, orientation, now });
      const nodes = [...model.loops.flatMap(l => l.nodes), ...model.floating];
      assert.equal(new Set(nodes.map(n => n.id)).size, sessions.length + 1);
      assert.equal(nodes.length, sessions.length + 1);
      for (const { agent, session } of sessions) assert.equal(nodes.filter(n => n.id === conversationKey(agent, session.id)).length, 1);
    }
  });
  test(`depth and ring follow dispatch edges in ${orientation}`, () => {
    // Property: every chain hop increases depth by one and the ring separates roots from depth one without overlap.
    for (let n = 1; n <= 100; n += 3) {
      const model = solve({ sessions: chain(n), candidates, width: 780, height: 820, orientation, now });
      const loop = model.loops[0], vertical = orientation === 'portrait';
      for (const edge of loop.edges) {
        const from = loop.nodes.find(n => n.id === edge.from)!, to = loop.nodes.find(n => n.id === edge.to)!;
        assert.equal(to.depth, from.depth + 1);
        if (!from.depth) {
          const ring = vertical ? model.ring.y : model.ring.x, radius = model.ring.radius;
          assert.ok((vertical ? from.y + from.height : from.x + from.width) < ring - radius);
          assert.ok((vertical ? to.y : to.x) > ring + radius);
          assert.equal(edge.throughRing, true);
        } else assert.equal(edge.throughRing, false);
      }
      assert.equal(loop.depth, n);
    }
  });
  test(`column nodes never overlap in ${orientation}`, () => {
    // Property: sibling and independent loop bands have disjoint node intervals in every depth column.
    for (let count = 1; count <= 40; count++) {
      const sessions = Array.from({ length: count }, (_, i) => ({ ...chain(1)[0], session: { ...chain(1)[0].session, id: `leaf-${i}`,
        dispatchSummary: { caller: { agent: 'claude', conversationId: `root-${i % 3}` } } } }));
      const model = solve({ sessions, candidates, width: 390, height: 720, orientation, now });
      const nodes = model.loops.flatMap(l => l.nodes);
      for (const a of nodes) for (const b of nodes) {
        if (a.id >= b.id || a.depth !== b.depth) continue;
        assert.ok(orientation === 'portrait' ? a.x + a.width <= b.x || b.x + b.width <= a.x : a.y + a.height <= b.y || b.y + b.height <= a.y);
      }
    }
  });
  test(`arbitrarily long chains stay within ${orientation} scroll extent`, () => {
    // Property: increasing depth extends the flow extent and every node remains fully inside it.
    let previous = 0;
    for (const count of [1, 2, 3, 8, 20, 80, 200, 500]) {
      const model = solve({ sessions: chain(count), candidates, width: 390, height: 720, orientation, now });
      const extent = orientation === 'portrait' ? model.height : model.width;
      assert.ok(extent >= previous); previous = extent;
      for (const node of model.loops.flatMap(l => l.nodes)) {
        assert.ok(node.x >= 0 && node.y >= 0);
        assert.ok(node.x + node.width <= model.width && node.y + node.height <= model.height);
      }
    }
  });
}
test('loop lifecycle follows completion, acknowledgements and new dispatches', () => {
  // Property: ended loops linger for three minutes, a completion read returns the group and a later dispatch reactivates it.
  const ended = chain(2).map(row => ({ ...row, session: { ...row.session, endedAt: now } }));
  const project = (sessions: Session[], clock: number) => solve({ sessions, candidates, width: 1000, height: 700, orientation: 'landscape', now: clock });
  assert.equal(project(ended, now + LINGER_MS - 1).loops[0].lingering, true);
  const expired = project(ended, now + LINGER_MS);
  assert.equal(expired.loops.length, 0);
  assert.equal(expired.candidates.find(c => c.id === 'codex')!.unread, true);
  const read = ended.map((row, i) => i ? row : { ...row, session: { ...row.session, readAt: now + 1 } });
  assert.equal(project(read, now + 1).loops.length, 0);
  const next = chain(3)[2]; next.session.orderAt = now + 2;
  const active = project([...read, next], now + 3);
  assert.equal(active.loops.length, 1); assert.equal(active.loops[0].lingering, false);
  assert.equal(active.loops[0].nodes.length, 4);
});
test('caller metadata identifies a root without turning metadata into activity', () => {
  // Property: only referenced conversation metadata joins a loop and native identity shares one node with its executor.
  const sessions = chain(2);
  const model = solve({ sessions, candidates, width: 900, height: 700, orientation: 'landscape', now,
    conversations: [{ agent: 'claude', conversation: { id: 'root', source: 'native', createdAt: null, title: 'Dispatch work' } },
      { agent: 'claude', conversation: { id: 'unused', source: 'native', createdAt: null } }] });
  assert.equal(model.loops[0].nodes.find(n => n.depth === 0)!.label, 'Dispatch work');
  assert.equal(model.floating.length, 0);
  const caller = { ...chain(1)[0], session: { ...chain(1)[0].session, id: 'arc-task', nativeSessionId: 'root', dispatchSummary: { controlSource: { id: 'remote', kind: 'claude' } } } };
  const child = { ...chain(1)[0], session: { ...chain(1)[0].session, dispatchSummary: { caller: { agent: 'codex', conversationId: 'root' } } } };
  const shared = solve({ sessions: [caller, child], candidates, width: 900, height: 700, orientation: 'landscape', now });
  assert.equal(shared.loops.length, 1); assert.equal(shared.loops[0].nodes.length, 3);
  assert.equal(shared.loops[0].nodes.find(n => n.id === conversationKey('codex', 'root'))!.kind, 'executor');
});
test('candidate order and living loop colors survive unrelated activity changes', () => {
  // Property: candidate input order is preserved within each side and supplied living colors are retained.
  const input: Candidate[] = [{ id: 'remote-2', side: 'cloud', label: 'Second', sourceIds: ['remote'] }, ...candidates, { id: 'remote-1', side: 'cloud', label: 'First', sourceIds: [] }];
  const first = solve({ sessions: chain(1), candidates: input, width: 320, height: 700, orientation: 'portrait', now });
  assert.deepEqual(first.candidates.filter(c => c.side === 'cloud').map(c => c.id), ['remote-2', 'remote-1']);
  assert.deepEqual(first.candidates.filter(c => c.side === 'local').map(c => c.id), ['claude', 'codex']);
  const color = { [first.loops[0].id]: 6 };
  const next = solve({ sessions: chain(3), candidates: input, width: 1200, height: 700, orientation: 'landscape', now, colors: color });
  assert.equal(next.loops[0].color, 6);
});

test('light follows the active tail through completed intermediate executors', () => {
  // Property: an active chain tail keeps each ancestor wire lit, and a waiting tail returns warning light upstream.
  const sessions = chain(5).map((row, i) => ({ ...row, session: { ...row.session, ...(i < 4 ? { endedAt: now } : {}) } }));
  const project = () => solve({ sessions, candidates, width: 900, height: 700, orientation: 'landscape', now });
  assert.equal(project().loops[0].edges.every(e => e.state === 'running'), true);
  sessions[4].session.interaction = { kind: 'question', summary: 'Confirm', respond: {} };
  assert.equal(project().loops[0].edges.every(e => e.state === 'waiting'), true);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNormalizer, coverage, diffJSON, expandJSON, NOTIFICATION_KINDS } from '../tooling/agent-scenarios-lib.mjs';

test('capture normalization preserves identities and behavior across independent runs', () => {
  // Property: equivalent captures normalize equally while distinct identities and behavioral changes stay distinct.
  const response = (id, other, directory, stamp) => ({
    call: { threadId: id, project: directory },
    response: { content: [{ type: 'text', text: JSON.stringify({ threadId: id, turnId: other, at: stamp,
      createdAt: stamp.startsWith('2025') ? 1740000000 : 1790000000000, path: `${directory}/seed-${other}.jsonl`, state: 'completed' }) }] },
  });
  const a = createNormalizer({ directory: '/tmp/one' })(response('a1234567-1234-4567-8123-123456789abc', 'b1234567-1234-4567-8123-123456789abc', '/tmp/one', '2025-02-20T12:00:00Z'));
  const b = createNormalizer({ directory: '/tmp/two' })(response('c1234567-1234-4567-8123-123456789abc', 'd1234567-1234-4567-8123-123456789abc', '/tmp/two', '2026-09-20T12:00:00.123Z'));
  const decoded = expandJSON(a);
  assert.equal(decoded.call.threadId, decoded.response.content[0].text.threadId);
  assert.notEqual(decoded.call.threadId, decoded.response.content[0].text.turnId);
  // Timestamp units are intentionally retained as different placeholders.
  assert.equal(diffJSON(expandJSON(a), expandJSON(b)).length, 1);
  const sameUnits = structuredClone(b);
  const text = JSON.parse(sameUnits.response.content[0].text);
  text.createdAt = '<epoch-s>';
  sameUnits.response.content[0].text = JSON.stringify(text);
  assert.deepEqual(a, sameUnits);
  text.state = 'failed';
  sameUnits.response.content[0].text = JSON.stringify(text);
  assert.deepEqual(diffJSON(expandJSON(a), expandJSON(sameUnits)).map(d => d.path), ['/response/content/0/text/state']);
});

test('masks retain presence and do not hide unrelated hashes or primitive text', () => {
  // Property: volatile values are ignored without ignoring field removal or unrelated content.
  const normalize = createNormalizer();
  const before = normalize({ guideHash: 'one', next: { hash: 'two' }, hash: 'kept', cliPath: '/bin/arc', text: 'null' });
  const after = normalize({ guideHash: 'three', next: { hash: 'four' }, hash: 'changed', cliPath: '/other/arc', text: null });
  assert.deepEqual(diffJSON(expandJSON(before), expandJSON(after)).map(d => d.path), ['/hash', '/text']);
  delete after.guideHash;
  assert.ok(diffJSON(before, after).some(d => d.path === '/guideHash' && d.change === 'removed'));
  assert.deepEqual(normalize(before), before);
});

test('coverage is a partition and counts scenario approval separately from uncovered ops', () => {
  // Property: every op has exactly one owner and capture states partition each capability's defined scenarios.
  const catalog = { ops: [{ name: 'alpha' }, { name: 'beta' }] };
  const capabilities = [{ id: 'one', ops: ['alpha', 'beta'], notificationKinds: NOTIFICATION_KINDS }];
  const scenarios = ['approved', 'pending', 'missing'].map(id => ({ id, capability: 'one', ops: ['alpha'] }));
  const report = coverage(catalog, capabilities, scenarios, { approved: { result: true }, pending: { result: false } }, { approved: { result: true } });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.rows.map(({ ops, coveredOps, missingOps, approved, pending, missing }) => ({ ops, coveredOps, missingOps, approved, pending, missing })),
    [{ ops: 2, coveredOps: 1, missingOps: ['beta'], approved: 1, pending: 1, missing: 1 }]);
  for (const ops of [['alpha'], ['alpha', 'alpha', 'beta'], ['alpha', 'beta', 'retired']]) {
    assert.ok(coverage(catalog, [{ ...capabilities[0], ops }], scenarios).errors.length > 0);
  }
});

test('structured diffs distinguish additions, removals and escaped JSON pointer keys', () => {
  // Property: diff paths retain arbitrary JSON keys and additions/removals without losing primitive types.
  const changes = diffJSON({ 'a/b': { '~value': 1 }, removed: true, text: 'false' }, { 'a/b': { '~value': 2 }, added: true, text: false });
  assert.deepEqual(changes.map(({ path, change }) => ({ path, change })), [
    { path: '/a~1b/~0value', change: 'changed' }, { path: '/added', change: 'added' },
    { path: '/removed', change: 'removed' }, { path: '/text', change: 'changed' },
  ]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeControl } from './helpers/native-control.ts';

test('desktop AX reads preserve pagination, closed decisions and local evidence', async () => {
  // Regression: the Board could not read the AX owner list or inspect closed decision reasons and evidence.
  const fixture = await nativeControl('');
  try {
    const first = await fixture.call('ax_report', { symptom: 'Native task state remained stale', expected: 'Show the native terminal state', severity: 'workaround' });
    const second = await fixture.call('ax_report', { symptom: 'Decision history was inaccessible', expected: 'Expose the retained local decision', severity: 'cosmetic', receiptIds: [first.receipt.requestId] });
    const reason = 'Retain the original native session ownership';
    await fixture.call('ax_triage', { id: second.entry.id, expectedRevision: second.entry.revision, action: 'wontfix', reason });
    const page = await fixture.api('coordination/ax_list', { limit: 1 });
    assert.equal(page.entries.length, 1);
    assert.ok(page.nextCursor);
    const next = await fixture.api('coordination/ax_list', { limit: 1, cursor: page.nextCursor });
    assert.equal(next.nextCursor, null);
    assert.deepEqual([...page.entries, ...next.entries].map((row: any) => row.id).sort(), [first.entry.id, second.entry.id].sort());
    const closed = await fixture.api('coordination/ax_list', { status: 'closed', id: second.entry.id });
    assert.equal(closed.entries[0].resolution, 'wontfix');
    assert.equal(closed.entries[0].history.at(-1).detail.reason, reason);
    assert.ok(closed.entries[0].evidence.some((item: any) => item.id === first.receipt.requestId && item.availability === 'available'));
    const cli = await fixture.shell(`printf '%s' '${JSON.stringify({ body: { id: second.entry.id } })}' | arc cli call coordination.ax_list --stdin`);
    assert.equal(JSON.parse(cli.stdout).result.entries[0].id, second.entry.id);
    await fixture.restart();
    const retained = await fixture.api('coordination/ax_list', { id: second.entry.id });
    assert.equal(retained.entries[0].history.at(-1).detail.reason, reason);
  } finally { await fixture.close(); }
});

test('desktop bulletin management uses local authority, owner revisions, replay and retained journal readback', async () => {
  // Regression: desktop had no authenticated local adapter for bulletin edits and event reads.
  const fixture = await nativeControl('');
  try {
    const requestId = randomUUID();
    const args = { intent: 'Coordinate synthetic desktop work', resources: ['app:installed'], expectedDurationSeconds: 60, requestId };
    const posted = await fixture.api('coordination/notice_post', args);
    assert.ok(posted.notice?.localOrigin, JSON.stringify(posted));
    const again = await fixture.api('coordination/notice_post', args);
    assert.equal(again.notice.id, posted.notice.id);
    const updated = await fixture.api('coordination/notice_update', { id: posted.notice.id, expectedRevision: 1, intent: 'Updated synthetic work' });
    assert.equal(updated.notice.revision, 2);
    const conflict = await fixture.api('coordination/notice_update', { id: posted.notice.id, expectedRevision: 1, intent: 'Obsolete draft' });
    assert.equal(conflict.error.code, 'COORDINATION_REVISION_CONFLICT');
    const opened = await fixture.api('coordination/blocker_open', { summary: 'Synthetic resource condition', causeCode: 'inspection-required', resources: ['app:installed'] });
    assert.equal(opened.blocker.state, 'active');
    const board = await fixture.api('coordination/board', { view: 'full' });
    assert.ok(board.notices.some((row: any) => row.id === posted.notice.id));
    assert.ok(board.blockers.some((row: any) => row.id === opened.blocker.id));
    assert.equal(board.notificationCoverage, 'observed');
    assert.deepEqual(board.notificationProblems, []);
    assert.ok(board.conflicts.some((row: any) => row.noticeId === posted.notice.id));
    // Attention references the live blocker from its owner; local authority acts for no source.
    const matter = board.attention.items.find((item: any) => item.id === opened.blocker.id);
    assert.equal(matter?.kind, 'blocker');
    assert.equal(matter.requiredActor, 'user');
    assert.equal(board.attention.coverage.ax, 'observed');
    const cleared = await fixture.api('coordination/blocker_clear', { id: opened.blocker.id, expectedRevision: 1, reason: 'Non-code recovery observed', evidenceIds: ['synthetic-inspection'], suggestedNextStep: 'inspect' });
    assert.equal(cleared.blocker.state, 'cleared');
    assert.deepEqual(cleared.blocker.evidenceIds, ['synthetic-inspection']);
    assert.equal(cleared.blocker.suggestedNextStep, 'inspect');
    assert.equal(cleared.recoverySelection?.automaticResume ?? false, false);
    const closed = await fixture.api('coordination/notice_close', { id: posted.notice.id, reason: 'completed' });
    assert.equal(closed.notice.state, 'closed');
    const current = await fixture.api('coordination/board', { view: 'full' });
    assert.equal(current.notices.length + current.blockers.length, 0);
    assert.ok(!current.attention.items.some((item: any) => item.id === opened.blocker.id));
    const history = await fixture.api('coordination/board', { view: 'full', state: 'all' });
    assert.equal(history.notices[0].closedReason, 'completed');
    assert.equal(history.blockers[0].reason, 'Non-code recovery observed');
    const journal = await fixture.api('coordination/events', { limit: 100 });
    assert.ok(journal.events.some((event: any) => event.kind === 'blocker.changed' && event.status === 'cleared'));
    assert.ok(journal.nextCursor);
    const resources = await fixture.api('coordination/resources');
    assert.ok(resources.resources.some((row: any) => row.key === 'app:installed'));
    await fixture.restart();
    const retained = await fixture.api('coordination/board', { view: 'full', id: opened.blocker.id });
    assert.equal(retained.blockers[0].state, 'cleared');
    assert.deepEqual(retained.blockers[0].evidenceIds, ['synthetic-inspection']);
  } finally { await fixture.close(); }
});


test('board keeps AX attention structured without duplicate summary lines', async () => {
  // Regression: AX-only attention repeated its kind and identifier in the board summary.
  const fixture = await nativeControl('');
  try {
    await fixture.call('ax_report', {symptom:'Fixture blocking control decision', expected:'Expose actionable AX attention', severity:'blocking'});
    const board = await fixture.api('coordination/board', {view:'summary'});
    assert.ok(board.attention.items.some((item: any) => item.kind === 'ax-triage' && item.open > 0 && item.next.op === 'ax_list'));
    assert.ok(!board.summary?.includes('ax-triage'));
  } finally { await fixture.close(); }
});

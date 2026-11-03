import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeControl } from './helpers/native-control.ts';

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
    const cleared = await fixture.api('coordination/blocker_clear', { id: opened.blocker.id, expectedRevision: 1, reason: 'Non-code recovery observed', evidenceIds: ['synthetic-inspection'], suggestedNextStep: 'inspect' });
    assert.equal(cleared.blocker.state, 'cleared');
    assert.deepEqual(cleared.blocker.evidenceIds, ['synthetic-inspection']);
    assert.equal(cleared.blocker.suggestedNextStep, 'inspect');
    assert.equal(cleared.recoverySelection?.automaticResume ?? false, false);
    const closed = await fixture.api('coordination/notice_close', { id: posted.notice.id, reason: 'completed' });
    assert.equal(closed.notice.state, 'closed');
    const current = await fixture.api('coordination/board', { view: 'full' });
    assert.equal(current.notices.length + current.blockers.length, 0);
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';

test('legacy negotiation recovery restores Messages, Board and session route operations', async () => {
  // Regression: singleton participant snapshots blocked Messages and Board through the legacy route import.
  const fixture = await nativeControl('');
  try {
    const owners: Array<{ ingress: string; source: string }> = [];
    for (const id of ['recovery-one', 'recovery-two']) {
      await fixture.api('ingress', { id, name: id, controlSource: 'claude', transport: 'https', auth: 'bearer', bearerToken: 'synthetic-recovery'.padEnd(40, 'x'), toolPolicy: 'all', config: { httpsProvider: 'custom', httpsUrl: 'https://fixture.example.com/mcp' } });
      await fixture.api(`ingress/${id}/start`, {});
      const identity = await fixture.sourceCall(id, 'whoami', {}, 'query');
      assert.ok(identity.sourceId, JSON.stringify(identity));
      owners.push({ ingress: id, source: identity.sourceId });
    }
    const [one, two] = owners;
    const session = await fixture.sourceCall(one.ingress, 'coordination_session', { action: 'register' });
    assert.ok(session.session?.id, JSON.stringify(session));
    for (let i = 0; i < 3; i++) {
      const first = await fixture.sourceCall(one.ingress, 'message_send', { toSourceId: two.source, type: 'request', resources: ['app:installed'], summary: 'Synthetic resource request' });
      assert.ok(first.message, JSON.stringify(first));
      const second = await fixture.sourceCall(two.ingress, 'message_send', { toSourceId: one.source, type: 'grant', resources: ['app:installed'], summary: 'Synthetic resource grant', negotiationId: first.message.negotiationId, inReplyTo: first.message.messageId });
      assert.equal(second.negotiation.state, 'resolved');
    }
    for (let i = 0; i < 5; i++) {
      const sent = await fixture.sourceCall(one.ingress, 'message_send', { toSourceId: two.source, type: 'notice', resources: ['app:installed'], summary: 'Synthetic notice' });
      assert.ok(sent.message);
    }
    let expectedMessages: unknown[] = [];
    let expectedNegotiations: any[] = [];
    await fixture.restart(async directory => {
      const file = path.join(directory, 'coordination/messages/state.json');
      const snapshot = JSON.parse(await readFile(file, 'utf8'));
      for (const row of snapshot.messages) {
        row.envelope.fromSourceId = one.source;
        row.envelope.toSourceId = one.source;
      }
      for (const n of snapshot.negotiations) n.participants = [one.source];
      snapshot.routes = { [`${one.source}:${session.session.id}`]: { sourceId: one.source, routeId: 'synthetic-old-route', generation: 'synthetic-generation', bindingId: 'synthetic-binding' } };
      expectedMessages = snapshot.messages.map((row: any) => row.envelope);
      expectedNegotiations = snapshot.negotiations.map((n: any) => ({ ...n, participantRecovery: { state: 'unresolved', originalParticipants: [one.source] } }));
      await writeFile(file, JSON.stringify(snapshot));
    });
    // Board reads import routes before Messages is explicitly queried.
    const board = await fixture.call('board', { includeSessions: true });
    const migrated = board.sessions.find((row: any) => row.id === session.session.id);
    assert.equal(migrated.routing.reason, 'route-target-unverified');
    const local = await fixture.api('coordination/messages');
    assert.deepEqual(local.messages, expectedMessages);
    assert.deepEqual(local.negotiations, expectedNegotiations);
    assert.equal(local.messages.length, 11);
    const inbox = await fixture.sourceCall(one.ingress, 'messages', {}, 'query');
    assert.deepEqual(inbox.messages, expectedMessages);
    assert.deepEqual(inbox.negotiations, expectedNegotiations);
    const hidden = await fixture.sourceCall(two.ingress, 'messages', {}, 'query');
    assert.deepEqual(hidden.messages, []);
    assert.deepEqual(hidden.negotiations, []);
    const unbound = await fixture.sourceCall(one.ingress, 'message_route', { sessionId: session.session.id, target: null });
    assert.equal(unbound.routing.reason, 'no-verified-target');
    const sent = await fixture.sourceCall(two.ingress, 'message_send', { toSourceId: one.source, type: 'request', resources: ['app:installed'], summary: 'Request after recovery' });
    assert.ok(sent.message, JSON.stringify(sent));
    assert.deepEqual(sent.negotiation.participants, [one.source, two.source].sort());
    await fixture.restart();
    const after = await fixture.api('coordination/messages');
    assert.equal(after.messages.length, 12);
    assert.deepEqual(after.negotiations.slice(0, 3), expectedNegotiations);
    const again = await fixture.call('board', { includeSessions: true });
    assert.equal(again.sessions.find((row: any) => row.id === session.session.id).routing.reason, 'no-verified-target');
  } finally {
    await fixture.close();
  }
});

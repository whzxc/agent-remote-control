import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionReadiness } from '../ui/connectionReadiness.ts';

const ready = { enabled: true, running: true, state: 'ready', error: '' };
const stopped = { ...ready, running: false, state: 'stopped' };

test('readiness reports a partial failure when another ingress is ready', () => {
  // Regression: one running ingress made the global switch look ready while another ingress failed.
  const failed = { ...stopped, state: 'error', error: 'Connection failed' };
  assert.equal(connectionReadiness([ready, failed]), 'partial');
  assert.equal(connectionReadiness([failed, ready]), 'partial');
  assert.equal(connectionReadiness([failed]), 'error');
  assert.equal(connectionReadiness([{ ...ready, state: 'degraded', error: 'Connection failed' }]), 'error');
});

test('readiness requires positive evidence from every enabled or running ingress', () => {
  // Property: readiness cannot be inferred from an absent snapshot, a process flag, or a disabled idle ingress.
  assert.equal(connectionReadiness(undefined), 'unknown');
  assert.equal(connectionReadiness([{ ...ready, state: 'unrecognized' }]), 'unknown');
  assert.equal(connectionReadiness([{ ...ready, running: false }]), 'unknown');
  assert.equal(connectionReadiness([ready, stopped]), 'partial');
  assert.equal(connectionReadiness([ready, { ...stopped, enabled: false }]), 'ready');
  assert.equal(connectionReadiness([{ ...ready, enabled: false }]), 'ready');
  assert.equal(connectionReadiness([stopped]), 'stopped');
  assert.equal(connectionReadiness([]), 'stopped');
});

test('readiness retains transitions until every participating ingress settles', () => {
  // Property: a starting or stopping ingress prevents a settled aggregate in either input order.
  for (const state of ['starting', 'stopping'] as const) {
    const transition = { ...ready, state };
    assert.equal(connectionReadiness([ready, transition]), state);
    assert.equal(connectionReadiness([transition, ready]), state);
  }
});

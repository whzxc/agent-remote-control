import test from 'node:test';
import assert from 'node:assert/strict';
import { beginScenario, finishScenario, missingScenarioRoute, scenarioReadiness } from '../ui/state/scenarioReadiness.ts';
test('fixture readiness waits for its final task detail and loaded timeline', () => {
  // Recurring bug class: fixture auto-open replaced list nodes after agents began interacting.
  beginScenario('task-actions','target');
  assert.equal(scenarioReadiness(null)?.ready,false);
  finishScenario();
  assert.equal(scenarioReadiness({id:'other',timeline:{}})?.ready,false);
  assert.equal(scenarioReadiness({id:'target'})?.ready,false);
  assert.equal(scenarioReadiness({id:'target',timeline:{entries:[]}})?.ready,true);
  finishScenario('load failed');assert.equal(scenarioReadiness(null)?.state,'failed');
});

test('missing fixture routes fail readiness even after initialization finishes', () => {
  // Recurring bug class: unsupported app/env and request-routing reads were swallowed while the fixture claimed ready.
  beginScenario('missing-routes');
  finishScenario();
  assert.equal(scenarioReadiness(null)?.ready, true);
  missingScenarioRoute('app/env', 'GET');
  missingScenarioRoute('tasks/request-routing', 'POST');
  missingScenarioRoute('app/env', 'GET');
  finishScenario();
  const result = scenarioReadiness(null)!;
  assert.equal(result.ready, false);
  assert.equal(result.state, 'failed');
  assert.deepEqual(result.missingRoutes, ['GET app/env', 'POST tasks/request-routing']);
  assert.match(result.error!, /app\/env.*tasks\/request-routing/);
  beginScenario('next'); finishScenario();
  assert.equal(scenarioReadiness(null)?.ready, true);
});

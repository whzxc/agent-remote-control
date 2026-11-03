import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const defaultState = () => process.env.ARC_STATE_DIR || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || homedir(), 'agent-remote-control')
  : path.join((process.platform === 'linux' && process.env.XDG_STATE_HOME) || path.join(homedir(), '.local/state'), 'agent-remote-control'));
async function durable(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
  if (process.platform !== 'win32') {
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
async function coreCaller(stateDirectory, request) {
  const endpoint = JSON.parse(await readFile(path.join(stateDirectory, 'app/native.json'), 'utf8'));
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string') throw new Error('invalid endpoint');
  const call = async (route, method, payload) => {
    const response = await request(`http://127.0.0.1:${endpoint.port}/${route}`, {
      method, headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(2500),
    });
    const result = await response.json();
    if (!response.ok) throw new Error('report unavailable');
    return result;
  };
  const health = await call('healthz', 'GET');
  if (health.instance !== endpoint.instance || health.pid !== endpoint.pid || health.owner !== 'core') throw new Error('identity changed');
  return call;
}
export async function reportConflicts(body, { stateDirectory = defaultState(), request = fetch } = {}) {
  try {
    const call = await coreCaller(stateDirectory, request);
    return await call('api/coordination/conflicts', 'POST', body);
  } catch { return { conflicts: [], conflictCoverage: 'unknown' }; }
}
// Each report has a fixed ID and payload across retries. An unavailable Core never
// changes the command's exit code. Endpoint tokens never enter reports or console output.
export async function reportLifecycle(body, { stateDirectory = defaultState(), request = fetch } = {}) {
  try {
    const call = await coreCaller(stateDirectory, request);
    await call('api/coordination/observe', 'POST', body);
    const result = await call(`api/coordination/observations/${body.transitionId}`, 'GET');
    if (result.transitionId !== body.transitionId || result.state !== 'observed' || result.kind !== body.kind) throw new Error('readback missing');
    return { transitionId: body.transitionId, kind: body.kind, coverage: 'readback-confirmed', conflicts: result.conflicts || [], conflictCoverage: result.conflictCoverage || 'unknown' };
  } catch {
    return { transitionId: body.transitionId, kind: body.kind, coverage: 'missing', reason: 'Core reporting or readback unavailable; the tooling result is unchanged' };
  }
}
export async function beginLifecycle(directory, body, options = {}) {
  const report = { ...body, ...(process.env.ARC_TOOLING_ORIGIN ? { toolingOrigin: process.env.ARC_TOOLING_ORIGIN } : {}), transitionId: randomUUID() };
  if (['lane.landed', 'isolated.started'].includes(body.kind)) {
    const warnings = await reportConflicts(report, options);
    console.log(JSON.stringify({ event: 'coordination-conflicts', ...warnings }));
  }
  const file = path.join(directory, `${report.transitionId}.json`);
  let stored = false;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await reconcileLifecycle(directory, options);
    const entries = (await readdir(directory)).filter(name => name.endsWith('.json'));
    if (entries.length >= 64) throw new Error('outbox capacity');
    await durable(file, { report, state: 'prepared' }); stored = true;
  } catch { /* The tooling action remains independently authorized. */ }
  return async (successful = true) => {
    let result = { transitionId: report.transitionId, kind: report.kind, coverage: 'missing', reason: successful ? 'Local transition persistence unavailable' : 'Tooling operation failed or was partial' };
    if (stored && successful) {
      try {
        await durable(file, { report, state: 'completed' });
        result = await reportLifecycle(report, options);
        await durable(file, { report, state: 'completed', result });
      } catch { /* Retain the original transition for explicit reconciliation. */ }
    }
    console.log(JSON.stringify({ event: 'coordination-observation', ...result }));
    return result;
  };
}

// Reconcile at most two completed transitions per invocation; never replay an action.
// Core producer checkpoints retain successful IDs beyond feed retention.
export async function reconcileLifecycle(directory, options = {}) {
  const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort().slice(0, 64);
  let retried = 0;
  for (const name of files) {
    const file = path.join(directory, name);
    let row;
    try { row = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    if (row.result?.coverage === 'readback-confirmed') {
      if (files.length >= 32) await rm(file, { force: true });
      continue;
    }
    if (row.state !== 'completed' || retried >= 2) continue;
    retried++;
    const result = await reportLifecycle(row.report, options);
    await durable(file, { ...row, result });
  }
}

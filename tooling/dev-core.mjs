import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function coreRequest(endpoint, route, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/${route === 'healthz' ? route : `api/${route}`}`, {
    method, headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${result.error || response.status}`);
  return result;
}

export async function readCore(stateDirectory) {
  let endpoint;
  try { endpoint = JSON.parse(await readFile(path.join(stateDirectory, 'app/native.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string') {
    throw new Error('Invalid Core endpoint metadata. Start the installed app to recover it.');
  }
  try {
    const health = await coreRequest(endpoint, 'healthz');
    if (health.instance !== endpoint.instance || health.pid !== endpoint.pid || health.owner !== 'core') {
      throw new Error('Core endpoint identity changed. Retry development startup.');
    }
    return endpoint;
  } catch (error) {
    if (processAlive(endpoint.pid)) throw error;
    return null;
  }
}

// Keep the installed Core's other-client guard and wait for process exit, not just HTTP teardown.
export async function stopCore(endpoint, owner) {
  const clients = await coreRequest(endpoint, 'runtime/clients');
  if (clients.some(client => client.kind !== 'desktop')) {
    throw new Error('Other local CLI/MCP clients still use Core. Close those clients before starting or restarting dev.');
  }
  // Core validates the stable isolated identity before any Desktop quit request.
  const lease = { id: randomUUID(), kind: 'cli', pid: process.pid, ...(owner ? { isolatedOwner: owner } : {}) };
  await coreRequest(endpoint, 'runtime/lease', 'POST', lease);
  const heartbeat = setInterval(() => { void coreRequest(endpoint, 'runtime/lease', 'POST', lease).catch(() => {}); }, 2000);
  let closing = false;
  try {
    if (clients.some(client => client.kind === 'desktop')) {
      try { await coreRequest(endpoint, 'app/quit', 'POST', {}); }
      catch (error) {
        if ((await coreRequest(endpoint, 'runtime/clients')).some(client => client.kind === 'desktop')) throw error;
      }
    }
    const deadline = Date.now() + 30000;
    while ((await coreRequest(endpoint, 'runtime/clients')).some(client => client.kind === 'desktop')) {
      if (Date.now() >= deadline) throw new Error('Desktop did not quit. Core was left running.');
      await delay(100);
    }
    await coreRequest(endpoint, 'runtime/shutdown', 'POST', { id: owner?.id || lease.id });
    closing = true;
    clearInterval(heartbeat);
    while (processAlive(endpoint.pid)) {
      if (Date.now() >= deadline) throw new Error('Core shutdown timed out. Wait for cleanup before starting another instance.');
      await delay(100);
    }
  } finally {
    clearInterval(heartbeat);
    if (!closing) await coreRequest(endpoint, 'runtime/release', 'POST', { id: lease.id }).catch(() => {});
  }
}

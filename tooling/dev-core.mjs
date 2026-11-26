import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
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
  const desktop = clients.find(client => client.kind === 'desktop');
  const quitDesktop = async () => {
    if (!desktop) return;
    try { await coreRequest(endpoint, 'app/quit', 'POST', {}); }
    catch (error) { if (processAlive(desktop.pid) && processAlive(endpoint.pid)) throw error; }
  };
  const deadline = Date.now() + 30000;
  if (owner) {
    const lease = { id: randomUUID(), kind: 'cli', pid: process.pid, isolatedOwner: owner };
    await coreRequest(endpoint, 'runtime/lease', 'POST', lease);
    const heartbeat = setInterval(() => { void coreRequest(endpoint, 'runtime/lease', 'POST', lease).catch(() => {}); }, 2000);
    let closing = false;
    try {
      await quitDesktop();
      while ((await coreRequest(endpoint, 'runtime/clients')).some(client => client.kind === 'desktop')) {
        if (Date.now() >= deadline) throw new Error('Desktop did not quit. Core was left running.');
        await delay(100);
      }
      await coreRequest(endpoint, 'runtime/shutdown', 'POST', { id: owner.id });
      closing = true;
    } finally {
      clearInterval(heartbeat);
      if (!closing) await coreRequest(endpoint, 'runtime/release', 'POST', { id: lease.id }).catch(() => {});
    }
  } else await quitDesktop();
  // The installed Core drains and exits when its Desktop releases the last lease.
  while (processAlive(endpoint.pid)) {
    if (Date.now() >= deadline) throw new Error('Core shutdown timed out. Wait for cleanup before starting another instance.');
    await delay(100);
  }
}

// The front door lives independently of Core across development rebuilds.
// Use its authenticated private shutdown only when closing this isolated state.
export async function stopDevelopmentFrontDoor(stateDirectory) {
  const state = process.platform === 'win32' ? stateDirectory : await realpath(stateDirectory);
  if (path.basename(state) !== 'state' || !path.basename(path.dirname(state)).startsWith('arc-godev-home')) {
    throw new Error('Front-door shutdown requires an isolated development state.');
  }
  let owner;
  try { owner = JSON.parse(await readFile(path.join(state, 'app/front-door.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!processAlive(owner.pid)) return;
  if (typeof owner.token !== 'string' || owner.token.length < 32) throw new Error('Invalid development front-door metadata.');
  const digest = createHash('sha256').update(state).digest('hex').slice(0, 24);
  const endpoint = process.platform === 'win32'
    ? String.raw`\\.\pipe\arc-${digest}-front-door`
    : `/tmp/arc-ipc-${process.geteuid()}-${digest}/front-door.sock`;
  const payload = Buffer.from(JSON.stringify({ Stop: { token: owner.token } }));
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length);
  payload.copy(frame, 4);
  await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint, () => socket.write(frame));
    const chunks = [];
    let size = 0;
    socket.setTimeout(3000, () => socket.destroy(new Error('Development front-door shutdown timed out.')));
    socket.once('error', reject);
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > 4096) socket.destroy(new Error('Invalid development front-door shutdown response.'));
      else chunks.push(chunk);
    });
    socket.once('end', () => {
      try {
        const response = Buffer.concat(chunks);
        if (response.length < 4 || response.readUInt32BE() !== response.length - 4 ||
            JSON.parse(response.subarray(4)).Ok?.stopping !== true) throw new Error('Development front door did not acknowledge shutdown.');
        resolve();
      } catch (error) { reject(error); }
    });
  });
  const deadline = Date.now() + 10000;
  while (processAlive(owner.pid)) {
    if (Date.now() >= deadline) throw new Error('Development front door did not exit.');
    await delay(100);
  }
}

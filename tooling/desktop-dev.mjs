import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { requireMainCheckout } from './coding-lane.mjs';
import { developmentConfig, developmentEnvironment, developmentPort, desktopExecutable } from './dev-identity.mjs';
import { coreRequest, processAlive, readCore, stopCore, stopDevelopmentFrontDoor } from './dev-core.mjs';

const root = path.resolve(import.meta.dirname, '..');
if (process.argv.length !== 2) throw new Error('Usage: npm run dev.');
if (!process.env.ARC_MYGO_DEV_HOME) requireMainCheckout();
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Desktop development requires macOS or Windows.');
const home = path.resolve(process.env.ARC_MYGO_DEV_HOME || path.join(root, 'tmp/arc-godev-home'));
const env = developmentEnvironment(home);
const state = env.ARC_STATE_DIR;
if (process.env.ARC_STATE_DIR && process.env.ARC_STATE_DIR !== state) throw new Error('Desktop development uses the state inside ARC_MYGO_DEV_HOME.');
process.env.ARC_MYGO_DEV_HOME = home;
process.env.ARC_STATE_DIR = state;
const identity = developmentConfig(env);
const devUrl = identity.build.devUrl;
const coreOwner = env.ARC_DEV_INSTANCE_ID ? { instance: env.ARC_DEV_INSTANCE_ID, id: randomUUID() } : undefined;
const lockPath = path.join(state, 'app/dev.json');
let server, listener, running, generation, stopping = false, launched = false, scheduled, pending = true;
const watchers = [];

const spawnChild = (file, args, options) => {
  const child = spawn(file, args, { cwd: root, ...options });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  done.catch(() => {}); // The supervisor joins each child before exiting.
  return { child, done };
};

async function stopApp() {
  if (!running) return;
  try {
    const endpoint = await readCore(state);
    if (endpoint?.build === running.build) await stopCore(endpoint, coreOwner);
  } finally {
    running.child.stdin.end();
    const force = setTimeout(() => running?.child.kill('SIGTERM'), 10000);
    try { await running.done; } finally { clearTimeout(force); running = undefined; }
  }
}

async function buildGeneration() {
  const parent = await mkdtemp(path.join(home, 'build-'));
  try {
    const built = spawnChild(process.execPath, ['tooling/desktop-build.mjs', '--development', '--no-image', '--output', parent],
      { env: { ...process.env, ARC_DEV_INSTANCE_ID: env.ARC_DEV_INSTANCE_ID }, stdio: 'inherit' });
    if (await built.done || stopping) return;
    await stopApp();
    const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'windows-amd64';
    const packageRoot = path.join(parent, platform);
    const mac = process.platform === 'darwin';
    const app = path.join(packageRoot, `${identity.productName}.app/Contents`);
    const binary = mac ? path.join(app, 'MacOS', desktopExecutable) : path.join(packageRoot, desktopExecutable + '.exe');
    const core = mac ? path.join(app, 'Resources/bin/arc') : path.join(packageRoot, 'bin/arc.exe');
    const build = createHash('sha256').update(await readFile(core)).digest('hex');
    const desktop = spawnChild(binary, [], { env: { ...env, MYGO_DEV_URL: devUrl,
      ARC_DEV_SUPERVISED: '1', ARC_DEV_OWNER_ID: coreOwner?.id || '' }, stdio: ['pipe', 'inherit', 'inherit'] });
    running = { ...desktop, parent, build };
    launched = true;
    const deadline = Date.now() + 30000;
    while (!stopping && desktop.child.exitCode === null && desktop.child.signalCode === null && Date.now() < deadline) {
      const endpoint = await readCore(state);
      if (endpoint?.build === build) {
        try {
          await coreRequest(endpoint, 'app');
          console.log(`Development Core ready (PID ${endpoint.pid}). DEV WEB: ${devUrl}/`);
          break;
        } catch {}
      }
      await delay(100);
    }
    if (!stopping && (Date.now() >= deadline || desktop.child.exitCode !== null || desktop.child.signalCode !== null)) {
      throw new Error('Development Desktop did not attach to its Core. Inspect its output and the isolated core.log.');
    }
    void desktop.done.then(() => {
      if (running?.child === desktop.child && !generation) void shutdown();
    }, () => {});
  } finally {
    if (running?.parent !== parent) await rm(parent, { recursive: true, force: true });
  }
}

function schedule() {
  pending = true;
  clearTimeout(scheduled);
  scheduled = setTimeout(() => {
    if (generation || stopping) return;
    generation = (async () => {
      while (pending && !stopping) {
        pending = false;
        const old = running?.parent;
        try { await buildGeneration(); }
        finally {
          if (old && old !== running?.parent) await rm(old, { recursive: true, force: true });
        }
      }
    })().catch(error => {
      console.error(error.message);
      process.exitCode = 1;
      void shutdown();
    }).finally(() => { generation = undefined; });
  }, 250);
}

let shuttingDown;
function shutdown() {
  return shuttingDown ??= (async () => {
    stopping = true;
    clearTimeout(scheduled);
    for (const watcher of watchers) watcher.close();
    await generation;
    const parent = running?.parent;
    try { await stopApp(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    if (parent) await rm(parent, { recursive: true, force: true });
    try { if (launched && !await readCore(state)) await stopDevelopmentFrontDoor(state); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    await server?.close();
    if (listener?.listening) {
      const closed = new Promise(resolve => listener.close(resolve));
      listener.closeAllConnections();
      await closed;
    }
    await rm(lockPath, { force: true });
  })();
}

await mkdir(path.dirname(lockPath), { recursive: true });
async function claim() {
  const lock = await open(lockPath, 'wx');
  try { await lock.writeFile(JSON.stringify({ pid: process.pid })); }
  finally { await lock.close(); }
}
try { await claim(); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const existing = JSON.parse(await readFile(lockPath, 'utf8'));
  if (processAlive(existing.pid)) throw new Error('A development supervisor already owns this state directory.');
  await rm(lockPath);
  await claim();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });
try {
  if (await readCore(state)) throw new Error('The development state already has a Core owner. Stop it before starting dev.');
  // Own the HTTP listener so Vite cannot exit the supervisor before ARC
  // releases its Core and disposes of the development front door.
  listener = createHttpServer((request, response) => server.middlewares(request, response));
  server = await createServer({ configFile: path.join(root, 'vite.config.ts'), mode: 'arc-desktop-development',
    server: { middlewareMode: true, ws: { server: listener } } });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(developmentPort(env), '127.0.0.1', () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });
  for (const relative of ['cmd', 'internal', 'shared', 'skills']) {
    watchers.push(watch(path.join(root, relative), { recursive: true }, (_, file) => {
      if (!file || !file.toString().includes('browser_dist')) schedule();
    }));
  }
  const files = ['go.mod', 'go.sum', 'mygo.config.ts', 'cmd/arc-screen/main.swift', 'docs/reference/cli.md'];
  for (const directory of new Set(files.map(file => path.dirname(file)))) {
    watchers.push(watch(path.join(root, directory), (_, file) => {
      if (!file || files.includes(path.posix.join(directory, file.toString()))) schedule();
    }));
  }
  schedule();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await shutdown();
}

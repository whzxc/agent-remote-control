import { requireMainCheckout } from './coding-lane.mjs';
requireMainCheckout();
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cpSync, readFileSync, readdirSync, writeFileSync, watch } from 'node:fs';
import { open, mkdir, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
import { compileIcon, requireXcode } from './macos-icons.mjs';
import { stateDir } from './dev-state.mjs';
import { buildEnv } from './build-env.mjs';
import { coreRequest, processAlive, readCore, stopCore } from './dev-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 2) throw new Error('Usage: npm run dev. Use desktop:build for distribution builds.');
const env = { ...buildEnv(), ARC_STATE_DIR: stateDir };
const binary = path.join(root, 'target/debug', process.platform === 'win32' ? 'agent-remote-control-desktop.exe' : 'agent-remote-control-desktop');
const lockPath = path.join(stateDir, 'app/dev.json');
let server, app, build, restoreExecutable, currentInstance, developmentBuild;
let stopping = false, dirty = true, rebuilding = false, timer;
let rebuildPromise;
const watchers = [];

function child(command, args, options = {}) {
  const subprocess = spawn(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  subprocess.done = new Promise((resolve, reject) => {
    subprocess.once('error', reject);
    subprocess.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  return subprocess;
}
async function waitForCore() {
  const deadline = Date.now() + 30000;
  while (true) {
    const endpoint = await readCore(stateDir);
    if (endpoint) {
      if (endpoint.build !== developmentBuild) throw new Error('Another Core started during handoff. Stop it before retrying dev.');
      try { await coreRequest(endpoint, 'app'); return endpoint; }
      catch { /* Core can listen before Desktop finishes attaching its endpoint. */ }
    }
    if (app?.exitCode !== null && app?.exitCode !== undefined) throw new Error('Development Desktop exited before Core was ready.');
    if (Date.now() >= deadline) throw new Error('Development Core startup timed out. Inspect core.log in the state directory.');
    await delay(100);
  }
}
async function stopDevelopment() {
  const endpoint = await readCore(stateDir);
  if (endpoint && (endpoint.instance === currentInstance || app && endpoint.build === developmentBuild)) await stopCore(endpoint);
  if (app?.stdin && !app.stdin.destroyed) app.stdin.end();
  if (app) { await app.done; app = undefined; }
  currentInstance = undefined;
}
async function restoreInstalled() {
  if (!restoreExecutable || await readCore(stateDir)) return;
  const restored = spawn(restoreExecutable, [], { env, detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { restored.once('spawn', resolve); restored.once('error', reject); });
  restored.unref();
  const deadline = Date.now() + 30000;
  while (true) {
    const endpoint = await readCore(stateDir);
    if (endpoint) {
      try { if ((await coreRequest(endpoint, 'app')).executable === restoreExecutable) break; }
      catch { /* Wait for the restored Desktop to attach to its new Core. */ }
    }
    if (Date.now() >= deadline) throw new Error('The installed Desktop did not become ready. Start it manually and inspect core.log.');
    await delay(100);
  }
  console.log('The installed Desktop and Core are ready again.');
  restoreExecutable = undefined;
}
function rebuild() {
  return rebuildPromise ??= rebuildGeneration().finally(() => { rebuildPromise = undefined; });
}
async function rebuildGeneration() {
  if (rebuilding || stopping) return;
  rebuilding = true;
  try {
    while (dirty && !stopping) {
      dirty = false;
      console.log('Building development Core and Desktop. The current Core stays running until the build succeeds.');
      build = child(process.execPath, ['tooling/build-native.mjs', '--dev-desktop']);
      const result = await build.done;
      build = undefined;
      if (stopping) return;
      if (result !== 0) { console.error('Build failed. The current Core is unchanged. Save a source file to retry.'); continue; }
      if (dirty) continue;
      developmentBuild = createHash('sha256').update(await readFile(path.join(root, 'dist/native', process.platform === 'win32' ? 'arc.exe' : 'arc'))).digest('hex');
      if (currentInstance) await stopDevelopment();
      else {
        const installed = await readCore(stateDir);
        if (installed) {
          const clients = await coreRequest(installed, 'runtime/clients');
          if (clients.some(client => client.kind === 'desktop')) {
            const desktop = await coreRequest(installed, 'app');
            const relative = path.relative(path.join(root, 'target'), desktop.executable);
            if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) restoreExecutable = desktop.executable;
          }
          await stopCore(installed);
        }
      }
      if (stopping) return;
      if (process.platform === 'darwin') {
        app = child(process.execPath, ['tooling/macos-dev-app.mjs', binary], { stdio: ['pipe', 'inherit', 'inherit'] });
      } else {
        // Windows locks running executables. Keep Cargo's outputs separate from the running generation.
        const directory = path.join(root, 'target/dev-app', env.ARC_DEV_INSTANCE_ID || 'default');
        await mkdir(directory, { recursive: true });
        const executable = path.join(directory, path.basename(binary));
        cpSync(binary, executable);
        cpSync(path.join(root, 'dist/native'), path.join(directory, 'bin'), { recursive: true });
        cpSync(path.join(root, 'skills'), path.join(directory, 'skills'), { recursive: true });
        app = child(executable, [], { env: { ...env, ARC_DEV_SUPERVISED: '1' }, stdio: ['pipe', 'inherit', 'inherit'] });
      }
      const endpoint = await waitForCore();
      if (endpoint) {
        currentInstance = endpoint.instance;
        console.log(`Development Core ready (PID ${endpoint.pid}). DEV WEB: http://127.0.0.1:5187/`);
      }
      const launched = app;
      void launched.done.then(async () => {
        await rebuildPromise;
        if (app === launched && !stopping) void shutdown();
      });
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    void shutdown();
  } finally { rebuilding = false; }
}
let shutdownPromise;
function shutdown() {
  return shutdownPromise ??= (async () => {
    stopping = true;
    clearTimeout(timer);
    // Finish a launched generation's readiness handshake before stopping it.
    // Otherwise Desktop can spawn a Core just after shutdown inspected the owner.
    await rebuildPromise;
    try { await stopDevelopment(); }
    catch (error) {
      console.error(error.message);
      console.error('Development remains running. Close the other clients, then retry shutdown.');
      stopping = false; shutdownPromise = undefined;
      return;
    }
    for (const watcher of watchers) watcher.close();
    try { await restoreInstalled(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    await server?.close();
    await rm(lockPath, { force: true });
  })();
}

try {
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const lock = await open(lockPath, 'wx');
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(lockPath, 'utf8'));
    if (processAlive(owner.pid)) throw new Error('A development supervisor already owns this state directory. Stop it before starting dev again.');
    await rm(lockPath);
    const lock = await open(lockPath, 'wx');
    await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  }
} catch (error) { console.error(error.message); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(); });

try {
  if (spawnSync('cargo', ['--version'], { env, stdio: 'ignore' }).status !== 0) {
    const cargo = spawnSync('rustup', ['which', 'cargo'], { env, encoding: 'utf8' });
    if (cargo.status !== 0) throw new Error('Install the Rust stable toolchain first. Ensure cargo or rustup is on PATH.');
    env.PATH = path.dirname(cargo.stdout.trim()) + path.delimiter + (env.PATH || '');
  }
  if (process.platform === 'darwin') {
    requireXcode(env);
    const output = path.join(root, 'target/dev-icon');
    const source = path.join(output, 'Icon.icon');
    cpSync(path.join(root, 'desktop/icons/AgentRemoteControl.icon'), source, { recursive: true });
    const document = JSON.parse(readFileSync(path.join(source, 'icon.json'), 'utf8'));
    document['fill-specializations'][0].value = { solid: 'srgb:0.87843,0.94902,0.99216,1.00000' };
    writeFileSync(path.join(source, 'icon.json'), JSON.stringify(document, null, 2) + '\n');
    compileIcon(source, path.join(output, 'Resources'), env);
  }
  // Reuse an existing dev:ui server only for this checkout and state directory.
  let existing;
  try { existing = await (await fetch('http://127.0.0.1:5187/__arc_dev', { signal: AbortSignal.timeout(1000) })).json(); }
  catch { /* Binding the strict port reports incompatible listeners. */ }
  if (existing && (existing.project !== root || existing.stateDirectory !== stateDir)) throw new Error('Port 5187 belongs to another checkout or state directory. Stop its DEV WEB before starting dev.');
  if (!existing) { server = await createServer({ configFile: path.join(root, 'vite.config.ts') }); await server.listen(); }
  const sourceDirectories = ['native/src', 'desktop/src', 'skills'];
  const sourceFiles = ['Cargo.toml', 'Cargo.lock', 'native/Cargo.toml', 'native/build.rs', 'native/screen/main.swift', 'desktop/Cargo.toml', 'desktop/build.rs', 'desktop/tauri.conf.json', 'desktop/tauri.dev.conf.json', 'desktop/tauri.windows.conf.json', 'tooling/build-version.rs', 'tooling/build-native.mjs', 'tooling/macos-dev-app.mjs', 'tooling/dev-identity.mjs', 'docs/reference/cli.md'];
  function fingerprint() {
    const digest = createHash('sha256');
    function include(file) {
      try { digest.update(file).update(readFileSync(path.join(root, file))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    function directory(relative) {
      for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(relative, entry.name);
        if (entry.isDirectory()) directory(file);
        else if (entry.isFile()) include(file);
      }
    }
    sourceDirectories.forEach(directory); sourceFiles.forEach(include);
    return digest.digest('hex');
  }
  let inputs = fingerprint();
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const next = fingerprint();
        if (next === inputs || stopping) return;
        inputs = next; dirty = true; void rebuild();
      } catch (error) { console.error(`Cannot read development inputs: ${error.message}. Save again to retry.`); }
    }, 250);
  };
  for (const directory of sourceDirectories) watchers.push(watch(path.join(root, directory), { recursive: true }, changed));
  for (const directory of new Set(sourceFiles.map(file => path.dirname(file)))) {
    watchers.push(watch(path.join(root, directory), (event, filename) => {
      if (!filename || sourceFiles.includes(path.join(directory, filename.toString()).replaceAll('\\', '/'))) changed();
    }));
  }
  await rebuild();
} catch (error) { console.error(error.message); process.exitCode = 1; await shutdown(); }

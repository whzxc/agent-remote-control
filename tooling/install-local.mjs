import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { backupRoot, pruneInstallBackups } from './install-backups.mjs';
import path from 'node:path';
import { requireMainCheckout } from './coding-lane.mjs';
import { developmentConfig, developmentEnvironment, desktopIdentifier } from './dev-identity.mjs';

const [candidateArg, option, testDestination, ...extra] = process.argv.slice(2);
const testInstall = option === '--test-destination' && testDestination && !extra.length;
if (process.platform !== 'darwin' || !candidateArg || (option && !testInstall)) {
  throw new Error('Usage on macOS: npm run desktop:install -- /absolute/candidate.app [--test-destination /absolute/arc-godev-home/Name.app]');
}
if (!testInstall) requireMainCheckout();

const candidate = path.resolve(candidateArg);
const destination = testInstall ? path.resolve(testDestination) : '/Applications/Agent Remote Control.app';
const targetHome = realpathSync(path.dirname(destination));
const target = path.join(targetHome, path.basename(destination));
if (!target.endsWith('.app') || !candidate.endsWith('.app') || realpathSync(candidate) === target) throw new Error('Choose a separate candidate .app bundle.');
if (testInstall && !path.isAbsolute(testDestination)) throw new Error('Use an absolute test destination.');
const env = testInstall ? developmentEnvironment(targetHome) : process.env;
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30_000, env });
const identifier = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(candidate, 'Contents/Info.plist')]).trim();
if (testInstall ? identifier !== developmentConfig(env).identifier : identifier !== desktopIdentifier) {
  throw new Error('Use a package matching the selected installation identity.');
}
if (testInstall && existsSync(target)) {
  const existing = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(target, 'Contents/Info.plist')]).trim();
  if (existing !== identifier || realpathSync(target) !== target) throw new Error('The test destination already contains a different application.');
}
run(process.execPath, [path.join(import.meta.dirname, 'check-package.mjs'), candidate, ...(testInstall ? ['--adhoc'] : [])]);
const backups = testInstall ? path.join(targetHome, 'install-backups') : backupRoot;
const installed = existsSync(target);
const cli = path.join(target, 'Contents/Resources/bin/arc');
const read = (...args) => JSON.parse(run(cli, ['cli', ...args])).result;
const desktop = testInstall ? undefined : read('app', 'status');
const core = testInstall ? undefined : read('call', 'health');
if (!testInstall && !desktop.executable.startsWith(target + '/Contents/')) throw new Error('The running Desktop must be the installed target.');
mkdirSync(backups, { recursive: true });
const directory = mkdtempSync(path.join(backups, '.pending-'));
const archive = path.join(directory, 'previous-app.zip');
if (installed) {
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', target, archive]);
  console.log(`Backup: ${archive}`);
}
const staging = mkdtempSync(path.join(targetHome, '.arc-install-'));
const staged = path.join(staging, 'Agent Remote Control.app');
run('/usr/bin/ditto', [candidate, staged]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
// The candidate holds a kernel lock until replacement or rollback is complete.
let preparation;
let preparedExit;
const release = async () => {
  if (!preparation) return;
  preparation.stdin.end();
  await preparedExit;
  preparation = undefined;
};
const previous = path.join(directory, 'previous.bundle');
try {
  if (!testInstall) read('app', 'quit');
  const pids = testInstall ? [] : [desktop.pid, core.pid];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const deadline = Date.now() + 10_000;
  while (pids.some(alive)) {
    if (Date.now() > deadline) throw new Error(`Installed processes did not exit. Candidate retained at ${staged}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  preparation = spawn(path.join(staged, 'Contents/Resources/bin/arc'), ['front-door-prepare', '--hold'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  preparedExit = new Promise(resolve => preparation.once('close', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Front-door preparation timed out.')), 35_000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    preparation.once('error', finish);
    preparation.once('exit', code => finish(new Error(`Front-door preparation exited (${code}).`)));
    let output = '';
    preparation.stdout.on('data', bytes => {
      output += bytes;
      if (output.includes('ready\n')) finish();
    });
  });
  if (installed) renameSync(target, previous);
  try { renameSync(staged, target); }
  catch (error) { if (installed) renameSync(previous, target); throw error; }
  await release();
  if (!testInstall) {
    run('/usr/bin/open', ['-g', target]);
    const healthDeadline = Date.now() + 30_000;
    while (true) {
      let ready = false;
      try { ready = read('call', 'health')?.state === 'ready'; } catch { /* Wait for the installed Core. */ }
      if (ready) break;
      if (Date.now() > healthDeadline) throw new Error('Installed Core did not become ready; retain the pending backup for recovery.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  console.log(`Installed: ${target}`);
  rmSync(staging, { recursive: true });
  if (installed) {
    rmSync(previous, { recursive: true });
    const completed = path.join(backups, `installed-${Date.now()}`);
    renameSync(directory, completed);
    console.log(`Backup retained: ${path.join(completed, 'previous-app.zip')}`);
  } else rmSync(directory, { recursive: true });
  if (!testInstall) console.log(JSON.stringify(pruneInstallBackups()));
} catch (error) {
  await release();
  // The old bundle remains runnable on prepare/replace failure. A fresh Core
  // ensures its own front door even when an incompatible one was already stopped.
  if (!testInstall) run('/usr/bin/open', ['-g', target]);
  throw error;
}

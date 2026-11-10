import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { requireMainCheckout } from './coding-lane.mjs';
requireMainCheckout();

if (process.platform !== 'darwin' || process.argv.length !== 3) throw new Error('Usage on macOS: npm run desktop:install -- /absolute/candidate.app');
const candidate = path.resolve(process.argv[2]);
const target = '/Applications/Agent Remote Control.app';
if (candidate === target || !candidate.endsWith('.app')) throw new Error('Choose a separate candidate .app bundle.');
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 30_000 });
run(process.execPath, [path.join(import.meta.dirname, 'check-package.mjs'), candidate]);
const cli = path.join(target, 'Contents/Resources/bin/arc');
const read = (...args) => JSON.parse(run(cli, ['cli', ...args])).result;
const desktop = read('app', 'status'), core = read('call', 'health');
if (!desktop.executable.startsWith(target + '/Contents/')) throw new Error('The running Desktop must be the installed target.');
const backup = path.join(homedir(), '.local/state/arc-maintenance');
run('/bin/mkdir', ['-p', backup]);
const directory = mkdtempSync(path.join(backup, 'local-install-'));
const archive = path.join(directory, 'previous-app.zip');
run('/usr/bin/ditto', ['-c', '-k', '--keepParent', target, archive]);
console.log(`Backup: ${archive}`);
const staging = mkdtempSync('/Applications/.arc-install-');
const staged = path.join(staging, 'Agent Remote Control.app');
run('/usr/bin/ditto', [candidate, staged]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
run(path.join(staged, 'Contents/Resources/bin/arc'), ['front-door-prepare']);
read('app', 'quit');
for (const pid of [desktop.pid, core.pid]) {
  try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const deadline = Date.now() + 10_000;
while ([desktop.pid, core.pid].some(alive)) {
  if (Date.now() > deadline) throw new Error(`Installed processes did not exit. Candidate retained at ${staged}`);
  await new Promise(resolve => setTimeout(resolve, 100));
}
const previous = path.join(directory, 'previous.bundle');
renameSync(target, previous);
try { renameSync(staged, target); }
catch (error) { renameSync(previous, target); throw error; }
run('/usr/bin/open', ['-g', target]);
console.log(`Installed: ${target}`);
rmSync(staging, { recursive: true });
rmSync(previous, { recursive: true });

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneMarker } from './coding-lane.mjs';
import { beginLifecycle } from './coordination-report.mjs';
import { dependencyEnv } from './release-support.mjs';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const main = git(checkout, ['worktree', 'list', '--porcelain', '-z']).split('\0')[0].slice('worktree '.length);
const branch = name => `wt/${name}`;
const run = (cwd, command, args) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const metadataPath = directory => path.join(git(directory, ['rev-parse', '--absolute-git-dir']), 'arc-lane.json');
const metadata = directory => JSON.parse(readFileSync(metadataPath(directory), 'utf8'));
const dirty = directory => !!git(directory, ['status', '--porcelain']);

function worktrees() {
  return git(main, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(record => {
    const fields = Object.fromEntries(record.split('\0').filter(Boolean).map(field => {
      const space = field.indexOf(' ');
      return space < 0 ? [field, true] : [field.slice(0, space), field.slice(space + 1)];
    }));
    return { directory: fields.worktree, branch: fields.branch?.replace(/^refs\/heads\//, '') };
  });
}
function lane(name) {
  const found = worktrees().find(row => row.branch === branch(name));
  if (!found) throw new Error(`Lane ${name} was not found. Run npm run wt -- list.`);
  const data = metadata(found.directory);
  if (data.main !== main || data.name !== name) throw new Error('This worktree is not an ARC coding lane.');
  return { ...found, ...data };
}
function mainOnMain() {
  if (git(main, ['branch', '--show-current']) !== 'main') throw new Error(`Check out main in ${main} first.`);
}

// Node dependencies are cloned or installed independently per checkout.
function clone(source, destination) {
  const args = process.platform === 'darwin' ? ['-c', '-R', source, destination]
    : process.platform === 'linux' ? ['--reflink=always', '-R', source, destination] : null;
  if (args && spawnSync('cp', args, { stdio: 'ignore' }).status === 0) return true;
  rmSync(destination, { recursive: true, force: true });
  return false;
}
function dependencies(directory, relative = '') {
  const source = path.join(main, relative), destination = path.join(directory, relative);
  if (!existsSync(path.join(destination, 'package-lock.json'))) return;
  const modules = path.join(source, 'node_modules');
  const lockMatches = existsSync(path.join(source, 'package-lock.json'))
    && readFileSync(path.join(source, 'package-lock.json')).equals(readFileSync(path.join(destination, 'package-lock.json')));
  if (lockMatches && existsSync(modules) && clone(realpathSync(modules), path.join(destination, 'node_modules'))) {
    console.log(`Cloned ${relative || '.'}/node_modules (copy-on-write).`);
    return;
  }
  execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm ci'] : ['ci'],
    { cwd: destination, env: dependencyEnv(process.env), stdio: 'inherit' });
}
function create(name) {
  mainOnMain();
  const base = path.resolve(process.env.ARC_WORKTREE_ROOT || path.join(path.dirname(main), `${path.basename(main)}.wt`));
  const directory = path.join(base, name);
  const relative = path.relative(main, directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('ARC_WORKTREE_ROOT must be outside the repository.');
  mkdirSync(base, { recursive: true });
  run(main, 'git', ['worktree', 'add', '-b', branch(name), directory, 'main']);
  writeFileSync(metadataPath(directory), JSON.stringify({ name, main }) + '\n');
  const message = `Coding lanes support editing, building, type-checking and committing only. Run apps, installs and acceptance serially in the main checkout: ${main}\n`;
  writeFileSync(path.join(directory, laneMarker), message);
  try {
    dependencies(directory);
    dependencies(directory, 'relay-worker');
    // Go shares GOCACHE and GOMODCACHE across checkouts, with lane-local artifacts.
    run(directory, process.execPath, ['tooling/prepare-desktop.mjs']);
    console.log(`Lane ready: ${directory}\nRun npm run check and npm run check:native there.`);
  } catch (error) {
    throw new Error(`Lane preparation failed: ${error.message}\nFix and retry the failed step in ${directory}, or run npm run wt -- remove ${name} --force.`);
  }
}
function size(directory) {
  if (!existsSync(directory)) return 0;
  const seen = new Set();
  function walk(file) {
    try {
      const info = lstatSync(file);
      if (info.isSymbolicLink()) return 0;
      if (info.ino) {
        const key = `${info.dev}:${info.ino}`;
        if (seen.has(key)) return 0;
        seen.add(key);
      }
      const bytes = process.platform !== 'win32' && typeof info.blocks === 'number' ? info.blocks * 512 : info.size;
      return bytes + (info.isDirectory() ? readdirSync(file).reduce((sum, child) => sum + walk(path.join(file, child)), 0) : 0);
    } catch (error) {
      if (error.code === 'ENOENT') return 0; // A concurrent build may remove an output.
      throw error;
    }
  }
  // Follow only the requested root link, never links inside dependency/cache trees.
  return walk(realpathSync(directory));
}
function list() {
  const rows = worktrees().filter(row => row.branch?.startsWith('wt/') && existsSync(metadataPath(row.directory))).map(row => {
    const [behind, ahead] = git(row.directory, ['rev-list', '--left-right', '--count', `main...${row.branch}`]).split(/\s+/).map(Number);
    const bytes = ['node_modules', 'relay-worker/node_modules', 'dist'].reduce((sum, relative) => sum + size(path.join(row.directory, relative)), 0);
    return { branch: row.branch, ahead, behind, dirty: dirty(row.directory), diskBytes: bytes, path: row.directory };
  });
  console.log(JSON.stringify(rows, null, 2));
}
function land(name) {
  mainOnMain();
  const { directory } = lane(name);
  if (dirty(directory)) throw new Error('Commit your lane changes before landing.');
  const checkMain = () => {
    const incoming = new Set(git(main, ['log', '--format=', '--name-only', '--no-renames', '-z', `main..${branch(name)}`]).split('\0').filter(Boolean));
    const changed = new Set([
      ...git(main, ['diff', '--name-only', '--no-renames', '-z']).split('\0'),
      ...git(main, ['diff', '--cached', '--name-only', '--no-renames', '-z']).split('\0'),
      ...git(main, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
    ]);
    const overlap = [...changed].filter(file => incoming.has(file)).sort();
    if (overlap.length) throw new Error(`Cannot land ${branch(name)}: main has uncommitted changes in incoming files:\n${overlap.join('\n')}\nHave the owner resolve these changes, then retry.`);
  };
  checkMain();
  try { run(directory, 'git', ['rebase', 'main']); }
  catch (error) {
    const conflicts = git(directory, ['diff', '--name-only', '--diff-filter=U']);
    throw new Error(`Rebase stopped in ${directory}. Resolve and git rebase --continue, or git rebase --abort.\n${conflicts || error.message}`);
  }
  checkMain();
  run(main, 'git', ['merge', '--ff-only', branch(name)]);
  console.log(`Landed ${branch(name)}. Run acceptance serially in ${main}. Nothing was pushed.`);
}
function remove(name, force) {
  const { directory, target } = lane(name);
  if (!force && spawnSync('git', ['merge-base', '--is-ancestor', branch(name), 'main'], { cwd: main }).status !== 0) {
    throw new Error(`Lane ${name} is unmerged. Land it first, or use --force to discard it.`);
  }
  if (path.resolve(process.cwd()) === directory || path.resolve(process.cwd()).startsWith(directory + path.sep)) throw new Error(`Run removal from ${main}.`);
  run(main, 'git', ['worktree', 'remove', ...(force ? ['--force'] : []), directory]);
  // Older lanes own a private cache target recorded at creation.
  if (target) rmSync(target, { recursive: true, force: true });
  run(main, 'git', ['branch', force ? '-D' : '-d', branch(name)]);
}

const [command, name, ...options] = process.argv.slice(2);
try {
  if (command === 'list' && !name) list();
  else if (['create', 'land', 'remove'].includes(command) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name || '')
    && options.every(option => command === 'remove' && option === '--force')) {
    const finish = await beginLifecycle(path.join(git(main, ['rev-parse', '--absolute-git-dir']), 'arc-coordination'), {
      kind: { create: 'lane.created', land: 'lane.landed', remove: 'lane.removed' }[command], repository: main, lane: name,
    });
    try { ({ create, land, remove })[command](name, options.includes('--force')); }
    catch (error) { await finish(false); throw error; }
    await finish();
  } else if (['--help', '-h'].includes(command)) {
    console.log('Usage: npm run wt -- <create|land|remove> <name> [--force for remove]\n       npm run wt -- list\nARC_WORKTREE_ROOT overrides the lane parent directory.');
  } else throw new Error('Usage: npm run wt -- <create|list|land|remove> <name> [--force for remove]');
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}

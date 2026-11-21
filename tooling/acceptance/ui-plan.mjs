import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Cover startup, task panels, approvals, topology controls, narrow focus and updates.
export const smokeScenarios = [
  'idle', 'agent-panel-short', 'task-states', 'approval', 'studio-connections',
  'portrait-topology-accounts', 'task-timeline-scroll', 'p3-welcome', 'updates-settings', 'relay-hosting-light',
];

export function selectScenarios(files, { all = false, filter } = {}) {
  if (all && filter) throw new Error('Choose --all or --scenario, not both.');
  const patterns = filter ? filter.split(',') : all ? ['*'] : smokeScenarios;
  const selected = new Set();
  for (const pattern of patterns) {
    const matches = files.filter(file => pattern.endsWith('*')
      ? file.startsWith(pattern.slice(0, -1)) : file === `${pattern}.json`);
    if (!pattern || !matches.length) throw new Error(`No acceptance scenario matches ${JSON.stringify(pattern)}.`);
    for (const file of matches) selected.add(file);
  }
  return [...selected].sort();
}

export function caseKey({ name, theme, width, height }) {
  return `${name}@${theme}-${width}x${height}`;
}

export function reusableCases(cache, fingerprint, fresh = false) {
  return new Set(!fresh && cache?.fingerprint === fingerprint ? cache.passed : []);
}

export async function uiFingerprint(root, runtime) {
  // Hash actual files, including uncommitted edits, without tying passes to commit IDs.
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
    'ui', 'tooling/acceptance', 'tooling/version.mjs', 'tooling/dev-state.mjs',
    'tooling/dev-identity.mjs', 'design/tokens.css', 'native/src/ingress/config.json',
    'native/src/agents/builtins.json', 'vite.config.ts', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8' });
  const hash = createHash('sha256').update(JSON.stringify(runtime));
  for (const name of [...new Set(names.split('\0').filter(Boolean))].sort()) {
    hash.update(name).update('\0');
    try { hash.update(await readFile(`${root}/${name}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('deleted'); }
    hash.update('\0');
  }
  return hash.digest('hex');
}

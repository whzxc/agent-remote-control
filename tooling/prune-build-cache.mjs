import { execFileSync } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { enterHeavyBuild } from './heavy-build.mjs';

const { values } = parseArgs({ options: {
  'apply': { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  'max-gib': { type: 'string', default: '30' },
} });
if (values.apply && values['dry-run']) throw new Error('Choose --apply or --dry-run.');
const limit = Number(values['max-gib']) * (1024 ** 3);
if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('--max-gib must be positive.');
if (values.apply) enterHeavyBuild();
const directory = execFileSync('go', ['env', 'GOCACHE'], { encoding: 'utf8' }).trim();
if (!path.isAbsolute(directory)) throw new Error('Go build cache is disabled or its location is invalid.');
let bytes = 0;
const buckets = await readdir(directory).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
for (const bucket of buckets.filter(name => /^[0-9a-f]{2}$/.test(name))) {
  const dir = path.join(directory, bucket);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f]{64}-[ad]$/.test(entry.name)) continue;
    try { bytes += (await stat(path.join(dir, entry.name))).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const cleared = Boolean(values.apply && bytes > limit);
if (cleared) execFileSync('go', ['clean', '-cache', '-testcache'], { stdio: 'inherit' });
console.log(JSON.stringify({ directory, bytes, limit, overBudget: bytes > limit, cleared }));

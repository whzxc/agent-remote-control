import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertionSignature, parseTests, testFiles } from './test-cases.mjs';

const args = process.argv.slice(2);
const since = args.find(arg => arg.startsWith('--since='))?.slice(8) ?? '90 days ago';
const limit = Number(args.find(arg => arg.startsWith('--limit='))?.slice(8) ?? 20);
if (!Number.isInteger(limit) || limit < 1 || args.some(arg => !/^--(?:since=|limit=|json$)/.test(arg)))
  throw new Error('Usage: node tooling/test-churn.mjs [--since=DATE] [--limit=N] [--json]');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
const cache = new Map();
function read(revision, file) {
  const key = `${revision}:${file}`;
  if (!cache.has(key)) {
    try { cache.set(key, git('show', key)); } catch { cache.set(key, ''); }
  }
  return cache.get(key);
}
const rows = new Map();
for (const file of testFiles().filter(file => !file.endsWith('.go'))) for (const c of parseTests(file, readFileSync(file, 'utf8')).cases)
  rows.set(`${file}\0${c.name}`, { file, test: c.name, edits: 0, fixes: 0, alignments: [], commits: [] });
const isProduct = file => /^(?:ui\/.*\.[jt]sx?|relay-worker\/src\/.*\.[jt]s)$/.test(file)
  || (/^(?:cmd|internal|shared)\/.*\.go$/.test(file) && !file.endsWith('_test.go'));
const assertions = assertionSignature;
function matching(name, candidates, key) {
  const exact = candidates.find(c => key(c) === name); if (exact) return exact;
  const words = value => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const wanted = words(name);
  const ranked = candidates.map(c => {
    const other = words(key(c)), common = [...wanted].filter(w => other.has(w)).length;
    return { c, score: common / new Set([...wanted, ...other]).size };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 0.65 && ranked[0].score - (ranked[1]?.score ?? 0) > 0.1 ? ranked[0].c : undefined;
}
const history = git('log', '--no-merges', `--since=${since}`, '--format=%H%x09%P%x09%s').trim().split('\n').filter(Boolean);
for (const entry of history) {
  const [sha, parents, subject] = entry.split('\t'), parent = parents.split(' ')[0];
  if (!parent) continue;
  const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', sha).trim().split('\n');
  const affected = files.filter(file => [...rows.values()].some(row => row.file === file));
  if (!affected.length) continue;
  const productChanged = files.filter(isProduct).some(file => read(parent, file) !== read(sha, file));
  const fix = /^fix(?:\([^)]*\))?:/.test(subject) && productChanged;
  const alignment = /^test(?:\([^)]*\))?:/.test(subject) && !productChanged;
  for (const file of affected) {
    const old = new Map(parseTests(file, read(parent, file)).cases.map(c => [c.name, c]));
    for (const c of parseTests(file, read(sha, file)).cases) {
      const row = matching(c.name, [...rows.values()].filter(r => r.file === file), r => r.test);
      const previous = matching(c.name, [...old.values()], c => c.name);
      // Initial creation is coverage, not maintenance churn. Match only unambiguous similar renames.
      if (!row || !previous || row.commits.includes(sha.slice(0, 7)) || assertions(c) === assertions(previous)) continue;
      row.edits++; if (fix) row.fixes++;
      row.commits.push(sha.slice(0, 7));
      if (alignment) row.alignments.push(sha.slice(0, 7));
    }
  }
}
const ranked = [...rows.values()].filter(r => r.edits).map(r => ({ ...r, score: r.edits - r.fixes + r.alignments.length * 3 }))
  .sort((a, b) => b.score - a.score || b.edits - a.edits || a.test.localeCompare(b.test)).slice(0, limit);
if (args.includes('--json')) console.log(JSON.stringify({ since, cases: rows.size, candidates: ranked }, null, 2));
else {
  console.log(`Assertion churn since ${since}; fix requires product changes in the same commit. Signals are candidates, not automatic deletion decisions.`);
  for (const r of ranked) console.log(`${r.score}\t${r.edits} edits\t${r.fixes} fixes\t${r.alignments.length ? 'STRONG test-only: ' + r.alignments.join(',') : '-'}\t${r.file} :: ${r.test}`);
}

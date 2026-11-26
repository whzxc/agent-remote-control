import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkGoTestMap } from './check-go-test-map.mjs';
import { repositoryGoFiles } from './go-test.mjs';
import { parseTests, ts } from './test-cases.mjs';
import { nativeTestFiles } from './test-suites.mjs';

const rustRoots = ['native/src', 'desktop/src', 'tests/fixture/src'];
const segments = new Set(['S0', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);

export function nativeCaseInventory(file, parsed = parseTests(file, readFileSync(file, 'utf8'))) {
  return parsed.cases.flatMap(test => {
    const title = test.node.arguments[0];
    if (ts.isStringLiteralLike(title)) return [{ name: title.text, line: test.line }];
    for (let parent = test.node.parent; parent; parent = parent.parent) {
      if (!ts.isForOfStatement(parent)) continue;
      const binding = parent.initializer.declarations?.[0]?.name;
      if (ts.isTemplateExpression(title) && title.templateSpans.length === 1 &&
          ts.isArrayLiteralExpression(parent.expression) && parent.expression.elements.every(ts.isStringLiteralLike) &&
          binding && title.templateSpans[0].expression.getText() === binding.getText()) {
        const span = title.templateSpans[0];
        return parent.expression.elements.map(value => ({
          name: title.head.text + value.text + span.literal.text, line: test.line,
        }));
      }
      break;
    }
    throw new Error(`Cannot enumerate native test ${file}:${test.line}`);
  });
}

function checkNativeTests(ledger, inventory, failures) {
  const incomplete = new Set();
  const totals = { passed: 0, failed: 0, blocked: 0 };
  const tests = new Set(nativeTestFiles());
  for (const file of tests) {
    const cases = ledger.nativeTests[file]?.cases;
    if (!cases || typeof cases !== 'object' || Array.isArray(cases)) {
      failures.push(`Go port ledger is missing native case results for ${file}.`);
      continue;
    }
    const expected = new Set(nativeCaseInventory(file, inventory?.get(file)).map(test => test.name));
    const counts = { passed: 0, failed: 0, blocked: 0 };
    for (const name of expected) {
      if (!Object.hasOwn(cases, name)) failures.push(`Go port ledger is missing ${file}#${name}.`);
    }
    for (const [name, entry] of Object.entries(cases)) {
      const label = `${file}#${name}`;
      if (!expected.has(name)) failures.push(`Go port ledger has a stale native case ${label}.`);
      if (!Object.hasOwn(counts, entry?.result) || (entry.result !== 'passed' &&
          (!segments.has(entry.owner) || typeof entry.reason !== 'string' || !entry.reason.trim()))) {
        failures.push(`Invalid native case result for ${label}.`);
        continue;
      }
      counts[entry.result]++;
      if (!Array.isArray(entry.rust) || !entry.rust.length || new Set(entry.rust).size !== entry.rust.length) {
        failures.push(`Native case ${label} must identify its Rust coverage.`);
        continue;
      }
      for (const rust of entry.rust) {
        if (!Object.hasOwn(ledger.files, rust)) failures.push(`Native case ${label} covers unknown Rust source ${rust}.`);
        if (entry.result !== 'passed') incomplete.add(rust);
      }
    }
    const result = counts.failed ? 'failed' : counts.blocked ? 'blocked' : 'passed';
    if (ledger.nativeTests[file].result !== result) failures.push(`Incorrect native suite result for ${file}.`);
    for (const [status, count] of Object.entries(counts)) totals[status] += count;
  }
  for (const file of Object.keys(ledger.nativeTests)) {
    if (!tests.has(file)) failures.push(`Go port ledger has a stale native test ${file}.`);
  }
  return { incomplete, totals };
}

export function checkGoPort(inventory, options = {}) {
  const ledger = JSON.parse(readFileSync('tooling/go-port.json', 'utf8'));
  const failures = [];
  const rust = new Set(rustRoots.flatMap(root => existsSync(root)
    ? readdirSync(root, { recursive: true }).filter(file => file.endsWith('.rs')).map(file => `${root}/${file.replaceAll('\\', '/')}`)
    : []));
  const statuses = ['pending', 'ported', 'verified'];
  for (const file of rust) {
    if (!Object.hasOwn(ledger.files, file)) failures.push(`Go port ledger is missing ${file}.`);
  }
  for (const [file, entry] of Object.entries(ledger.files)) {
    if (rust.size && !rust.has(file)) failures.push(`Go port ledger has a stale source ${file}.`);
    if (!segments.has(entry.segment) || !statuses.includes(entry.status) || !Array.isArray(entry.go)) {
      failures.push(`Invalid Go port ledger entry for ${file}.`);
      continue;
    }
    if (entry.status !== 'pending' && !entry.go.length) failures.push(`Go port ledger has no Go source for ${file}.`);
    for (const mapped of entry.go) {
      if (!mapped.endsWith('.go') || !existsSync(mapped)) failures.push(`Missing Go port of ${file} at ${mapped}.`);
    }
    if (!Object.hasOwn(entry, 'remaining')) continue;
    if (!Array.isArray(entry.remaining)) {
      failures.push(`Go port ledger remaining work for ${file} must be a list.`);
      continue;
    }
    for (const work of entry.remaining) {
      if (!segments.has(work?.owner)) failures.push(`Unknown Go port owner ${work?.owner} for ${file}.`);
      if (!Array.isArray(work?.items) || !work.items.length || work.items.some(item => typeof item !== 'string' || !item.trim())) {
        failures.push(`Go port ledger remaining work for ${file} must list nonempty items.`);
      }
      if (work?.owner === entry.segment && entry.status !== 'pending') {
        failures.push(`Go port ledger marks ${file} as ${entry.status} with remaining ${entry.segment} work.`);
      }
    }
  }
  const recordedCommits = new Set(ledger.postBaselineRustCommits);
  const portedCommits = ledger.portedPostBaselineRustCommits ?? {};
  for (const [sha, evidence] of Object.entries(portedCommits)) {
    if (!recordedCommits.has(sha) || typeof evidence !== 'string' || !evidence.trim()) {
      failures.push(`Invalid post-baseline Rust port entry for ${sha}.`);
    }
  }
  const native = checkNativeTests(ledger, inventory, failures);
  const testMap = checkGoTestMap(ledger, inventory, options);
  for (const [file, entry] of Object.entries(ledger.files)) {
    if (entry.status !== 'verified') continue;
    if (entry.remaining?.length) failures.push(`Verified Go port has remaining work for ${file}.`);
    if (testMap.incompleteFiles.has(file)) failures.push(`Verified Go port has incomplete unit mappings for ${file}.`);
    if (native.incomplete.has(file)) failures.push(`Verified Go port has nonpassing native cases for ${file}.`);
  }
  let cutover;
  if (options.cutover || !rust.size) {
    const commits = execFileSync('git', ['log', '--format=%H', '--full-history', '--simplify-merges',
      `${ledger.baseline}..HEAD`, '--', '*.rs'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    const unported = [...new Set([...recordedCommits, ...commits])].filter(sha => !Object.hasOwn(portedCommits, sha));
    cutover = {
      unverifiedRustFiles: [...new Set([...rust, ...Object.keys(ledger.files)])]
        .filter(file => ledger.files[file]?.status !== 'verified').length,
      unacceptedUnitMappings: testMap.unacceptedMappings,
      failedNativeCases: native.totals.failed,
      blockedNativeCases: native.totals.blocked,
      unportedRustCommits: unported.length,
      goSourcesWithPending: repositoryGoFiles().filter(file => readFileSync(file, 'utf8').includes('GO_PORT_PENDING')).length,
    };
    for (const sha of unported) failures.push(`Post-baseline Rust commit ${sha} remains unported.`);
    if (Object.values(cutover).some(count => count)) failures.push('Go port cutover is blocked.');
  }
  return { failures: [...failures, ...testMap.failures], testMap, cutover };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--require-a' && arg !== '--cutover'))
    throw new Error('Usage: node tooling/check-go-port.mjs [--require-a] [--cutover]');
  const { failures, testMap, cutover } = checkGoPort(undefined, {
    requireA: args.includes('--require-a'), cutover: args.includes('--cutover'),
  });
  console.log(JSON.stringify(cutover ?? testMap.counters));
  if (!cutover) for (const reason of testMap.reasons) console.log(reason);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Go port ledger and unit test map passed.');
  }
}

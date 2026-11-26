import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkGoTestMap } from './check-go-test-map.mjs';
import { nativeTestFiles } from './test-suites.mjs';

const rustRoots = ['native/src', 'desktop/src', 'tests/fixture/src'];
const segments = new Set(['S0', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);

export function checkGoPort(inventory, options) {
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
  for (const sha of recordedCommits) {
    if (!rust.size && !Object.hasOwn(portedCommits, sha)) failures.push(`Post-baseline Rust commit ${sha} remains unported.`);
  }
  const tests = new Set(nativeTestFiles());
  for (const file of tests) {
    const entry = ledger.nativeTests[file];
    if (!entry || !['pending', 'passed', 'blocked', 'failed'].includes(entry.result))
      failures.push(`Go port ledger is missing a native test result for ${file}.`);
  }
  for (const file of Object.keys(ledger.nativeTests)) {
    if (!tests.has(file)) failures.push(`Go port ledger has a stale native test ${file}.`);
  }
  if (!rust.size) {
    const sources = readdirSync('internal', { recursive: true }).filter(file => file.endsWith('.go') && !file.endsWith('_test.go'));
    if (sources.some(file => readFileSync(`internal/${file}`, 'utf8').includes('GO_PORT_PENDING')))
      failures.push('GO_PORT_PENDING remains after Rust cutover.');
    if (Object.values(ledger.files).some(entry => entry.status !== 'verified' || entry.remaining?.length))
      failures.push('Every source mapping must be verified before Rust cutover.');
  }
  const testMap = checkGoTestMap(ledger, inventory, options);
  return { failures: [...failures, ...testMap.failures], testMap };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--require-a')) throw new Error('Usage: node tooling/check-go-port.mjs [--require-a]');
  const { failures, testMap } = checkGoPort(undefined, { requireA: args.includes('--require-a') });
  console.log(JSON.stringify(testMap.counters));
  for (const reason of testMap.reasons) console.log(reason);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Go port ledger and unit test map passed.');
  }
}

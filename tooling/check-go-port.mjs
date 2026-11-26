import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { nativeTestFiles } from './test-suites.mjs';

const rustRoots = ['native/src', 'desktop/src', 'tests/fixture/src'];

export function checkGoPort() {
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
    if (!/^S0$|^[A-H]$/.test(entry.segment) || !statuses.includes(entry.status) || !Array.isArray(entry.go)) {
      failures.push(`Invalid Go port ledger entry for ${file}.`);
      continue;
    }
    if (entry.status !== 'pending' && !entry.go.length) failures.push(`Go port ledger has no Go source for ${file}.`);
    for (const mapped of entry.go) {
      if (!mapped.endsWith('.go') || !existsSync(mapped)) failures.push(`Missing Go port of ${file} at ${mapped}.`);
    }
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
    if (Object.values(ledger.files).some(entry => entry.status !== 'verified'))
      failures.push('Every source mapping must be verified before Rust cutover.');
  }
  return failures;
}

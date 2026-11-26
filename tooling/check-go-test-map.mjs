import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseTests, testFiles } from './test-cases.mjs';

const required = ['S0', 'B', 'C', 'D', 'E'];
const dropKinds = new Set(['implementation-detail', 'redundant', 'acceptance-only']);

function loadInventory() {
  const files = testFiles({ go: true });
  const go = files.filter(file => file.endsWith('_test.go'));
  const parsedGo = JSON.parse(execFileSync('go', ['run', './tooling/go-test-policy', ...go], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }));
  return new Map(files.map(file => [file, file.endsWith('.go')
    ? { cases: parsedGo[file] }
    : parseTests(file, readFileSync(file, 'utf8'))]));
}

export function checkGoTestMap(ledger, inventory = loadInventory(), { requireA = false } = {}) {
  const map = JSON.parse(readFileSync('tooling/go-test-map.json', 'utf8'));
  const failures = [];
  const entries = Object.entries(ledger.files);
  const enforce = new Set(required);
  const segmentA = entries.filter(([, row]) => row.segment === 'A');
  if (requireA || segmentA.length > 0 && segmentA.every(([, row]) => row.status !== 'pending')) enforce.add('A');
  const known = new Set();
  const counters = {};
  const count = segment => counters[segment] ??= { mapped: 0, partial: 0, dropped: 0, deferred: 0, added: 0 };
  const reasons = new Set();
  for (const [file, info] of inventory) {
    for (const { name } of info.cases) known.add(`${file}#${name}`);
  }
  const verifyTargets = (targets, label, requireGo) => {
    if (!Array.isArray(targets) || targets.length === 0 || new Set(targets).size !== targets.length) {
      failures.push(`${label} must identify one or more distinct tests.`);
      return;
    }
    for (const target of targets) {
      if (typeof target !== 'string' || !known.has(target) || (requireGo && !/_test\.go#Test\w+$/.test(target))) {
        failures.push(`${label} refers to an invalid test ${target}.`);
      }
    }
  };
  for (const [file, row] of entries) {
    if (!existsSync(file)) continue;
    const cases = new Set((inventory.get(file)?.cases ?? []).map(test => test.name));
    const mapped = map.files[file] ?? {};
    for (const name of cases) {
      const label = `${file}#${name}`;
      if (!Object.hasOwn(mapped, name)) {
        if (enforce.has(row.segment)) failures.push(`Go test map is missing ${label}.`);
        continue;
      }
      const entry = mapped[name];
      if (Array.isArray(entry)) {
        verifyTargets(entry, label, true);
        count(row.segment).mapped++;
      } else if (Array.isArray(entry?.tests) && typeof entry.remaining === 'string' && entry.remaining.trim()) {
        verifyTargets(entry.tests, label, true);
        count(row.segment).mapped++;
        count(row.segment).partial++;
      } else if (entry && dropKinds.has(entry.drop) && typeof entry.reason === 'string' && entry.reason.trim()) {
        const withRepresentative = entry.drop === 'redundant' || entry.drop === 'acceptance-only';
        if (withRepresentative) verifyTargets(entry.coveredBy, label, false);
        count(row.segment).dropped++;
        reasons.add(`${row.segment} ${label}: ${entry.reason}`);
      } else if (entry?.until === 'A' && typeof entry.reason === 'string' && entry.reason.trim()) {
        if (enforce.has('A')) failures.push(`${label} was deferred until I2: ${entry.reason}`);
        count(row.segment).deferred++;
      } else {
        failures.push(`Invalid Go test mapping for ${label}.`);
      }
    }
    for (const name of Object.keys(mapped)) {
      if (!cases.has(name)) failures.push(`Stale Go test mapping ${file}#${name}.`);
    }
  }
  for (const file of Object.keys(map.files)) {
    if (!Object.hasOwn(ledger.files, file)) failures.push(`Go test map has an unowned Rust file ${file}.`);
  }
  const added = new Set();
  for (const [segment, tests] of Object.entries(map.added)) {
    if (![...required, 'A'].includes(segment)) failures.push(`Unexpected added-test segment ${segment}.`);
    verifyTargets(tests, `Added tests in ${segment}`, true);
    for (const test of tests) {
      if (added.has(test)) failures.push(`Added Go test listed twice: ${test}.`);
      added.add(test);
    }
    count(segment).added = tests.length;
  }
  return { failures, counters, reasons: [...reasons] };
}

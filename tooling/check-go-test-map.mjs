import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseTests, testFiles } from './test-cases.mjs';

const required = ['S0', 'B', 'C', 'D', 'E', 'F'];
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
  const incompleteFiles = new Set();
  let unacceptedMappings = 0;
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
    const mapped = map.files[file] ?? {};
    const cases = new Set(existsSync(file)
      ? (inventory.get(file)?.cases ?? []).map(test => test.name)
      : Object.keys(mapped));
    for (const name of cases) {
      const label = `${file}#${name}`;
      if (!Object.hasOwn(mapped, name)) {
        incompleteFiles.add(file);
        if (enforce.has(row.segment)) failures.push(`Go test map is missing ${label}.`);
        continue;
      }
      const entry = mapped[name];
      const accepted = entry?.accepted?.owner === 'control-source' &&
        typeof entry.accepted.note === 'string' && entry.accepted.note.trim();
      if (entry?.accepted !== undefined && !accepted)
        failures.push(`Invalid control-source acceptance for ${label}.`);
      if (Array.isArray(entry)) {
        verifyTargets(entry, label, true);
        count(row.segment).mapped++;
      } else if (Array.isArray(entry?.tests) && typeof entry.remaining === 'string' && entry.remaining.trim()) {
        verifyTargets(entry.tests, label, true);
        count(row.segment).mapped++;
        count(row.segment).partial++;
        incompleteFiles.add(file);
        if (!accepted) unacceptedMappings++;
      } else if (entry && dropKinds.has(entry.drop) && typeof entry.reason === 'string' && entry.reason.trim()) {
        const withRepresentative = entry.drop === 'redundant' || entry.drop === 'acceptance-only';
        if (withRepresentative) verifyTargets(entry.coveredBy, label, false);
        count(row.segment).dropped++;
        reasons.add(`${row.segment} ${label}: ${entry.reason}`);
      } else if (entry?.until === 'A' && typeof entry.reason === 'string' && entry.reason.trim()) {
        if (!accepted) {
          incompleteFiles.add(file);
          unacceptedMappings++;
          if (enforce.has('A')) failures.push(`${label} was deferred until I2: ${entry.reason}`);
        }
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
  return { failures, counters, reasons: [...reasons], incompleteFiles, unacceptedMappings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--require-a')) throw new Error('Usage: node tooling/check-go-test-map.mjs [--require-a]');
  const ledger = JSON.parse(readFileSync('tooling/go-port.json', 'utf8'));
  const { failures, counters } = checkGoTestMap(ledger, undefined, { requireA: args.includes('--require-a') });
  console.log(JSON.stringify(counters));
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

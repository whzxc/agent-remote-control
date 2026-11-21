import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { motionTransition } from '../ui/motion/tokens.ts';
import { inspectMotionScripts } from './ui-motion-scripts.mjs';

const duration = /^var\(--motion-(?:fast|base|panel|running)\)$/;
const easing = /^var\(--ease-(?:enter|exit)\)$/;
const token = /^--(?:motion-(?:fast|base|panel|running)|ease-(?:enter|exit))$/;
const runningSelectors = new Set([
  '.spin', '.ui-spinner', '.update-ring', '.node-capsule-disc[data-phase=running]',
  '.task-card[data-aurora]', '.step-running .icon', '.phase-shimmer', '.phase-shimmer > span',
  '.topology-wires .primary[data-state=connecting] .connecting-wire',
]);
const reducedRoot = /^:root\[data-reduced-motion=(?:"true"|'true'|true)\]$/;
const zeroTime = /^0(?:s|ms)$/i;
const scaledRunning = /^calc\(var\(--motion-running\)\s*\*\s*var\(--topology-time-scale,\s*1\)\)$/;
const motionProperty = /^(?:(?:animation|transition)(?:-[a-z-]+)?|--motion-(?:fast|base|panel|running)|--ease-(?:enter|exit))$/;

function cssIssues(row, resolves) {
  const { property, value, selector } = row;
  const issues = [];
  if (token.test(property)) return ['design/tokens.css owns this token'];
  if (row.customTime) return resolves(value, duration) || resolves(value, easing) ? [] : ['artwork clock requires an exact exception'];
  if (!/^(animation|transition)(-|$)/.test(property)) return issues;
  const groups = postcss.list.comma(value);
  const isDuration = word => resolves(word, duration) || scaledRunning.test(word);
  let loops = 0;
  for (const group of groups) {
    const words = postcss.list.space(group);
    if (property.endsWith('-iteration-count') || property === 'animation') {
      if (words.some(word => word.toLowerCase() === 'infinite')) loops++;
      if (property.endsWith('-iteration-count') && !/^(?:\d*\.?\d+|infinite)$/.test(group)) issues.push('unresolved iteration count');
    }
    if (property.endsWith('-timing-function')) {
      if (!resolves(group, easing)) issues.push('timing function requires an easing token');
    } else if (/-(duration|delay)$/.test(property)) {
      if (!isDuration(group) && !(row.reduced && zeroTime.test(group))) issues.push('time requires a duration token');
      if (property.endsWith('-duration') && !zeroTime.test(group) && row.localEase === false) issues.push('duration needs an explicit timing function');
    } else if (property === 'transition' || property === 'animation') {
      if (group === 'none') continue;
      // Parse each comma-separated track; var() fallbacks and function arguments stay together.
      const times = words.filter(isDuration);
      const curves = words.filter(word => resolves(word, easing));
      if (!times.length || times.length > 2) issues.push('duration requires a motion token');
      if (curves.length !== 1 && !row.localEase) issues.push('timing function requires an easing token (CSS defaults to ease when omitted)');
      const rest = words.filter(word => !isDuration(word) && !resolves(word, easing));
      const options = /^(?:infinite|alternate(?:-reverse)?|normal|reverse|forwards|backwards|both|running|paused|none|\d*\.?\d+)$/;
      const names = rest.filter(word => !(property === 'animation' && options.test(word)));
      if (names.length > 1 || names.some(word => !/^[-_a-z][\w-]*$/i.test(word) || /^(ease(?:-in|-out|-in-out)?|linear|step-(?:start|end))$/i.test(word))) {
        issues.push('unresolved time, easing or shorthand component');
      }
    }
  }
  if (loops && (loops > 1 || !postcss.list.comma(selector).every(s => runningSelectors.has(s.replace(/=(["'])([\w-]+)\1\]/g, '=$2]'))))) {
    issues.push('an infinite track requires a running indicator or named artwork (one per indicator)');
  }
  return [...new Set(issues)];
}

function key(row) { return JSON.stringify([row.file, row.selector, row.property]); }

// The JS adapter has a no-DOM fallback. Compare it to the actual design source,
// so a token rename or value change cannot silently split CSS and JS timing.
function checkTokenSource(base, errors) {
  const file = 'design/tokens.css', values = new Map();
  const sheet = postcss.parse(readFileSync(path.join(base, file), 'utf8'), { from: file });
  sheet.walkDecls(decl => {
    if (decl.parent.selector === ':root' && decl.parent.parent.type === 'root') values.set(decl.prop, decl.value);
  });
  for (const name of ['fast', 'base', 'panel', 'running']) {
    const value = values.get('--motion-' + name)?.match(/^(\d*\.?\d+)(ms|s)$/);
    const seconds = value && Number(value[1]) / (value[2] === 'ms' ? 1000 : 1);
    if (!(seconds > 0) || name !== 'running' && seconds !== motionTransition(name).duration) {
      errors.push(`${file}: --motion-${name} needs a positive duration matching its JS fallback where provided.`);
    }
  }
  for (const name of ['enter', 'exit']) {
    const curve = values.get('--ease-' + name)?.match(/^cubic-bezier\(([^)]+)\)$/)?.[1].split(',').map(Number);
    const fallback = motionTransition('base', name).ease;
    if (curve?.length !== 4 || curve.some((n, index) => !Number.isFinite(n) || n !== fallback[index])) {
      errors.push(`${file}: --ease-${name} must resolve to the same curve as its JS fallback.`);
    }
  }
}

export function checkMotion(base) {
  const files = readdirSync(path.join(base, 'ui'), { recursive: true }).sort()
    .map(file => 'ui/' + file.split(path.sep).join('/')).filter(file => !file.includes('/node_modules/'));
  const rows = [], errors = [], reset = new Set();
  checkTokenSource(base, errors);
  for (const file of files.filter(file => file.endsWith('.css'))) {
    const sheet = postcss.parse(readFileSync(path.join(base, file), 'utf8'), { from: file });
    sheet.walkAtRules(/^(?:-webkit-)?keyframes$/i, rule => rows.push({
      file, line: rule.source.start.line, selector: rule.params, property: '@keyframes', value: rule.toString(),
    }));
    sheet.walkDecls(decl => {
      const property = decl.prop.replace(/^-webkit-/i, '').toLowerCase();
      if (!motionProperty.test(property) && !property.startsWith('--')) return;
      const { selector } = decl.parent;
      const parent = decl.parent.parent;
      const reduced = parent?.type === 'rule' && reducedRoot.test(parent.selector) || /\[data-reduced-motion=["']?true/.test(selector ?? '');
      const row = { file, line: decl.source.start.line, selector, property, value: decl.value, reduced };
      const family = property.split('-')[0];
      if (property === family || property.endsWith('-duration')) {
        // A later longhand can supply the shorthand's curve. Each longhand is checked independently.
        const siblings = decl.parent.nodes;
        row.localEase = siblings.some((other, index) => other.type === 'decl' &&
          (other.prop === family + '-timing-function' && (property !== family || index > siblings.indexOf(decl)) ||
           property !== family && other.prop === family));
      }
      rows.push(row);
      if (file === 'ui/style.css' && parent?.type === 'rule' && parent.parent.type === 'root' &&
          reducedRoot.test(parent.selector) && decl.important && zeroTime.test(decl.value)) {
        for (const target of decl.parent.selectors) reset.add(target + '/' + property);
      }
    });
  }
  rows.push(...inspectMotionScripts(base, files));
  const definitions = new Map(), customTimes = new Set();
  for (const row of rows) {
    if (row.property.startsWith('--')) {
      if (!definitions.has(row.property)) definitions.set(row.property, []);
      definitions.get(row.property).push(row.value);
    }
    if (/^(?:animation|transition)(?:-(?:delay|duration|timing-function))?$/.test(row.property)) {
      // The arguments of steps() count atlas cells. The topology multiplier is unitless.
      const timing = row.value.replace(/steps\(var\(--[\w-]+\)\)/g, '').replaceAll('--topology-time-scale', '');
      for (const [, name] of timing.matchAll(/var\(\s*(--[\w-]+)/g)) if (!token.test(name)) customTimes.add(name);
    }
  }
  for (const name of customTimes) {
    for (const value of definitions.get(name) ?? []) {
      const alias = value.match(/^var\((--[\w-]+)\)$/)?.[1];
      if (alias && !token.test(alias)) customTimes.add(alias);
    }
  }
  function resolves(value, kind, seen = new Set()) {
    if (kind.test(value)) return true;
    const alias = value.match(/^var\((--[\w-]+)\)$/)?.[1];
    if (!alias || seen.has(alias) || !definitions.has(alias) || token.test(alias)) return false;
    const visited = new Set(seen).add(alias);
    return definitions.get(alias).every(source => resolves(source, kind, visited));
  }
  const inventory = rows.filter(row => motionProperty.test(row.property) || row.property === '@keyframes' || customTimes.has(row.property) || (!row.property.startsWith('--') && row.issues));
  const exceptions = JSON.parse(readFileSync(path.join(base, 'tooling/ui-motion-allowlist.json'), 'utf8'));
  const allowed = new Map(), used = new Set();
  for (const entry of exceptions) {
    if (Object.keys(entry).sort().join(',') !== 'file,property,reason,selector' ||
        !Object.values(entry).every(v => typeof v === 'string' && v.trim()) ||
        !/^.+ artwork:\s*\S/i.test(entry.reason)) throw Error('Motion exceptions require file, selector, property and a reason naming the artwork.');
    if (allowed.has(key(entry))) throw Error('Duplicate motion exception: ' + key(entry));
    allowed.set(key(entry), entry.reason);
  }
  const decisions = JSON.parse(readFileSync(path.join(base, 'tooling/ui-motion-decisions.json'), 'utf8'));
  const pending = new Map(), matched = new Set(), seenDecisions = new Set();
  for (const entry of decisions) {
    const id = key(entry);
    if (Object.keys(entry).sort().join(',') !== 'current,file,property,proposed,reason,selector' ||
        !Object.values(entry).every(value => typeof value === 'string' && value.trim()) ||
        entry.reason !== 'pending timing decision' || entry.current === entry.proposed) {
      throw Error('Pending motion decisions require an exact location, current value, proposed timing and reason.');
    }
    if (allowed.has(id) || pending.has(id)) throw Error('Duplicate motion exception: ' + id);
    pending.set(id, entry);
  }
  for (const row of inventory) {
    if (customTimes.has(row.property)) row.customTime = true;
    const issues = row.issues ?? cssIssues(row, resolves);
    const id = key(row), decision = pending.get(id);
    if (decision && row.value !== 'none') {
      if (seenDecisions.has(id)) errors.push(`${row.file}:${row.line}: overlapping pending motion decision: ${id}`);
      seenDecisions.add(id);
    }
    // Semantic token choices can already parse correctly. Pin those reviewed values too.
    if (decision && !token.test(row.property) && decision.current === row.value && !matched.has(id)) {
      matched.add(id);
      row.pending = decision.proposed;
      row.issues = issues;
      continue;
    }
    const reason = allowed.get(id);
    if (issues.length && reason && !token.test(row.property)) {
      row.artwork = reason;
      used.add(key(row));
    } else if (issues.length) {
      row.issues = issues;
      errors.push(`${row.file}:${row.line}: ${row.selector}: ${row.property}: ${issues.join('; ')}.`);
    }
  }
  for (const id of pending.keys()) if (!matched.has(id)) errors.push('Stale or changed pending motion decision: ' + id);
  for (const id of allowed.keys()) if (!used.has(id)) errors.push('Stale motion exception: ' + id);
  for (const selector of ['*', '*::before', '*::after']) {
    for (const property of ['animation-duration', 'transition-duration']) {
      if (!reset.has(selector + '/' + property)) errors.push(`ui/style.css: reduced motion requires an important zero ${property} on ${selector}.`);
    }
  }
  return { inventory, errors, exceptions: used.size, pending: matched.size };
}

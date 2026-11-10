// Shared capture policy. Keep value masks narrow so behavioral changes remain visible.
export const MASKS = ['guideHash', 'next.hash', 'phaseAgeMs', 'elapsedMs', 'snapshotHash', 'arcVersion', 'cliPath'];
export const NOTIFICATION_KINDS = ['completed', 'failed', 'interrupted', 'needs-input', 'handoff', 'recovered', 'ping'];

export function createNormalizer({ directory, cliPath } = {}) {
  const ids = new Map();
  const replacements = [[directory, '<fixture>'], [cliPath, '<cli>']]
    .filter(([value]) => value).sort((a, b) => b[0].length - a[0].length);
  function string(value) {
    for (const [from, to] of replacements) value = value.replaceAll(from, to).replaceAll(from.replaceAll('\\', '/'), to);
    return value.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, id => {
      const key = id.toLowerCase();
      if (!ids.has(key)) ids.set(key, `<uuid-${ids.size + 1}>`);
      return ids.get(key);
    }).replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b/g, '<iso-time>')
      .replace(/\b1\d{12}\b/g, '<epoch-ms>').replace(/\b1\d{9}\b/g, '<epoch-s>');
  }
  function normalize(value, trail = []) {
    if (typeof value === 'string') {
      // Normalize embedded JSON while retaining the raw MCP text-block envelope.
      if (/^\s*[{[]/.test(value)) {
        try { return JSON.stringify(normalize(JSON.parse(value), trail)); } catch { /* Plain text, not JSON. */ }
      }
      return string(value);
    }
    if (typeof value === 'number') {
      if (value >= 1e12 && value < 2e12) return '<epoch-ms>';
      if (value >= 1e9 && value < 2e9) return '<epoch-s>';
    }
    if (Array.isArray(value)) return value.map((item, index) => normalize(item, [...trail, index]));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const masked = MASKS.includes(key) || MASKS.includes(`${trail.at(-1)}.${key}`);
      return [string(key), masked ? '<masked>' : normalize(item, [...trail, key])];
    }));
    return value;
  }
  return normalize;
}

// Decode JSON text blocks for path-level diffs without discarding any MCP metadata.
export function expandJSON(value) {
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value)) {
      try { return expandJSON(JSON.parse(value)); } catch { /* Plain text, not JSON. */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(expandJSON);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandJSON(v)]));
  return value;
}

export function diffJSON(before, after, pointer = '') {
  if (Object.is(before, after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key =>
      diffJSON(before[key], after[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: pointer || '/', change: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed',
    ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }];
}

export function coverage(catalog, capabilities, scenarios, current = {}, approved = {}) {
  const errors = [], names = catalog.ops.map(op => op.name), assignments = new Map(), ids = new Set();
  for (const cap of capabilities) {
    if (ids.has(cap.id)) errors.push(`Duplicate capability: ${cap.id}`);
    ids.add(cap.id);
    for (const op of cap.ops) {
      if (!names.includes(op)) errors.push(`Removed or unknown op: ${cap.id}/${op}`);
      if (assignments.has(op)) errors.push(`Op assigned twice: ${op}`);
      assignments.set(op, cap.id);
    }
  }
  for (const op of names) if (!assignments.has(op)) errors.push(`Unassigned op: ${op}`);
  const kinds = capabilities.flatMap(cap => cap.notificationKinds ?? []);
  for (const kind of NOTIFICATION_KINDS) {
    if (kinds.filter(item => item === kind).length !== 1) errors.push(`Notification kind must be assigned once: ${kind}`);
  }
  for (const kind of kinds) if (!NOTIFICATION_KINDS.includes(kind)) errors.push(`Unknown notification kind: ${kind}`);
  const scenarioIds = new Set();
  for (const scenario of scenarios) {
    if (scenarioIds.has(scenario.id)) errors.push(`Duplicate scenario: ${scenario.id}`);
    scenarioIds.add(scenario.id);
    if (!ids.has(scenario.capability)) errors.push(`Unknown capability: ${scenario.id}/${scenario.capability}`);
    for (const op of scenario.ops) if (!names.includes(op)) errors.push(`Unknown scenario op: ${scenario.id}/${op}`);
    for (const kind of scenario.notificationKinds ?? []) if (!kinds.includes(kind)) errors.push(`Unknown scenario notification: ${scenario.id}/${kind}`);
  }
  const status = id => !current[id] ? 'missing' : !approved[id] || diffJSON(expandJSON(approved[id]), expandJSON(current[id])).length ? 'pending' : 'approved';
  const rows = capabilities.map(cap => {
    const owned = scenarios.filter(s => s.capability === cap.id);
    const coveredOps = cap.ops.filter(op => scenarios.some(s => s.ops.includes(op)));
    const missingOps = cap.ops.filter(op => !coveredOps.includes(op));
    return { id: cap.id, ops: cap.ops.length, coveredOps: coveredOps.length, missingOps,
      approved: owned.filter(s => status(s.id) === 'approved').length,
      pending: owned.filter(s => status(s.id) === 'pending').length,
      missing: owned.filter(s => status(s.id) === 'missing').length,
      missingNotificationKinds: (cap.notificationKinds ?? []).filter(kind => !scenarios.some(s => s.notificationKinds?.includes(kind))) };
  });
  return { errors, rows, status };
}

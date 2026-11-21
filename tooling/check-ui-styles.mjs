import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { checkConsumers } from './check-ui-consumers.mjs';
import { checkMotion } from './check-ui-motion.mjs';
import { checkTokens } from './check-ui-tokens.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const paint = /^(?:color|background(?:-.+)?|border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-(?:color|style|radius))?|border-(?:top-left|top-right|bottom-left|bottom-right|start-start|start-end|end-start|end-end)-radius|box-shadow|font(?:-.+)?|line-height|letter-spacing|text-shadow|text-transform|text-decoration(?:-.+)?|fill|stroke(?:-width|-color)?)$/;

export { tokenPaint } from './ui-paint.mjs';
import { tokenPaint } from './ui-paint.mjs';

export async function inspectStyles(base = root) {
  const declarations = [];
  for (const file of (await readdir(path.join(base, 'ui'), { recursive: true })).sort()) {
    if (!file.endsWith('.css') || file.startsWith('components/ui/') || file === 'tokens.css') continue;
    const relative = `ui/${file}`;
    postcss.parse(await readFile(path.join(base, relative), 'utf8'), { from: relative }).walkDecls(declaration => {
      if (!paint.test(declaration.prop.toLowerCase())) return;
      const rule = declaration.parent;
      declarations.push({ file: relative, selector: rule.selector ?? `@${rule.name} ${rule.params}`.trim(),
        property: declaration.prop.toLowerCase(), value: declaration.value, line: declaration.source.start.line });
    });
  }
  return declarations;
}

export async function checkStyles(base = root) {
  const exceptions = JSON.parse(await readFile(path.join(base, 'tooling/ui-style-allowlist.json'), 'utf8'));
  if (!Array.isArray(exceptions)) throw new Error('ui-style-allowlist.json must contain an array.');
  const key = row => JSON.stringify([row.file, row.selector, row.property]);
  const allowed = new Map();
  for (const row of exceptions) {
    if (Object.keys(row).sort().join(',') !== 'file,property,reason,selector' ||
        !['file', 'selector', 'property', 'reason'].every(field => typeof row[field] === 'string' && row[field].trim())) {
      throw new Error('Every style exception requires exactly file, selector, property and reason.');
    }
    if (allowed.has(key(row))) throw new Error(`Duplicate style exception: ${key(row)}`);
    allowed.set(key(row), row);
  }
  const declarations = await inspectStyles(base), used = new Set(), errors = [];
  for (const row of declarations) {
    if (tokenPaint(row.value, row.property)) continue;
    if (allowed.has(key(row)) && /artwork/i.test(allowed.get(key(row)).reason)) used.add(key(row));
    else errors.push(`${row.file}:${row.line}: ${row.selector}: ${row.property} requires runtime tokens or an exact artwork exception naming the artwork.`);
  }
  for (const [id, row] of allowed) if (!used.has(id)) errors.push(`Stale style exception: ${row.file}: ${row.selector}: ${row.property}`);
  return { declarations: declarations.length, exceptions: used.size, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkStyles();
    const consumers = checkConsumers();
    const motion = checkMotion(root);
    result.errors.push(...motion.errors, ...consumers.errors, ...checkTokens(root, consumers.parts).errors);
    if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
    else console.log(`UI style policy passed (${result.declarations} declarations, ${result.exceptions} paint exceptions, ${motion.exceptions} motion artwork exceptions).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

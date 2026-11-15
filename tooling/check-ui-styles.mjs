import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { checkConsumers } from './check-ui-consumers.mjs';
import { checkTokens } from './check-ui-tokens.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const paint = /^(?:color|background(?:-.+)?|border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-(?:color|style|radius))?|border-(?:top-left|top-right|bottom-left|bottom-right|start-start|start-end|end-start|end-end)-radius|box-shadow|font(?:-.+)?|line-height|letter-spacing|text-shadow|text-transform|text-decoration(?:-.+)?)$/;

// Values may combine tokens with structural CSS syntax. A fallback must obey the same rule.
export function tokenPaint(value, property) {
  let text = value.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  for (let index = text.indexOf('var('); index >= 0; index = text.indexOf('var(')) {
    let depth = 1, end = index + 4;
    for (; end < text.length && depth; end++) { if (text[end] === '(') depth++; if (text[end] === ')') depth--; }
    if (depth) return false;
    const body = text.slice(index + 4, end - 1), comma = body.indexOf(',');
    const name = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!/^--[a-zA-Z0-9_-]+$/.test(name) || comma >= 0 && !tokenPaint(body.slice(comma + 1), property)) return false;
    text = text.slice(0, index) + ' TOKEN ' + text.slice(end);
  }
  if (/[#"']/.test(text) || /(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\(/i.test(text)) return false;
  // Percentages in color-mix are blending weights, not authored colors or dimensions.
  const mix = /color-mix\s*\(/i.test(text);
  text = text.replace(/color-mix\s*\(\s*in\s+(?:srgb|oklab|oklch)\s*,/g, '(');
  if (mix) text = text.replace(/\b\d+(?:\.\d+)?%/g, '');
  if (property === 'font-weight' || property === 'font') text = text.replace(/\b[1-9]00\b/g, '');
  if (property === 'line-height') text = text.replace(/\b\d+(?:\.\d+)?(?![\w.])/g, '');
  return text.replace(/\b(?:TOKEN|inherit|currentColor|transparent|none|normal|solid|dashed|dotted|double|inset|outset|bold|bolder|lighter|italic|oblique|tabular-nums|lining-nums|proportional-nums|small-caps|uppercase|lowercase|capitalize|underline|line-through|overline|auto)\b/gi, '')
    .replace(/(?<![\w.])0(?![\w.])/g, '').replace(/[\s(),/+*-]/g, '') === '';
}

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
    if (allowed.has(key(row))) used.add(key(row));
    else errors.push(`${row.file}:${row.line}: ${row.selector}: ${row.property} requires runtime tokens or an exact literal-value exception.`);
  }
  for (const [id, row] of allowed) if (!used.has(id)) errors.push(`Stale style exception: ${row.file}: ${row.selector}: ${row.property}`);
  return { declarations: declarations.length, exceptions: used.size, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkStyles();
    const consumers = checkConsumers();
    result.errors.push(...consumers.errors, ...checkTokens(root, consumers.parts).errors);
    if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
    else console.log(`UI style policy passed (${result.declarations} declarations, ${result.exceptions} exact exceptions).`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import ts from 'typescript';
import { tokenPaint } from './ui-paint.mjs';
import { nearestToken, tokenKind } from './token-distance.mjs';
import { featureOwner, inspectConsumers } from './check-ui-consumers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shared = 'ui/components/ui/';
const paint = /^(?:color|background(?:-.+)?|border(?!-collapse|-spacing).*|box-shadow|font(?:-.+)?|line-height|letter-spacing|text-shadow|text-decoration.*|fill|stroke(?:-width|-color)?)$/;
const references = value => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(match => match[1]);

export function inspectTokens(base = root, parts = inspectConsumers(base)) {
  const files = readdirSync(path.join(base, 'ui'), { recursive: true })
    .filter(file => /\.(?:css|tsx?|svg)$/.test(file)).map(file => `ui/${file}`);
  const literalUses = [], declarationUses = new Map(), sharedPaint = [], definitions = new Map(), usages = new Map(), localAliases = new Map(), paintTokens = new Set();
  for (const file of ['design/tokens.css', 'ui/tokens.css']) {
    if (!existsSync(path.join(base, file))) continue;
    postcss.parse(readFileSync(path.join(base, file), 'utf8')).walkDecls(declaration => {
      if (!declaration.prop.startsWith('--')) return;
      const token = declaration.prop;
      if (!definitions.has(token)) definitions.set(token, { file, token, values: [], consumers: new Set() });
      definitions.get(token).values.push(declaration.value);
    });
  }
  for (const file of files) {
    const text = readFileSync(path.join(base, file), 'utf8'), used = new Set();
    if (file.endsWith('.css')) {
      postcss.parse(text).walkDecls(declaration => {
        if (declaration.prop.startsWith('--')) {
          if (!definitions.has(declaration.prop)) {
            const dependencies = localAliases.get(declaration.prop) ?? new Set();
            for (const token of references(declaration.value)) dependencies.add(token);
            localAliases.set(declaration.prop, dependencies);
          }
          if (file !== 'ui/tokens.css') for (const token of references(declaration.value)) {
            used.add(token);
            if (file.startsWith(shared)) sharedPaint.push({ token, selector: declaration.parent.selector ?? '' });
          }
          return;
        }
        if (file !== 'ui/tokens.css' && !references(declaration.value).length) literalUses.push({property:declaration.prop,value:declaration.value});
        for (const token of new Set(references(declaration.value))) {
          if (file !== 'ui/tokens.css') declarationUses.set(token, (declarationUses.get(token) ?? 0) + 1);
          used.add(token);
          if (paint.test(declaration.prop)) paintTokens.add(token);
          if (file.startsWith(shared)) sharedPaint.push({ token, selector: declaration.parent.selector ?? '' });
        }
      });
    } else {
      for (const token of references(text)) { used.add(token); paintTokens.add(token); declarationUses.set(token, (declarationUses.get(token) ?? 0) + 1); }
    }
    usages.set(file, used);
  }
  function include(token, owner, seen = new Set()) {
    if (seen.has(token)) return;
    seen.add(token);
    const definition = definitions.get(token);
    if (!definition) {
      for (const dependency of localAliases.get(token) ?? []) include(dependency, owner, seen);
      return;
    }
    definition.consumers.add(owner);
    for (const value of definition.values) for (const dependency of references(value)) include(dependency, owner, seen);
  }
  for (const file of files.filter(file => !file.startsWith(shared) && file !== 'ui/tokens.css')) {
    const owner = featureOwner(file.replace(/\.css$/, '.tsx')), seen = new Set();
    function visit(target) {
      if (seen.has(target)) return;
      seen.add(target);
      for (const token of usages.get(target) ?? []) include(token, owner);
      // Shared declarations are attributed below, without crossing feature boundaries.
    }
    visit(file);
  }
  // Global shared CSS is loaded by the app shell. Attribute each selector to the
  // defining component that emits its class, then use that component's feature consumers.
  const sharedBodies = new Map();
  for (const file of new Set(parts.map(part => part.file))) {
    const ast = ts.createSourceFile(file, readFileSync(path.join(base, file), 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      if (node.name) sharedBodies.set(`${file}#${node.name.text}`, node.getText(ast));
      if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) sharedBodies.set(`${file}#${declaration.name.getText(ast)}`, declaration.getText(ast));
    }
  }
  for (const part of parts) for (const token of references(sharedBodies.get(`${part.file}#${part.local}`) ?? '')) {
    for (const owner of part.consumers) include(token, owner);
  }
  for (const { token, selector } of sharedPaint) {
    const classes = selector.split(',').map(branch => /\.([a-zA-Z_][\w-]*)/.exec(branch)?.[1] ?? /\[([\w-]+)/.exec(branch)?.[1]).filter(Boolean);
    for (const part of parts) {
      const body = sharedBodies.get(`${part.file}#${part.local}`) ?? '';
      if (classes.some(name => new RegExp(`(?<![\w-])${name}(?![\w-])`).test(body))) for (const owner of part.consumers) include(token, owner);
    }
  }
  const painted = new Set();
  function markPaint(token) {
    if (painted.has(token)) return;
    painted.add(token);
    const definition = definitions.get(token);
    if (!definition) {
      for (const dependency of localAliases.get(token) ?? []) markPaint(dependency);
      return;
    }
    definition.paint = true;
    for (const value of definition.values) for (const dependency of references(value)) markPaint(dependency);
  }
  for (const token of paintTokens) markPaint(token);
  return [...definitions.values()].map(({ consumers, ...row }) => ({ ...row, consumers: [...consumers].sort(), count: consumers.size, uses: (declarationUses.get(row.token) ?? 0) + literalUses.filter(use => use.property === (tokenKind(row.token) === 'radius' ? 'border-radius' : tokenKind(row.token)) && row.values.includes(use.value)).length }));
}

export function checkTokens(base = root, parts) {
  const file = path.join(base, 'tooling/ui-token-allowlist.json');
  const exceptions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const allowed = new Map(), errors = [], used = new Set();
  for (const row of exceptions) {
    if (Object.keys(row).sort().join(',') !== 'file,reason,token' || ![row.file, row.token, row.reason].every(value => typeof value === 'string' && value.trim())) throw new Error('Every token exception requires exactly file, token and reason.');
    const key = `${row.file}#${row.token}`;
    if (allowed.has(key)) throw new Error(`Duplicate token exception: ${key}`);
    allowed.set(key, row);
  }
  const stylesFile = path.join(base, 'tooling/ui-style-allowlist.json');
  const artwork = existsSync(stylesFile) ? JSON.parse(readFileSync(stylesFile, 'utf8')) : [];
  const styleKey = row => JSON.stringify([row.file, row.selector, row.property]);
  const artworkKeys = new Set(artwork.filter(row => /artwork/i.test(row.reason)).map(styleKey));
  for (const relative of readdirSync(path.join(base, 'ui'), { recursive: true }).filter(file => file.endsWith('.css') && file !== 'tokens.css' && !file.startsWith('components/ui/'))) {
    const file = `ui/${relative}`;
    postcss.parse(readFileSync(path.join(base, file), 'utf8')).walkDecls(declaration => {
      if (!paint.test(declaration.prop) || declaration.prop.startsWith('--') || tokenPaint(declaration.value, declaration.prop)) return;
      const selector = declaration.parent.selector ?? `@${declaration.parent.name} ${declaration.parent.params}`.trim();
      if (!artworkKeys.has(styleKey({ file, selector, property: declaration.prop }))) errors.push(`${file}: ${selector}: literal ${declaration.prop} needs a runtime token; only named artwork can be excepted.`);
    });
  }
  const tokens = inspectTokens(base, parts);
  for (const row of tokens) {
    if (!row.paint) continue;
    const key = `${row.file}#${row.token}`;
    // A numbered series (chart channels, spacing steps) is distinct from a name encoding its literal value.
    const numeric = [...row.token.matchAll(/(?:^|-)(\d+)(?=-|$)/g)].map(match => Number(match[1]));
    const valueNamed = numeric.some(number => row.values.some(value => new RegExp(`^${number}(?:px|rem|em|%|ms|s)?$`).test(value.trim())));
    if (valueNamed) errors.push(`${key}: name encodes its literal value; use a semantic role.`);
    if (allowed.has(key)) { used.add(key); continue; }
    const nearest = nearestToken(row, tokens);
    if (nearest && !nearest.large && row.uses < 3) errors.push(`${key}: ${row.uses} declaration use(s); nearest ${nearest.token} differs by ${nearest.difference}; use that token for this small difference.`);
  }
  for (const key of allowed.keys()) if (!used.has(key)) errors.push(`Stale token exception: ${key}`);
  return { tokens, exceptions: used.size, errors };
}

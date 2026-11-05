import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const designDir = path.join(root, 'design');
const outDir = path.join(root, 'output/design');
const BEGIN = '<!-- design:tokens -->';
const END = '<!-- /design:tokens -->';
const USAGE = 'Usage: npm run design -- sync | check [asset...] | render [asset...] | gallery | measure <text> [--size=14] [--weight=400] [--mono]';
const THEMES = ['light', 'dark'];

export function parseTokens(css) {
  const block = selector => {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`design/tokens.css is missing the ${selector} block`);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  };
  return { light: block(':root'), dark: block(':root[data-theme="dark"]') };
}

// Splits a box-shadow list into SVG drop-shadow layers; spread and inset have no SVG filter equivalent.
export function shadowLayers(value) {
  const layers = [];
  let depth = 0, current = '';
  for (const char of value) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { layers.push(current.trim()); current = ''; } else current += char;
  }
  layers.push(current.trim());
  return layers.map(layer => {
    const match = layer.match(/^(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?\s+(\S.*)$/);
    if (!match) throw new Error(`Shadow layer "${layer}" must be "<x> <y> <blur> <color>"`);
    return { dx: +match[1], dy: +match[2], blur: +match[3], color: match[4] };
  });
}

const shadowFilter = (id, value) => {
  const layers = shadowLayers(value);
  const primitives = layers.map(({ dx, dy, blur, color }, i) =>
    `<feGaussianBlur in="SourceAlpha" stdDeviation="${blur / 2}"/><feOffset dx="${dx}" dy="${dy}" result="o${i}"/><feFlood style="flood-color:${color}"/><feComposite in2="o${i}" operator="in" result="s${i}"/>`).join('');
  const merge = layers.map((_, i) => `<feMergeNode in="s${i}"/>`).join('');
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${primitives}<feMerge>${merge}<feMergeNode in="SourceGraphic"/></feMerge></filter>`;
};

export function tokenRegion(tokens) {
  const shadows = [...tokens.light.keys()].filter(key => key.startsWith('--shadow-'));
  const declarations = (map, theme) => [...map].map(([key, value]) => `${key}:${value}`)
    .concat(shadows.map(key => `--elev-${key.slice('--shadow-'.length)}:url(#elev-${key.slice('--shadow-'.length)}-${theme})`)).join(';');
  const dark = declarations(tokens.dark, 'dark');
  const style = [
    `:root{${declarations(tokens.light, 'light')}}`,
    `:root[data-theme="dark"]{${dark}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}}}`,
    'text{font-family:var(--font-ui);dominant-baseline:central}',
    '.mono{font-family:var(--font-mono)}',
    '.note{font-family:var(--font-mono);font-size:var(--text-caption);fill:var(--text-tertiary)}',
  ].join('\n');
  const filters = THEMES.flatMap(theme => shadows.map(key => {
    const value = tokens[theme].get(key) ?? tokens.light.get(key);
    return shadowFilter(`elev-${key.slice('--shadow-'.length)}-${theme}`, value);
  })).join('\n');
  return `${BEGIN}\n<style>\n${style}\n</style>\n<defs data-design-tokens="">\n${filters}\n</defs>\n${END}`;
}

export function syncSvg(svg, region) {
  const start = svg.indexOf(BEGIN), end = svg.indexOf(END);
  if (start >= 0 && end > start) return svg.slice(0, start) + region + svg.slice(end + END.length);
  const open = svg.indexOf('>', svg.indexOf('<svg'));
  if (open < 0) throw new Error('Asset has no <svg> root');
  return `${svg.slice(0, open + 1)}\n${region}${svg.slice(open + 1)}`;
}

// An instance keeps its form's container geometry and paint and only uses the form's text styles.
export function compareInstance(definition, instance) {
  const differences = [];
  if (!definition.container !== !instance.container) differences.push('container rect presence differs');
  else if (definition.container) {
    for (const key of ['height', 'rx', 'fill', 'stroke', 'filter']) {
      if (definition.container[key] !== instance.container[key]) differences.push(`${key} ${JSON.stringify(instance.container[key])} should be ${JSON.stringify(definition.container[key])}`);
    }
  }
  for (const style of instance.text) if (!definition.text.includes(style)) differences.push(`text style ${style} is not used by the form`);
  return differences;
}

function listAssets(dir = designDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listAssets(file);
    return entry.name.endsWith('.svg') ? [file] : [];
  }).sort();
}

function selectAssets(args) {
  if (!args.length) return listAssets();
  return args.map(arg => {
    const file = path.resolve(arg);
    if (!file.startsWith(designDir + path.sep) || !file.endsWith('.svg')) throw new Error(`${arg} is not an SVG asset under design/`);
    return file;
  });
}

const relative = file => path.relative(root, file).split(path.sep).join('/');
const loadTokens = () => parseTokens(readFileSync(path.join(designDir, 'tokens.css'), 'utf8'));
const svgSize = svg => {
  const match = svg.match(/<svg\b[^>]*?\bwidth="([\d.]+)"[^>]*?\bheight="([\d.]+)"/);
  if (!match) throw new Error('Asset root needs numeric width and height');
  return { width: Math.ceil(+match[1]), height: Math.ceil(+match[2]) };
};

async function launch() {
  const { chromium } = await import('playwright');
  return chromium.launch();
}

// Runs inside the browser against one standalone SVG document.
function inspectDocument() {
  const svg = document.documentElement;
  const problems = [];
  const defined = new Set();
  for (const style of svg.querySelectorAll('style')) for (const match of style.textContent.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]);
  const label = el => {
    const owner = el.closest('[data-component]');
    const where = owner ? `${owner.dataset.component}/${owner.dataset.form ?? '?'} ` : '';
    const text = el.tagName === 'text' ? ` "${el.textContent.trim().slice(0, 32)}"` : '';
    return `${where}<${el.tagName}${text}>`;
  };
  const paints = ['fill', 'stroke', 'stop-color', 'flood-color', 'color'];
  for (const el of svg.querySelectorAll('*')) {
    if (el.closest('style, [data-design-tokens], [data-brand]')) continue;
    for (const property of paints) {
      for (const raw of [el.getAttribute(property), el.style.getPropertyValue(property)]) {
        const value = raw?.trim();
        if (!value || /^(none|transparent|currentcolor|inherit)$/i.test(value) || value.startsWith('url(')) continue;
        if (!/^var\(--[\w-]+\)$/.test(value)) problems.push(`${label(el)} paints ${property} with literal ${value}; use a token`);
      }
    }
    for (const match of (el.getAttribute('style') ?? '').matchAll(/var\((--[\w-]+)\)/g)) {
      if (!defined.has(match[1])) problems.push(`${label(el)} references undefined token ${match[1]}`);
    }
  }
  const canvas = svg.getBoundingClientRect();
  const texts = [...svg.querySelectorAll('text')].filter(t => !t.closest('[data-brand], defs'));
  const boxes = texts.map(t => t.getBoundingClientRect());
  texts.forEach((t, i) => {
    const b = boxes[i];
    if (b.left < canvas.left - 0.5 || b.right > canvas.right + 0.5 || b.top < canvas.top - 0.5 || b.bottom > canvas.bottom + 0.5) problems.push(`${label(t)} extends outside the canvas`);
    for (let j = i + 1; j < texts.length; j++) {
      const o = boxes[j];
      if (Math.min(b.right, o.right) - Math.max(b.left, o.left) > 0.5 && Math.min(b.bottom, o.bottom) - Math.max(b.top, o.top) > 0.5) problems.push(`${label(t)} overlaps ${label(texts[j])}`);
    }
  });
  const instances = [];
  for (const group of svg.querySelectorAll('[data-component]')) {
    const container = [...group.children].find(child => child.tagName === 'rect');
    const own = [...group.querySelectorAll('text')].filter(t => t.closest('[data-component]') === group);
    if (container) {
      const r = container.getBoundingClientRect();
      for (const t of own) {
        const b = t.getBoundingClientRect(), middle = (b.top + b.bottom) / 2;
        if (middle < r.top || middle > r.bottom) continue;
        if (b.left < r.left - 0.5 || b.right > r.right + 0.5 || b.top < r.top - 0.5 || b.bottom > r.bottom + 0.5) problems.push(`${label(t)} overflows its ${group.dataset.component} container`);
      }
    }
    instances.push({
      component: group.dataset.component,
      form: group.dataset.form,
      nested: !!group.parentElement.closest('[data-component]'),
      at: `${group.dataset.component}/${group.dataset.form ?? '?'} at ${group.getAttribute('transform') ?? 'origin'}`,
      signature: {
        container: container ? { height: container.getAttribute('height'), rx: container.getAttribute('rx') ?? '0', fill: container.style.fill, stroke: container.style.stroke, filter: container.style.filter } : null,
        text: [...new Set(own.map(t => [t.style.fill, t.style.fontSize, t.style.fontWeight, t.classList.contains('mono') ? 'mono' : 'ui'].join(' ')))].sort(),
      },
    });
  }
  return { problems, instances };
}

async function inspect(browser, files) {
  const results = new Map();
  const page = await browser.newPage();
  for (const file of files) {
    await page.setViewportSize(svgSize(readFileSync(file, 'utf8')));
    await page.goto(pathToFileURL(file).href);
    results.set(file, await page.evaluate(inspectDocument));
  }
  await page.close();
  return results;
}

async function check(args) {
  const region = tokenRegion(loadTokens());
  const files = selectAssets(args);
  const components = listAssets(path.join(designDir, 'components'));
  const problems = [];
  for (const file of files) if (!readFileSync(file, 'utf8').includes(region)) problems.push(`${relative(file)}: token region is stale; run npm run design -- sync`);
  const browser = await launch();
  try {
    const results = await inspect(browser, [...new Set([...components, ...files])]);
    const definitions = new Map();
    for (const file of components) {
      const name = path.basename(file, '.svg');
      for (const item of results.get(file).instances) {
        if (item.nested || item.component !== name) continue;
        const key = `${item.component}/${item.form}`;
        if (!item.form) problems.push(`${relative(file)}: ${item.at} has no data-form`);
        else if (definitions.has(key)) problems.push(`${relative(file)}: form ${key} is defined twice`);
        else definitions.set(key, item.signature);
      }
    }
    for (const file of files) {
      const result = results.get(file);
      for (const problem of result.problems) problems.push(`${relative(file)}: ${problem}`);
      const isComponent = components.includes(file);
      for (const item of result.instances) {
        if (isComponent && !item.nested && item.component === path.basename(file, '.svg')) continue;
        const definition = definitions.get(`${item.component}/${item.form}`);
        if (!definition) { problems.push(`${relative(file)}: ${item.at} has no definition in design/components/${item.component}.svg`); continue; }
        for (const difference of compareInstance(definition, item.signature)) problems.push(`${relative(file)}: ${item.at}: ${difference}`);
      }
    }
  } finally { await browser.close(); }
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    throw new Error(`Design check failed with ${problems.length} problem${problems.length === 1 ? '' : 's'}.`);
  }
  console.log(`Design check passed for ${files.length} asset${files.length === 1 ? '' : 's'}.`);
}

function sync() {
  const region = tokenRegion(loadTokens());
  let changed = 0;
  for (const file of listAssets()) {
    const before = readFileSync(file, 'utf8'), after = syncSvg(before, region);
    if (after !== before) { writeFileSync(file, after); changed++; console.log(`synced ${relative(file)}`); }
  }
  console.log(`${changed} asset${changed === 1 ? '' : 's'} updated.`);
}

async function render(args) {
  const files = selectAssets(args);
  const browser = await launch();
  try {
    for (const theme of THEMES) {
      const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: theme });
      for (const file of files) {
        await page.setViewportSize(svgSize(readFileSync(file, 'utf8')));
        await page.goto(pathToFileURL(file).href);
        const target = path.join(outDir, path.relative(designDir, file).replace(/\.svg$/, `-${theme}.png`));
        mkdirSync(path.dirname(target), { recursive: true });
        await page.screenshot({ path: target });
        console.log(relative(target));
      }
      await page.close();
    }
  } finally { await browser.close(); }
}

function gallery() {
  const files = listAssets();
  const groups = Map.groupBy(files, file => path.relative(designDir, path.dirname(file)) || 'design');
  const sections = [...groups].map(([group, list]) => `<section><h2>${group}</h2>${list.map(file =>
    `<figure><figcaption>${relative(file)}</figcaption>${readFileSync(file, 'utf8').replace(/<\?xml[^>]*\?>\s*/, '')}</figure>`).join('')}</section>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ARC design assets</title><style>
body{margin:0;background:var(--canvas);color:var(--text);font-family:var(--font-ui)}
header{position:sticky;top:0;z-index:1;display:flex;gap:8px;align-items:center;padding:12px 24px;background:var(--surface-raised);border-bottom:1px solid var(--border)}
header strong{margin-right:auto;font-size:14px}
header button{font:inherit;font-size:13px;padding:6px 14px;border:0;border-radius:999px;background:var(--surface-sunken);color:var(--text-secondary);cursor:pointer}
header button[aria-pressed="true"]{background:var(--action);color:var(--on-action)}
section{padding:8px 24px 24px}h2{font:500 12px var(--font-mono);color:var(--text-tertiary)}
figure{margin:0 0 24px}figcaption{font:12px var(--font-mono);color:var(--text-tertiary);margin-bottom:8px}figure svg{display:block;max-width:100%;height:auto}
</style></head><body><header><strong>ARC design assets</strong><button data-choice="system">System</button><button data-choice="light">Light</button><button data-choice="dark">Dark</button></header><main>${sections}</main><script>
const buttons = document.querySelectorAll('[data-choice]');
const apply = choice => { if (choice === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = choice; buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.choice === choice))); };
buttons.forEach(b => b.addEventListener('click', () => apply(b.dataset.choice)));
apply('system');
</script></body></html>`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'index.html'), html);
  console.log(relative(path.join(outDir, 'index.html')));
}

async function measure(args) {
  const text = args.find(arg => !arg.startsWith('--'));
  if (text === undefined) throw new Error(USAGE);
  const option = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const tokens = loadTokens().light;
  const font = `${option('weight', '400')} ${option('size', '14')}px ${tokens.get(args.includes('--mono') ? '--font-mono' : '--font-ui')}`;
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const width = await page.evaluate(([value, spec]) => { const context = document.createElement('canvas').getContext('2d'); context.font = spec; return context.measureText(value).width; }, [text, font]);
    console.log(width.toFixed(1));
  } finally { await browser.close(); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'sync' && !args.length) return sync();
  if (command === 'check') return check(args);
  if (command === 'render') return render(args);
  if (command === 'gallery' && !args.length) return gallery();
  if (command === 'measure') return measure(args);
  throw new Error(USAGE);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

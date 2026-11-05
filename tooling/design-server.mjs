import { createServer } from 'node:http';
import { readFileSync, readdirSync, watch } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { requireMainCheckout } from './coding-lane.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'design');
const html = '<!doctype html><html lang="en" data-arc-browser><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARC design canvas</title><link rel="stylesheet" href="/canvas.css"><script defer src="/canvas.js"></script></head><body><div id="root"></div></body></html>';

export async function startDesignServer({ port = Number(process.env.ARC_DESIGN_PORT ?? 5191) } = {}) {
  requireMainCheckout();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ARC_DESIGN_PORT must be an integer from 1 to 65535.');
  let revision = Date.now(), timer, watcher;
  const clients = new Set(), cache = new Map();
  const files = new Map();
  function scan(relative = '') {
    for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) scan(name);
      else if (entry.isFile() && name.endsWith('.svg')) files.set(`design/${name}`, path.join(directory, name));
    }
  }
  scan();
  const assets = () => ({ revision, assets: [...files.keys()].sort().map(file => ({ name: path.posix.basename(file, '.svg'), path: file })) });
  function svg(file, theme, inline, ancestors = new Set()) {
    if (ancestors.has(file)) throw new Error(`Circular SVG reference: ${file}`);
    const source = files.get(file);
    if (!source) throw new Error(`Unknown design asset: ${file}`);
    const chain = new Set([...ancestors, file]);
    let drawing = readFileSync(source, 'utf8').replace(/<svg\b/, `<svg data-theme="${theme}"`);
    drawing = drawing.replace(/href="(\.\.?\/[^"#]+\.svg)"/g, (_, target) => {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      // SVG images cannot load external images; inline detail can use ordinary URLs.
      return `href="${inline ? `/asset/${dependency}?theme=${theme}&amp;v=${revision}` : `data:image/svg+xml;base64,${Buffer.from(svg(dependency, theme, false, chain)).toString('base64')}`}"`;
    });
    if (inline) {
      const prefix = `asset-${Buffer.from(file).toString('base64url')}-`;
      drawing = drawing.replace(/<style>[\s\S]*?<\/style>/g, '')
        .replace(/\bid="([^"]+)"/g, (_, id) => `id="${prefix}${id}"`)
        .replace(/url\(#([^)]+)\)/g, (_, id) => `url(#${prefix}${id})`)
        .replace(/href="#([^"]+)"/g, (_, id) => `href="#${prefix}${id}"`);
      const elevation = ['sm', 'md', 'lg'].map(size => `--elev-${size}:url(#${prefix}elev-${size}-${theme})`).join(';');
      drawing = drawing.replace('<svg ', `<svg style="${elevation}" `);
    }
    return drawing;
  }
  let frontend;
  const server = createServer((request, response) => {
    try {
      if (!frontend) { response.writeHead(503, { 'Retry-After': '1' }); response.end('Design mode is starting. Reload shortly.'); return; }
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
      if (url.pathname === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        response.write(`data: ${revision}\n\n`);
        clients.add(response); response.on('close', () => clients.delete(response)); return;
      }
      const key = url.pathname + url.search;
      let entry = cache.get(key);
      if (!entry) {
        let body, type, cached = false;
        if (url.pathname === '/') { body = html; type = 'text/html'; }
        else if (url.pathname === '/manifest') { body = JSON.stringify(assets()); type = 'application/json'; }
        else if (url.pathname === '/canvas.js') { body = frontend.js; type = 'text/javascript'; }
        else if (url.pathname === '/canvas.css') { body = frontend.css; type = 'text/css'; }
        else if (url.pathname.startsWith('/asset/')) {
          const file = decodeURIComponent(url.pathname.slice('/asset/'.length));
          if (!files.has(file)) { response.writeHead(404); response.end('Unknown design asset.'); return; }
          const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
          body = svg(file, theme, url.searchParams.get('inline') === '1'); type = 'image/svg+xml'; cached = url.searchParams.get('v') === String(revision);
        } else { response.writeHead(404); response.end('Not found.'); return; }
        entry = { body: Buffer.from(body), type, cached };
        entry.gzip = gzipSync(entry.body);
        cache.set(key, entry);
      }
      const compressed = /\bgzip\b/.test(request.headers['accept-encoding'] ?? '');
      const body = compressed ? entry.gzip : entry.body;
      response.writeHead(200, { 'Content-Type': `${entry.type}; charset=utf-8`, 'Content-Length': body.length,
        'Cache-Control': entry.cached ? 'private, max-age=3600' : 'no-store', Vary: 'Accept-Encoding', ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) { response.writeHead(500, { 'Content-Type': 'text/plain' }); response.end(error.message); }
  });
  // Reserve the port before compiling, so conflicting modes fail immediately.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  let closing;
  const close = () => closing ??= (async () => {
    clearTimeout(timer); watcher?.close();
    for (const client of clients) client.end();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  })();
  try {
    const result = await build({ configFile: false, root, logLevel: 'warn', plugins: [react(), tailwindcss()],
      define: { __CONNECTOR_VERSION__: JSON.stringify('design-mode'), 'process.env.NODE_ENV': JSON.stringify('production') },
      build: { write: false, minify: true, lib: { entry: path.join(root, 'ui/design-gallery.tsx'), name: 'ArcDesignGallery', formats: ['iife'] } } });
    const output = (Array.isArray(result) ? result : [result]).flatMap(result => result.output);
    frontend = {
      js: output.filter(item => item.type === 'chunk').map(item => item.code).join('\n'),
      css: output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n'),
    };
    watcher = watch(directory, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        files.clear(); scan(); revision++; cache.clear();
        for (const client of clients) client.write(`data: ${revision}\n\n`);
      }, 100);
    });
    console.log(`DESIGN: http://127.0.0.1:${port}/`);
    return { close, url: `http://127.0.0.1:${port}/` };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error('Usage: npm run dev:design. Set ARC_DESIGN_PORT to change the port.');
  try {
    const server = await startDesignServer();
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (closing) return;
      closing = true; void server.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

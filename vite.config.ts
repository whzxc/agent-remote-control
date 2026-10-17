import { buildVersion } from './tooling/version.mjs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { devStateDir } from './tooling/dev-state.mjs';

const stateRoot = devStateDir;
const packageVersion = buildVersion();
type Endpoint = { port: number; token: string };
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  define: { __CONNECTOR_VERSION__: JSON.stringify(packageVersion) },
  plugins: [react(), {
    name: 'connector-native-preview',
    configureServer(server) {
      function ownerIdentity() {
        try { return readFileSync(path.join(stateRoot, 'web/native.json'), 'utf8'); }
        catch { return ''; }
      }
      async function endpoint(): Promise<Endpoint> {
        try {
          const info = JSON.parse(readFileSync(path.join(stateRoot, 'web/native.json'), 'utf8'));
          if (Number.isInteger(info.port) && info.port > 0 && info.port <= 65535 && typeof info.token === 'string') {
            const response = await fetch(`http://127.0.0.1:${info.port}/healthz`, { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(500) });
            if (response.ok && (await response.json()).instance === info.instance) return info;
          }
        } catch { /* The development owner may still be compiling or restarting. */ }
        throw new Error('开发后台尚未就绪，请运行 npm run dev；首次编译或 Rust 重启期间请稍候。');
      }
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) return next();
        response.setHeader('Cache-Control', 'no-store');
        if (request.headers.host !== '127.0.0.1:5187'
          || (request.headers.origin && request.headers.origin !== 'http://127.0.0.1:5187')
          || request.headers['sec-fetch-site'] === 'cross-site'
          || ((request.method !== 'GET' || request.url === '/api/config/credentials') && request.headers['x-arc-request'] !== '1')) {
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: '仅允许本机页面访问。' })); return;
        }
        void endpoint().then(async info => {
          if (response.destroyed) return;
          // Buffer a bounded JSON body so the native server receives Content-Length,
          // never chunked transfer encoding. Do not retry mutating requests.
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 16 * 1024 * 1024) {
              response.writeHead(413); response.end(); return;
            }
            chunks.push(Buffer.from(chunk));
          }
          if (response.destroyed) return;
          const body = Buffer.concat(chunks);
          const upstream = httpRequest({ hostname: '127.0.0.1', port: info.port, path: request.url, method: request.method,
            headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json', 'Content-Length': body.length } }, incoming => {
            response.writeHead(incoming.statusCode || 502, incoming.headers); incoming.pipe(response);
          });
          upstream.on('error', error => { if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); });
          // Reconnect EventSource when the native app starts, exits, or is replaced.
          // Otherwise an already-open preview stream can stay attached to its old owner.
          const owner = ownerIdentity();
          const watchOwner = ['/api/events', '/api/quota/events'].includes(request.url || '') ? setInterval(() => {
            if (ownerIdentity() !== owner) { upstream.destroy(); response.end(); }
          }, 1000) : undefined;
          response.on('close', () => { clearInterval(watchOwner); upstream.destroy(); }); upstream.end(body);
        }).catch(error => { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); });
      });
    },
  }],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./ui/index.html', import.meta.url)),
      },
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
            { name: 'motion', test: /node_modules[\\/](?:motion|motion-dom|motion-utils|framer-motion)[\\/]/ },
            { name: 'radix', test: /node_modules[\\/](?:radix-ui|@radix-ui|@floating-ui)[\\/]/ },
          ],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
});

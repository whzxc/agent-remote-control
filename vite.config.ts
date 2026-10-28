import { buildVersion } from './tooling/version.mjs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { stateDir } from './tooling/dev-state.mjs';
import { requireMainCheckout } from './tooling/coding-lane.mjs';
import { developmentPort } from './tooling/dev-identity.mjs';

const stateRoot = stateDir;
const packageVersion = buildVersion();
const devPort = developmentPort();
const devOrigin = new URL(`http://127.0.0.1:${devPort}`).origin;
const devHost = new URL(devOrigin).host;
type Endpoint = { port: number; token: string };
export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  define: { __CONNECTOR_VERSION__: JSON.stringify(packageVersion) },
  plugins: [react(), tailwindcss(), {
    name: 'connector-native-preview',
    configureServer(server) {
      requireMainCheckout();
      let checking: { owner: string; promise: Promise<Endpoint> } | undefined;
      function ownerIdentity() {
        try { return readFileSync(path.join(stateRoot, 'app/native.json'), 'utf8'); }
        catch { return ''; }
      }
      async function endpoint(): Promise<Endpoint> {
        const owner = ownerIdentity();
        if (checking?.owner === owner) return checking.promise;
        const probe = probeEndpoint(owner);
        checking = { owner, promise: probe };
        try { return await probe; }
        finally { if (checking?.promise === probe) checking = undefined; }
      }
      async function probeEndpoint(owner: string): Promise<Endpoint> {
        try {
          if (!owner) throw new Error('No Core owner is registered. Run npm run dev, or start the installed app when using npm run dev:ui.');
          const info = JSON.parse(owner);
          if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== 'string' || typeof info.instance !== 'string') {
            throw new Error('Invalid Core owner metadata. Restart Core and inspect core.log if this persists.');
          }
          const response = await fetch(`http://127.0.0.1:${info.port}/healthz`, { headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2000) });
          if (!response.ok) throw new Error(`Core health check returned HTTP ${response.status}.`);
          if ((await response.json()).instance !== info.instance || ownerIdentity() !== owner) throw new Error('Core ownership changed. Reconnect to the current Core.');
          return info;
        } catch (error) {
          if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Core health check timed out after 2 seconds. Core may be busy; retry and inspect core.log if this persists.');
          throw error;
        }
      }
      server.middlewares.use((request, response, next) => {
        if (request.url === '/__arc_dev' && request.method === 'GET' && request.headers.host === devHost) {
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ project: fileURLToPath(new URL('.', import.meta.url)), stateDirectory: stateRoot }));
          return;
        }
        if (!request.url?.startsWith('/api/')) return next();
        response.setHeader('Cache-Control', 'no-store');
        if (request.headers.host !== devHost
          || (request.headers.origin && request.headers.origin !== devOrigin)
          || request.headers['sec-fetch-site'] === 'cross-site'
          || ((request.method !== 'GET' || request.url === '/api/config/credentials') && request.headers['x-arc-request'] !== '1')) {
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'Only local pages may access this endpoint.' })); return;
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
          const watchOwner = ['/api/events', '/api/subscriptions/events', '/api/agents/activity/events'].includes(request.url || '') ? setInterval(() => {
            if (ownerIdentity() !== owner) { upstream.destroy(); response.end(); }
          }, 1000) : undefined;
          response.on('close', () => { clearInterval(watchOwner); upstream.destroy(); }); upstream.end(body);
        }).catch(error => {
          if (response.destroyed) return;
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: error.message }));
        });
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
  server: { host: '127.0.0.1', port: devPort, strictPort: true },
});

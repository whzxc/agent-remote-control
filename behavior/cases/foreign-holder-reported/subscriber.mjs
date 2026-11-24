// The guarded installed driver passes an already-connected socketpair descriptor.
// This peer has no process discovery, filesystem lock access or TCP transport.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline/promises';
import WebSocket from 'ws';

const [descriptor, threadId] = process.argv.slice(2);
const transport = new Socket({fd: Number(descriptor), readable: true, writable: true});
const ws = new WebSocket('ws://localhost/', {createConnection: () => transport, handshakeTimeout: 5000});
const pending = new Map();
let sequence = 0;

ws.on('message', bytes => {
  const message = JSON.parse(bytes);
  if (pending.has(message.id)) pending.get(message.id)(message);
  if (message.method && message.params?.threadId === threadId)
    console.log(JSON.stringify({event: message.method, threadId, turnId: message.params.turn?.id,
      monotonicNs: process.hrtime.bigint().toString()}));
});

async function call(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(method + ' timed out')), 10000);
    pending.set(id, message => {
      clearTimeout(timer);
      pending.delete(id);
      if (message.error) reject(Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({method, params, id}));
  });
}

try {
  await once(ws, 'open');
  const server = await call('initialize', {clientInfo: {name: 'handback-witness', version: '1'},
    capabilities: {experimentalApi: true}});
  if (server.codexHome !== process.env.CODEX_HOME) throw Error('MacBook daemon home mismatch');
  ws.send(JSON.stringify({method: 'initialized'}));
  const resumed = await call('thread/resume', {threadId, excludeTurns: true});
  if (resumed.thread?.id !== threadId) throw Error('Subscription setup did not return the case thread');
  console.log('Subscribed to ' + threadId + '. Keep this connection open during the owner and handback probes.');
  const prompt = createInterface({input: process.stdin, output: process.stderr});
  try { await prompt.question('Press Return on the holder side to release its own subscription.\n'); }
  finally { prompt.close(); }
  const released = await call('thread/unsubscribe', {threadId});
  assert.equal(released.status, 'unsubscribed',
    'foreign-holder-reported/holder-untouched: the original client must still have its subscription to release');
  console.log(JSON.stringify({threadId, released}));
} finally { ws.terminate(); }

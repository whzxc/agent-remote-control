import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';

const id = '11111111-1111-4111-8111-111111111111';
const missing = '22222222-2222-4222-8222-222222222222';
const target = `antigravity_${id}`;
async function setup(desktop = false) {
  const home = await mkdtemp(path.join(tmpdir(), 'arc-antigravity-desktop-'));
  const log = path.join(home, 'calls.jsonl');
  const config = path.join(home, '.gemini/config/mcp_config.json');
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, '');
  await writeFile(log, '');
  const binary = path.join(home, 'agentapi');
  await writeFile(binary, `#!${process.execPath}
const {appendFileSync}=require('node:fs');
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const emit=value=>console.log(JSON.stringify({response:value}));
if(args[0]==='get-conversation-metadata') {
 if(args[1]===${JSON.stringify(missing)}) { console.error('trajectory not found');process.exit(1); }
 emit({conversationMetadata:{metadata:{title:'Fixture'}}});
} else if(args[0]==='send-message') {
 const id=args[1].startsWith('--title=')?args[2]:args[1];
 emit({sendMessage:{recipientId:id}});
} else if(args[0]==='new-conversation') { emit({newConversation:{conversationId:${JSON.stringify(id)}}}); }
else { console.log('new-conversation get-conversation-metadata send-message'); }
`, { mode: 0o755 });
  await writeFile(path.join(home, 'agy'), `#!${process.execPath}
const {createInterface}=require('node:readline');
if(process.argv.includes('--version')) { console.log('1.4.12');process.exit(); }
if(process.argv.includes('--help')) { console.log('stream-json --conversation');process.exit(); }
createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({event:'result',result:{conversation_id:'fixture-conversation',status:'SUCCESS',response:'Finished',num_turns:1}})));
`, { mode: 0o755 });
  const fixture = await nativeControl('', {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    ARC_ANTIGRAVITY_AGENTAPI: binary,
    ...(desktop ? { ARC_ANTIGRAVITY_BIN: binary } : {}),
    PATH: home + path.delimiter + process.env.PATH,
  });
  return { ...fixture, home, config, binary,
    calls: async (): Promise<string[][]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
    async close() { await fixture.close(); await rm(home, { recursive: true, force: true }); },
  };
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= end) throw new Error(`State did not settle: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

test('Antigravity local access accepts an empty configuration and preserves other servers on reinstall', { skip: process.platform === 'win32' }, async () => {
  // Regression: a fresh zero-byte Antigravity mcp_config.json failed local installation with a JSON parse error.
  const f = await setup();
  try {
    const before = await f.api('local-access/status');
    assert.equal(before.antigravityAvailable, true);
    assert.equal(before.antigravityInstalled, false);
    const installed = await f.api('local-access/install', { target: 'antigravity' });
    assert.equal(installed.installed, true, JSON.stringify(installed));
    const sourceForIngress = (rows: any[]) => rows.find(row => row.ingressId === 'local-antigravity');
    const assertService = (source: any) => {
      assert.ok(source);
      assert.equal(source.product, 'gemini');
      assert.equal(source.platform, 'google');
      assert.equal(source.label, 'Antigravity');
    };
    const fresh = sourceForIngress((await f.api('ingress/local-antigravity')).sources);
    assertService(fresh);
    await f.api(`source/${fresh.id}`, { product: 'custom', label: 'Legacy source' }, 'PUT');
    assert.equal(sourceForIngress((await f.api('source')).sources).product, 'custom');
    const config = JSON.parse(await readFile(f.config, 'utf8'));
    assert.deepEqual(config.mcpServers['agent-remote-control'].args, ['cli', 'local-mcp', 'local-antigravity']);
    assert.ok(config.mcpServers['agent-remote-control'].command);
    config.preference = { retained: true };
    config.mcpServers.fixture = { command: 'fixture' };
    await writeFile(f.config, JSON.stringify(config));
    await f.api('ingress/local-antigravity', { enabled: false }, 'PUT');
    assert.equal((await f.api('local-access/install', { target: 'antigravity' })).installed, true);
    assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), config);
    assert.equal((await f.api('local-access/status')).antigravityInstalled, true);
    const ingress = await f.api('ingress/local-antigravity');
    assert.equal(ingress.controlSource, 'gemini');
    assertService(sourceForIngress(ingress.sources));
    assertService(sourceForIngress((await f.api('source')).sources));
    assert.equal(ingress.enabled, true);
    assert.equal(ingress.running, true);
    const guide = await f.sourceCall('local-antigravity', 'guide', {}, 'query');
    assert.equal(guide.profile.waitMode, 'push', JSON.stringify(guide));
    const { stdout } = await promisify(execFile)(path.resolve(process.env.CARGO_TARGET_DIR || 'target', 'debug/arc'), ['cli', 'skill', 'install', '--target', 'antigravity'], {
      env: { ...process.env, HOME: f.home, USERPROFILE: f.home },
    });
    assert.ok(stdout.includes('antigravity'));
    for (const skill of ['arc-setup', 'arc-local-code']) {
      assert.match(await readFile(path.join(f.home, '.gemini/skills', skill, 'SKILL.md'), 'utf8'), /^---/);
    }
  } finally { await f.close(); }
});

test('Antigravity verifies metadata before challenge and doorbell delivery and acknowledges the received code', { skip: process.platform === 'win32' }, async () => {
  // Regression: agentapi send-message creates phantom conversation directories when metadata lookup fails.
  const f = await setup();
  try {
    const absent = await f.call('notify_control', { action: 'bind', target: `conversation://${missing}` });
    assert.equal(absent.error.code, 'CLAUDE_SESSION_NOT_FOUND', JSON.stringify(absent));
    assert.ok(!(await f.calls()).some(args => args[0] === 'send-message'));
    const bound = await f.call('notify_control', { action: 'bind', target: `conversation://${id}` });
    assert.equal(bound.target, target);
    assert.equal(bound.notify.channel, 'antigravity-session');
    assert.equal(bound.verification.deliveryStatus, 'delivered', JSON.stringify(bound));
    const calls = await f.calls();
    const ping = calls.find(args => args[0] === 'send-message')!;
    assert.equal(ping[1], '--title=ARC Notification');
    const code = /◎ ping · (\S+)/.exec(ping.at(-1)!)![1];
    assert.equal((await f.call('notification_ack', { target, code })).reachability, 'verified');
    const created = await f.completed('agent_create', { agent: 'antigravity', cwd: f.home, prompt: 'Finish fixture', approval: 'approved', notify: bound.notify });
    assert.equal(created.state, 'completed', JSON.stringify(created));
    const deliveries = await until(f.calls, rows => rows.filter(args => args[0] === 'send-message').length === 2);
    const sendIndex = deliveries.findLastIndex(args => args[0] === 'send-message');
    assert.deepEqual(deliveries[sendIndex - 1], ['get-conversation-metadata', id]);
    assert.match(deliveries[sendIndex].at(-1)!, /✓ done/);
    const status = await f.call('notify_status', { target: `conversation://${id}` });
    assert.equal(status.targets[0].reachability, 'verified');
    const invalid = await f.call('notify_control', { action: 'bind', target: id });
    assert.equal(invalid.error.code, 'INVALID_CLAUDE_SESSION');
  } finally { await f.close(); }
});

test('Antigravity Desktop submits creates and resumed messages and discovers both native transcript roots', { skip: process.platform === 'win32' }, async () => {
  // Regression: Desktop-only Antigravity installations were unavailable and native transcript.jsonl conversations were omitted.
  const f = await setup(true);
  try {
    const rows = [
      { step_index: 0, source: 'user', type: 'USER_INPUT', status: 'DONE', created_at: '2026-01-01T00:00:00Z', content: '<USER_REQUEST>\nExplain the fixture\n</USER_REQUEST>' },
      { step_index: 1, source: 'planner', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: '2026-01-01T00:00:01Z', content: 'Fixture response', thinking: 'Inspect fixture', tool_calls: [{ id: 'fixture-call', name: 'Read', arguments: { path: 'fixture.txt' } }] },
    ];
    for (const [directory, session] of [['antigravity', id], ['antigravity-cli', missing]]) {
      const transcript = path.join(f.home, '.gemini', directory, 'brain', session, '.system_generated/logs/transcript.jsonl');
      await mkdir(path.dirname(transcript), { recursive: true });
      await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    const list = await f.api('agents/conversations', { agent: 'antigravity' });
    assert.equal(list.scope, 'native-and-arc-tasks');
    assert.deepEqual(new Set(list.data.map((row: any) => row.id)), new Set([id, missing]));
    assert.ok(list.data.every((row: any) => row.title === 'Explain the fixture' && row.preview === 'Explain the fixture'));
    const all = await f.api('agents/conversations', {});
    assert.equal(all.scope, 'native-and-arc-tasks');
    assert.ok(all.data.some((row: any) => row.agent === 'antigravity' && row.id === id));
    const timeline = await f.api('agents/conversations/timeline', { agent: 'antigravity', id });
    assert.equal(timeline.readOnly, true);
    assert.ok(timeline.entries.some((row: any) => row.role === 'user' && row.text === 'Explain the fixture'));
    assert.ok(timeline.entries.some((row: any) => row.role === 'assistant' && row.text === 'Fixture response'));
    assert.ok(timeline.entries.some((row: any) => row.type === 'thinking' && row.text === 'Inspect fixture'));
    assert.ok(timeline.entries.some((row: any) => row.stepIndex === 1 && row.nativeStatus === 'DONE' && row.source === 'planner'));
    const inventory = await f.api('agents');
    const agent = inventory.agents.find((row: any) => row.agent === 'antigravity');
    assert.equal(agent.available, true);
    assert.equal(agent.protocol, 'antigravity-agentapi');
    const created = await f.completed('agent_create', { agent: 'antigravity', cwd: f.home, prompt: 'Create fixture', approval: 'approved' });
    assert.equal(created.state, 'completed', JSON.stringify(created));
    const task = { agent: 'antigravity', taskId: created.taskId };
    assert.equal((await f.call('agent_read', task)).sessionId, id);
    await f.restart();
    const resumed = await f.completed('agent_send', { ...task, prompt: 'Continue fixture' });
    assert.equal(resumed.state, 'completed', JSON.stringify(resumed));
    const calls = await f.calls();
    assert.ok(calls.some(args => args[0] === 'new-conversation' && args.at(-1) === 'Create fixture'));
    assert.deepEqual(calls.at(-2), ['get-conversation-metadata', id]);
    assert.deepEqual(calls.at(-1), ['send-message', id, 'Continue fixture']);
  } finally { await f.close(); }
});

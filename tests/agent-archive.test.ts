import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';

const native = `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(r.id!==undefined)process.stdout.write(JSON.stringify({id:r.id,result:{data:[],nextCursor:null}})+'\\n');
}`;
const adapter = `import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
if(process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const pi=process.argv.includes('--mode'), sessionId=randomUUID();
const transcript=process.env.ARCHIVE_TRANSCRIPTS+'/'+sessionId+'.jsonl';
writeFileSync(transcript,JSON.stringify({type:'session',id:sessionId,timestamp:new Date().toISOString(),cwd:process.cwd()})+'\\n'+JSON.stringify({type:'message',timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:'Retained upstream evidence'}]}})+'\\n');
let prompt;
const update=text=>emit({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}});
for await (const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line);
 if(pi) { emit({id:r.id,type:'response',command:r.type,success:true,data:{sessionId,sessionFile:transcript,isStreaming:false}}); continue; }
 if(r.method==='initialize')emit({id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 else if(r.method==='session/new')emit({id:r.id,result:{sessionId}});
 else if(r.method==='session/prompt') {
  prompt=r.id;
  const text=r.params.prompt.map(p=>p.text??'').join('');
  if(text==='complete') { update('Finished.'); emit({id:prompt,result:{stopReason:'end_turn'}}); }
  else if(text==='question') emit({id:'approval',method:'session/request_permission',params:{toolCall:{toolCallId:'tool',title:'Example'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});
 } else if(r.id==='approval') { update('Answered.'); emit({id:prompt,result:{stopReason:'end_turn'}}); }
 else if(r.method==='session/cancel')emit({id:prompt,result:{stopReason:'cancelled'}});
}
if(!pi)update('Flushed on close.');
`;
async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-archive-regression-'));
  const home = path.join(directory, 'home');
  const transcripts = path.join(directory, 'transcripts');
  await Promise.all([mkdir(home), mkdir(transcripts)]);
  for (const binary of ['pi', 'opencode']) {
    await writeFile(path.join(directory, binary), `#!${process.execPath}\n${adapter}`, { mode: 0o755 });
  }
  const fixture = await nativeControl(native, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    PATH: directory + path.delimiter + process.env.PATH, ARCHIVE_TRANSCRIPTS: transcripts,
    PI_CODING_AGENT_SESSION_DIR: transcripts,
  });
  return { ...fixture, directory, transcripts, async close() {
    await fixture.close(); await rm(directory, { recursive: true, force: true });
  } };
}
async function until(read: () => Promise<any>, ready: (value: any) => boolean) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`Fixture state did not settle: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('agent archive refuses active work and interactions, then retains flushed evidence with durable replay', { skip: process.platform === 'win32' }, async () => {
  // Regression: the AX self-test cleanup gap left non-Codex Agent tasks and processes behind with no archive operation.
  const f = await setup();
  try {
    const agent = 'opencode';
    const guide = await f.call('guide', { op: 'agent_archive' });
    assert.equal(guide.op, 'agent_archive');
    assert.equal(guide.retry.mode, 'receipt');
    const created = await f.completed('agent_create', { agent, cwd: f.directory, prompt: '' });
    assert.equal(created.state, 'completed');
    const taskId = created.taskId, args = { agent, taskId };
    const other = await f.completed('agent_create', { agent, cwd: f.directory, prompt: '' });
    const pendingSend = await f.call('agent_send', { ...args, prompt: 'hold', purpose: 'self-test', notify: null, waitMs: 0 });
    await until(() => f.call('agent_read', args), t => t.status === 'running');
    const blocked = await f.completed('agent_archive', args);
    assert.equal(blocked.state, 'failed');
    assert.equal(blocked.error.code, 'ARCHIVE_ACTIVE_TURN');
    assert.match(blocked.error.message, /agent_interrupt/);
    assert.equal((await f.call('agent_read', args)).processState, 'running');
    await f.completed('agent_interrupt', args);
    await until(() => f.call('receipt', { requestId: pendingSend.requestId }), r => r.state === 'completed');
    const questionSend = await f.call('agent_send', { ...args, prompt: 'question', purpose: 'self-test', notify: null, waitMs: 0 });
    const pending = await until(() => f.call('agent_pending', args), r => r.requests?.length > 0);
    const interactionBlocked = await f.completed('agent_archive', args);
    assert.equal(interactionBlocked.error.code, 'ARCHIVE_ACTIVE_TURN');
    assert.match(interactionBlocked.error.message, /agent_respond/);
    const request = pending.requests[0];
    await f.completed('agent_respond', { ...args, interactionId: request.id, optionId: 'allow' });
    await until(() => f.call('receipt', { requestId: questionSend.requestId }), r => r.state === 'completed');
    assert.ok((await f.api('agents/conversations', { agent })).data.some((t: any) => t.id === taskId));
    assert.ok((await f.api('tasks')).records.some((t: any) => t.taskId === taskId));
    const before = await f.call('agent_read', args);
    const transcript = path.join(f.transcripts, before.sessionId + '.jsonl');
    const evidence = await readFile(transcript, 'utf8');
    const requestId = randomUUID();
    const archived = await f.completed('agent_archive', { ...args, requestId });
    assert.equal(archived.state, 'completed');
    assert.equal(archived.result.archived, true);
    const read = await f.call('agent_read', args);
    assert.equal(read.archived, true);
    assert.equal(read.processState, 'stopped');
    assert.match(read.output, /Flushed on close/);
    assert.equal(await readFile(transcript, 'utf8'), evidence);
    assert.ok(!(await f.call('agent_tasks', { agent })).tasks.some((t: any) => t.taskId === taskId));
    assert.ok(!(await f.api('agents/conversations', { agent })).data.some((t: any) => t.id === taskId));
    assert.ok(!(await f.api('tasks')).records.some((t: any) => t.taskId === taskId));
    assert.ok(!JSON.stringify(await f.api('agents/activity')).includes(taskId));
    const rejectedSend = await f.completed('agent_send', { ...args, prompt: 'complete' });
    assert.equal(rejectedSend.error.code, 'TASK_ARCHIVED');
    const wait = await f.call('agent_wait', { ...args, timeoutMs: 1 });
    assert.equal(wait.error.code, 'TASK_ARCHIVED');
    const scope = await f.call('notify_status', { threadId: taskId });
    assert.ok(JSON.stringify(scope).includes('task-archived'));
    assert.equal((await f.call('agent_read', { agent, taskId: other.taskId })).processState, 'running');
    assert.equal((await f.completed('agent_archive', { ...args, requestId: blocked.requestId })).state, 'failed');
    const replay = await f.completed('agent_archive', { ...args, requestId });
    assert.deepEqual(replay.result, archived.result);
    await f.completed('agent_archive', { agent, taskId: other.taskId });
    await f.restart();
    assert.deepEqual((await f.completed('agent_archive', { ...args, requestId })).result, archived.result);
    assert.equal((await f.completed('agent_archive', args)).result.alreadyArchived, true);
    assert.equal((await f.call('agent_read', args)).output, read.output);
    assert.ok(!(await f.api('agents/conversations', { agent })).data.some((t: any) => t.id === taskId));
  } finally { await f.close(); }
});

test('Pi archival hides native conversation duplicates and works while disabled without deleting upstream data', { skip: process.platform === 'win32' }, async () => {
  // Regression: the AX cleanup gap had no Pi archive path and skipping ARC records alone resurfaced their native transcripts.
  const f = await setup();
  try {
    const agent = 'pi';
    const created = await f.completed('agent_create', { agent, cwd: f.directory, prompt: '' });
    assert.equal(created.state, 'completed');
    const args = { agent, taskId: created.taskId };
    const task = await f.call('agent_read', args);
    const transcript = path.join(f.transcripts, task.sessionId + '.jsonl');
    const evidence = await readFile(transcript, 'utf8');
    assert.ok((await f.api('agents/conversations', { agent })).data.some((t: any) => t.id === args.taskId));
    await f.api('agents', { agent, enabled: false }, 'PUT');
    await f.api('agents', { agent: 'opencode', enabled: false }, 'PUT');
    assert.equal((await f.api('tool-catalog')).tools.find((op: any) => op.name === 'agent_archive').available, true);
    const archived = await f.completed('agent_archive', args);
    assert.equal(archived.state, 'completed');
    await f.api('agents', { agent, enabled: true }, 'PUT');
    assert.equal((await f.call('agent_read', args)).archived, true);
    const page = await f.api('agents/conversations', { agent });
    assert.ok(!page.data.some((t: any) => [args.taskId, task.sessionId].includes(t.id)));
    assert.equal(await readFile(transcript, 'utf8'), evidence);
    await f.restart();
    assert.ok(!(await f.api('agents/conversations', { agent })).data.some((t: any) => [args.taskId, task.sessionId].includes(t.id)));
  } finally { await f.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';
test('archived task filters are discoverable and listing never needs live enrichment by default', async () => {
  // Regression: archived task listing spent the live enrichment budget and omitted its filters from the shorthand.
  const f=await nativeControl(`import{createInterface}from'node:readline';for await(const l of createInterface({input:process.stdin})){const{id,method,params}=JSON.parse(l);if(id===undefined)continue;process.stdout.write(JSON.stringify(method==='thread/list'?{id,result:{data:[{id:'example',name:params.searchTerm,archived:params.archived}],nextCursor:null}}:method==='initialize'?{id,result:{}}:{id,error:{code:-1,message:'Live read must not be needed'}})+'\\n');}`);
  try {
    const page=await f.call('codex_tasks',{archived:true,searchTerm:'needle'});
    assert.equal(page.enriched,false);assert.equal(page.tasks[0].title,'needle');assert.equal(page.tasks[0].status,'archived');assert.equal(page.tasks[0].runtimeStatus,null);
    const guide=await f.call('guide',{view:'full'});const signature=guide.ops.find((o:any)=>o.op==='codex_tasks').signature;
    assert.match(signature,/archived/);assert.match(signature,/searchTerm/);assert.match(signature,/enrich/);
  }finally{await f.close();}
});

async function eventually(read: () => Promise<boolean>) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(await read(), 'Changed state must remain discoverable.');
}

test('cached task and status projections follow receipt replacement, runtime updates and deletion', async () => {
  // Regression: AX-23 idle projection reuse must preserve task freshness after real state changes.
  const f = await nativeControl('');
  const requestId = randomUUID(), threadId = randomUUID();
  let directory = '';
  const receipt = { requestId, threadId, operation: 'create', state: 'completed', backendSession: 'previous',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    task: { kind: 'create', title: 'Initial', prompt: 'Preview\nRetained prompt', input: [] }, result: {} };
  try {
    await f.restart(async state => {
      directory = state;
      await mkdir(path.join(state, 'tasks'), { recursive: true });
      await writeFile(path.join(state, `${requestId}.json`), JSON.stringify(receipt));
      await writeFile(path.join(state, 'tasks', `${threadId}.json`), JSON.stringify({ runtimeStatus: 'idle' }));
    });
    const rows = async () => (await f.api('tasks')).records;
    assert.equal((await rows())[0].task.title, 'Initial');
    await f.api('task-settings', { enabled: true }, 'PUT');
    assert.equal((await rows())[0].task.prompt, 'Preview');
    const changed = { ...receipt, state: 'unconfirmed', task: { ...receipt.task, title: 'Changed' } };
    const replacement = path.join(directory, 'replacement.json');
    await writeFile(replacement, JSON.stringify(changed));
    await rename(replacement, path.join(directory, `${requestId}.json`));
    await eventually(async () => (await rows())[0]?.task.title === 'Changed');
    assert.equal((await f.api('status')).diagnostics.checks.receipts.count, 1);
    await writeFile(path.join(directory, 'tasks', `${threadId}.json`), JSON.stringify({ runtimeStatus: 'active', title: 'Running' }));
    await eventually(async () => (await rows())[0]?.runtime.runtimeStatus === 'active');
    await rm(path.join(directory, `${requestId}.json`));
    await eventually(async () => (await rows()).length === 0);
    assert.equal((await f.api('status')).diagnostics.checks.receipts.count, 0);
  } finally { await f.close(); }
});

test('activity discovery finds a new transcript root and follows append and removal', async () => {
  // Regression: AX-23 skipping unchanged historical directory walks must still discover newly created sessions and terminal changes.
  const f = await nativeControl('');
  const thread = randomUUID();
  let sessions = '';
  try {
    await f.restart(async state => {
      const home = path.join(path.dirname(state), 'codex');
      await mkdir(home, { recursive: true });
      sessions = path.join(home, 'sessions');
    });
    const active = async () => (await f.api('agents/activity')).agents.codex?.sessions.some((s: any) => s.id === thread) ?? false;
    assert.equal(await active(), false);
    await mkdir(path.join(sessions, 'day'), { recursive: true });
    const transcript = path.join(sessions, 'day', 'rollout.jsonl');
    const event = (type: string) => JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type, turn_id: 'turn' } }) + '\n';
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n' + event('task_started'));
    await eventually(active);
    await appendFile(transcript, event('task_complete'));
    await eventually(async () => !await active());
    await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n' + event('task_started'));
    await eventually(active);
    await rm(transcript);
    await eventually(async () => !await active());
  } finally { await f.close(); }
});

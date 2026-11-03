import {spawn} from 'node:child_process';
import {appendFile,mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeControl } from './helpers/native-control.ts';

test('native writer conflicts retain recovery guidance through send, load and read', async () => {
  // Regression: native errors include the thread ID between thread and already, including nested load failures.
  const fixture = await nativeControl(`
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const {id,method,params}=JSON.parse(line); if(id===undefined)continue;
      const error = {code:-32600,message:'thread '+params?.threadId+' already has an active writer'};
      const reply = ['thread/read','thread/resume'].includes(method) ? {id,error} : {id,result:{}};
      process.stdout.write(JSON.stringify(reply)+'\\n');
    }
  `);
  try {
    const threadId = '00000000-0000-4000-8000-000000000001';
    for (const result of [
      await fixture.completed('codex_send', { threadId, prompt: 'Follow up', sendMode: 'next', resume: {} }),
      await fixture.call('codex_call', { method: 'thread/resume', params: { threadId }, waitMs: 1000 }),
      await fixture.call('codex_read', { threadId, statusOnly: true }),
    ]) {
      let value = result;
      if (value.requestId && !value.error && !value.result?.error) value = await fixture.call('receipt', {requestId:value.requestId});
      const error = value.error ?? value.result?.error;
      assert.equal(error?.code, 'THREAD_WRITER_BUSY', JSON.stringify(value));
      assert.equal(error.retryable, false);
      assert.equal(value.next.op, 'codex_owner');
      assert.ok(value.next.hint);
      assert.equal(error.ownership.state,"held");
      assert.equal(error.ownership.evidence,"native-writer-rejection");
    }
  } finally { await fixture.close(); }
});


test('Held external writers allow read-only timelines while mutations retain owner recovery', {skip:process.platform==='win32'}, async()=>{
  // Regression: completed parent-owned subagents stayed unconfirmed and their detail failed with THREAD_WRITER_BUSY.
  const directory=await realpath(await mkdtemp(path.join(tmpdir(),'arc-external-writer-')));
  const threadId='00000000-0000-4000-8000-000000000002';
  const turnId='00000000-0000-4000-8000-000000000004';
  const nextTurn='00000000-0000-4000-8000-000000000005';
  const rollout=path.join(directory,'sessions',`${threadId}.jsonl`);
  const record=(type:string,payload:unknown)=>JSON.stringify({type,timestamp:'2026-01-01T00:00:00Z',payload})+'\n';
  await mkdir(path.dirname(rollout));
  await writeFile(rollout,record('session_meta',{id:threadId,subagent_history_start_ordinal:5,source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}}})
    +record('session_meta',{id:'parent'})
    +record('event_msg',{type:'task_started',turn_id:'parent-turn'})
    +record('response_item',{type:'message',role:'user',content:[{text:'Inherited parent request'}]})
    +record('event_msg',{type:'task_complete',turn_id:'parent-turn'})
    +record('event_msg',{type:'task_started',turn_id:turnId})
    +record('response_item',{type:'message',role:'user',content:[{text:'<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'}]})
    +record('response_item',{type:'message',role:'user',content:[{text:'Review changes'}]}));
  await mkdir(path.join(directory,'thread-writer-locks'));
  const writer=spawn('python3',['-c','import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()',path.join(directory,'thread-writer-locks',threadId+'.lock')]);
  await new Promise<void>(resolve=>writer.stdout.once('data',()=>resolve()));
  const fixture=await nativeControl(`
    import {createInterface} from 'node:readline';
    for await(const line of createInterface({input:process.stdin})){
      const {id,method,params}=JSON.parse(line);if(id===undefined)continue;
      const result=method==='thread/read'?{thread:{id:params.threadId,path:${JSON.stringify(rollout)},cwd:${JSON.stringify(directory)},status:{type:'notLoaded'}}}:
        method==='thread/turns/list'?{data:[{id:${JSON.stringify(turnId)},status:'completed',items:[]}],nextCursor:null}:{};
      process.stdout.write(JSON.stringify({id,result})+'\\n');
    }
  `,{CODEX_HOME:directory,ARC_FIXTURE_DESKTOP:'1'});
  try {
    for(const statusOnly of [false,true]) {
      const result=await fixture.call('codex_read',{threadId,statusOnly});
      assert.equal(result.error.code,'THREAD_WRITER_BUSY',JSON.stringify(result));
      assert.equal(result.error.ownership.owner,'external');assert.equal(result.error.ownership.state,'held');
      if(process.platform==='darwin')assert.ok(result.error.ownership.processes.some((p:any)=>p.pid===writer.pid));
    }
    const timeline=()=>fixture.api('agents/conversations/timeline',{agent:'codex',id:threadId});
    const running=await timeline();
    assert.equal(running.readOnly,true,JSON.stringify(running));
    assert.equal(running.turnStatuses[turnId],'running');
    assert.equal(running.turnStatuses['parent-turn'],undefined);
    assert.deepEqual(running.entries.filter((entry:any)=>entry.type==='user').map((entry:any)=>entry.text),['Review changes']);
    await appendFile(rollout,record('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{text:'Review complete'}]})
      +record('event_msg',{type:'task_complete',turn_id:turnId}));
    const completed=await timeline();
    assert.equal(completed.status,'completed');
    assert.equal(completed.turnStatuses[turnId],'completed');
    assert.ok(completed.entries.some((entry:any)=>entry.text==='Review complete'));
    assert.equal((await fixture.api(`agents/timeline/${threadId}`)).status,'completed');
    assert.equal((await fixture.call('task_timeline',{agent:'codex',id:threadId})).status,'completed');
    await appendFile(rollout,record('event_msg',{type:'task_started',turn_id:nextTurn})
      +record('response_item',{type:'message',role:'user',content:[{text:'Continue review'}]}));
    const resumed=await timeline();
    assert.equal(resumed.turnStatuses[turnId],'completed');
    assert.equal(resumed.turnStatuses[nextTurn],'running');
    await appendFile(rollout,record('event_msg',{type:'turn_aborted',turn_id:nextTurn}));
    assert.equal((await timeline()).turnStatuses[nextTurn],'cancelled');
    const denied=await fixture.completed('codex_interrupt',{threadId});
    assert.equal(denied.error?.code??denied.result?.error?.code,'THREAD_WRITER_BUSY',JSON.stringify(denied));
    assert.equal((await fixture.call('codex_owner',{threadId})).state,'held');
    assert.equal(writer.exitCode,null);
  } finally {await fixture.close();writer.stdin.end();await new Promise(resolve=>writer.once('exit',resolve));await rm(directory,{recursive:true,force:true});}
});


test('Releasing an already unheld writer is a no-op before archive',async()=>{
  // Regression: codex_archive release:true refused a confirmed unheld non-connector thread.
  const fixture=await nativeControl(`import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const{id,method,params}=JSON.parse(line);if(id===undefined)continue;const result=method==='thread/read'?{thread:{id:params.threadId,status:{type:'idle'}}}:{};process.stdout.write(JSON.stringify({id,result})+'\\n');}`);
  try {
    const threadId='00000000-0000-4000-8000-000000000003';
    const release=await fixture.completed('codex_release',{threadId});assert.equal(release.result.alreadyUnheld,true);assert.equal(release.result.released,true);
    const archive=await fixture.completed('codex_archive',{threadId,release:true});assert.equal(archive.state,'completed',JSON.stringify(archive));assert.equal(archive.result.archived,true);
  }finally{await fixture.close();}
});


test('Archive release is a no-op for an idle connector retaining its native writer',{skip:process.platform==='win32'},async()=>{
  // Regression: release:true returned RELEASE_UNCONFIRMED after unsubscribe while plain native archive could finish on the same idle connector.
  const directory=await mkdtemp(path.join(tmpdir(),'arc-idle-archive-'));
  const threadId='00000000-0000-4000-8000-000000000007';
  const turnId='00000000-0000-4000-8000-000000000008';
  const fixture=await nativeControl(`import{createInterface}from'node:readline';
for await(const line of createInterface({input:process.stdin})){
 const{id,method,params}=JSON.parse(line);if(id===undefined)continue;
 const turn={id:'${turnId}',status:'completed',items:[]};let result={};
 if(method==='thread/start'||method==='thread/read')result={thread:{id:'${threadId}',cwd:params.cwd||'/tmp',status:{type:'idle'}}};
 if(method==='turn/start')result={turn};
 if(method==='thread/turns/list')result={data:[turn],nextCursor:null};
 process.stdout.write(JSON.stringify({id,result})+'\\n');
}`,{CODEX_HOME:directory});
  let writer:ReturnType<typeof spawn>|undefined;
  try {
    await fixture.api('task-settings',{autoOpenCodex:false},'PUT');
    assert.equal((await fixture.completed('codex_create',{prompt:'Idle archive fixture',thread:{cwd:'/tmp'}})).state,'completed');
    await mkdir(path.join(directory,'thread-writer-locks'));
    writer=spawn('python3',['-c','import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()',path.join(directory,'thread-writer-locks',threadId+'.lock')]);
    await new Promise<void>(resolve=>writer!.stdout!.once('data',()=>resolve()));
    assert.equal((await fixture.call('codex_owner',{threadId})).owner,'connector');
    const archived=await fixture.completed('codex_archive',{threadId,release:true});
    assert.equal(archived.state,'completed',JSON.stringify(archived));assert.equal(archived.result.archived,true);
    assert.equal(writer.exitCode,null);
    assert.equal((await fixture.call('guide',{op:'codex_archive'})).retry.mode,'receipt');
  }finally{
    await fixture.close();
    if(writer){writer.stdin!.end();await new Promise(resolve=>writer!.once('exit',resolve));}
    await rm(directory,{recursive:true,force:true});
  }
});

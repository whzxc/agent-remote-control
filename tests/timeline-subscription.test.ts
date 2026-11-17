import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeControl } from './helpers/native-control.ts';

test('unsubscribed timelines refresh newer turns and disclose incomplete observation', async () => {
  // Recurring bug class: explicit thread/unsubscribe left an old running turn cached with complete coverage after newer turns completed.
  const fixture = await nativeControl(`
    import {createInterface} from 'node:readline'; import {randomUUID} from 'node:crypto';
    const thread={id:randomUUID(),cwd:'/fixture',turns:[]}; let unsubscribed=false;
    for await(const line of createInterface({input:process.stdin})){
      const {id,method,params}=JSON.parse(line);if(id===undefined)continue; let result={};
      if(method==='thread/start')result={thread};
      if(method==='thread/unsubscribe')unsubscribed=true;
      if(method==='thread/resume')unsubscribed=false;
      if(method==='turn/start'){
        if(thread.turns.length)thread.turns.at(-1).status='completed';
        const turn={id:randomUUID(),status:thread.turns.length?'completed':'inProgress',items:[{id:randomUUID(),type:'agentMessage',text:'Observed result '+thread.turns.length}]};
        thread.turns.push(turn);result={turn};
      }
      if(method==='thread/read')result={thread:{...thread,status:{type:thread.turns.at(-1)?.status==='inProgress'?'active':'idle'}}};
      if(method==='thread/turns/list')result={data:[...thread.turns].reverse(),nextCursor:null};
      process.stdout.write(JSON.stringify({id,result})+'\\n');
    }
  `);
  try {
    await fixture.api('task-settings', {autoOpenCodex:false}, 'PUT');
    const created = await fixture.completed('codex_create', {prompt:'Start a turn'});
    assert.equal(created.state, 'completed', JSON.stringify(created));
    const threadId = created.threadId;
    const initial = await fixture.call('task_timeline', {agent:'codex',id:threadId});
    assert.equal(initial.status, 'inProgress'); assert.equal(initial.coverage.state, 'complete');
    const unsubscribe = await fixture.call('codex_call', {method:'thread/unsubscribe',params:{threadId},waitMs:1000});
    assert.equal(unsubscribe.state, 'completed');
    for (let i=0;i<2;i++) {
      const sent = await fixture.call('codex_call', {method:'turn/start',params:{threadId,input:[{type:'text',text:'Continue'}]},waitMs:1000});
      assert.equal(sent.state, 'completed');
      const timeline = await fixture.call('task_timeline', {agent:'codex',id:threadId,after:initial.cursor});
      assert.equal(timeline.status, 'completed'); assert.equal(timeline.coverage.state, 'partial');
      assert.match(timeline.coverage.reason, /native-observation-lost/);
      assert.equal(timeline.turnStatuses[sent.turnId], 'completed');
      assert.ok(timeline.entries.some((entry:any)=>entry.turnId===sent.turnId));
      const activity = await fixture.api('agents/activity');
      assert.ok(!Object.values(activity.agents).some((agent:any)=>agent.sessions.some((session:any)=>session.id===threadId)));
    }
    const first=await fixture.call('task_timeline',{agent:'codex',id:threadId});
    const same=await fixture.call('task_timeline',{agent:'codex',id:threadId});
    assert.equal(same.cursor,first.cursor);assert.equal(same.snapshotHash,first.snapshotHash);assert.deepEqual(same.entries,first.entries);
    const incremental=await fixture.call('task_timeline',{agent:'codex',id:threadId,after:first.cursor,expectedHash:first.snapshotHash});
    assert.equal(incremental.unchanged,true);assert.deepEqual(incremental.entries,[]);
    const resume = await fixture.call('codex_call', {method:'thread/resume',params:{threadId},waitMs:1000});
    assert.equal(resume.state, 'completed');
    assert.equal((await fixture.call('task_timeline', {agent:'codex',id:threadId})).coverage.state,'complete');
  } finally { await fixture.close(); }
});

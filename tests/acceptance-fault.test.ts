import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { nativeControl } from './helpers/native-control.ts';

test('Isolated faults reject real reads, expire and require a self-test thread', async () => {
  // Recurring bug class: acceptance could not deliberately exercise native read rejection on an isolated runtime path.
  const fixture = await nativeControl(`
    import {createInterface} from 'node:readline';import {randomUUID} from 'node:crypto';
    for await (const line of createInterface({input:process.stdin})) {
      const {id,method,params}=JSON.parse(line);if(id===undefined)continue;
      let result={};if(method==='thread/start')result={thread:{id:randomUUID(),cwd:params.cwd,turns:[]}};
      if(method==='turn/start')result={turn:{id:randomUUID(),status:'completed',items:[]}};
      if(method==='thread/read')result={thread:{id:params.threadId,status:{type:'idle'},turns:[]}};
      process.stdout.write(JSON.stringify({id,result})+'\\n');
    }
  `, {ARC_DEV_INSTANCE_ID:'ax3-read-fault'});
  try {
    await fixture.api('task-settings',{autoOpenCodex:false},'PUT');
    const created=await fixture.completed('codex_create',{prompt:'Self test',thread:{cwd:process.cwd()}});
    assert.equal(created.state,'completed',JSON.stringify(created));
    const reject=await fixture.call('acceptance_fault',{threadId:randomUUID(),mode:'read-rejection'});
    assert.equal(reject.error.code,'ACCEPTANCE_SELF_TEST_REQUIRED');
    assert.equal((await fixture.call('acceptance_fault',{threadId:created.threadId,mode:'read-rejection',durationMs:150})).injected,true);
    const args={method:'thread/read',params:{threadId:created.threadId,includeTurns:false}};
    const rejected=await fixture.call('codex_query',args);
    assert.equal(rejected.error.code,'THREAD_WRITER_BUSY',JSON.stringify(rejected));
    assert.equal(rejected.error.ownership.injected,true);
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal((await fixture.call('codex_query',args)).thread.id,created.threadId);
  } finally {await fixture.close();}
  const normal=await nativeControl('');
  try {assert.equal((await normal.call('acceptance_fault',{threadId:randomUUID(),mode:'clear'})).error.code,'ACCEPTANCE_FAULT_UNAVAILABLE');}
  finally {await normal.close();}
});

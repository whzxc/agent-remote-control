import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeControl} from './helpers/native-control.ts';
import {assertNextCalls} from './helpers/continuations.ts';

test('Direct CLI failures retain schema-valid recovery and fail the process', {skip:process.platform==='win32'},async()=>{
  // Regression: seven direct CLI failures discarded next while receipt failures preserved it.
  const fixture=await nativeControl(`import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {
 const {id,method}=JSON.parse(line);if(id===undefined)continue;
 process.stdout.write(JSON.stringify(['thread/read','thread/resume'].includes(method)?{id,error:{code:-32600,message:'thread already has an active writer'}}:{id,result:{}})+'\\n');
}`);
  try {
    const threadId='00000000-0000-4000-8000-000000000001';
    for(const [op,args,code] of [
      ['codex_read',{threadId},'THREAD_WRITER_BUSY'],
      ['codex_read',{threadId,view:'summary'},'THREAD_WRITER_BUSY'],
      ['codex_read',{threadId,statusOnly:true},'THREAD_WRITER_BUSY'],
      ['notify_control',{action:'verify',target:'session_011111111111111111111111'},'NOTIFICATION_TARGET_NOT_BOUND_TO_SOURCE'],
      ['notify_control',{action:'bind',target:'session_invalid'},'INVALID_CLAUDE_SESSION'],
      ['receipt',{requestId:'missing-receipt'},'INVALID_ARGUMENTS'],
      ['codex_read',{unknown:true},'INVALID_ARGUMENTS'],
      ['unknown_operation',{},'UNKNOWN_OP'],
    ] as const) {
      await assert.rejects(fixture.shell(`echo '${JSON.stringify(args)}' | arc cli control ${op} --stdin`),(error:any)=>{
        const response=JSON.parse(error.stdout);
        assert.equal(error.code,1);assert.equal(response.ok,false);assert.equal(response.error.code,code,JSON.stringify({op,args,response}));
        assertNextCalls(response);
        const missing=structuredClone(response);delete missing.next;
        assert.throws(()=>assertNextCalls(missing),/missing next/);
        return true;
      });
    }
    await assert.rejects(fixture.shell(`echo '${JSON.stringify({threadId})}' | arc cli wait --op codex_read --control --stdin --until '/runtimeStatus == "idle"' --timeout 1`),(error:any)=>{const response=JSON.parse(error.stdout);assertNextCalls(response);assert.equal(response.next.op,'codex_owner');return true;});
    await assert.rejects(fixture.shell('arc cli control --unknown'),(error:any)=>{assertNextCalls(JSON.parse(error.stdout));return true;});
  }finally{await fixture.close();}
});


test('Resume guide and validation retain the interrupted-turn guard and receipt contract',async()=>{
  // Regression: codex_resume described an optional active turn despite requiring an interrupted ID and retaining durable receipts.
  const fixture=await nativeControl('');
  try {
    const guide=await fixture.call('guide',{op:'codex_resume'});
    assert.ok(guide.inputSchema.required.includes('turnId'));
    assert.equal(guide.retry.mode,'receipt');
    const missing=await fixture.call('codex_resume',{threadId:'00000000-0000-4000-8000-000000000004'});
    assert.equal(missing.error.code,'INVALID_ARGUMENTS');
    assert.equal(missing.next.op,'guide');
  }finally{await fixture.close();}
});


test('Interrupted task reads and waits succeed through the CLI envelope',async()=>{
  // Regression: normal interruption was presented as OPERATION_FAILED with CLI exit 1.
  const threadId='00000000-0000-4000-8000-000000000005';
  const turnId='00000000-0000-4000-8000-000000000006';
  const fixture=await nativeControl(`import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) {
 const {id,method,params}=JSON.parse(line);if(id===undefined)continue;
 const turn={id:'${turnId}',status:'interrupted',items:[]};
 let result={};
 if(method==='thread/start'||method==='thread/read')result={thread:{id:'${threadId}',cwd:params.cwd||'/tmp',status:{type:'notLoaded'}}};
 if(method==='turn/start')result={turn};
 if(method==='thread/turns/list')result={data:[turn],nextCursor:null};
 process.stdout.write(JSON.stringify({id,result})+'\\n');
}`);
  try {
    await fixture.api('task-settings',{autoOpenCodex:false},'PUT');
    assert.equal((await fixture.completed('codex_create',{prompt:'Interrupted read fixture',thread:{cwd:'/tmp'}})).state,'completed');
    for(const [op,args] of [
      ['codex_read',{threadId,statusOnly:true}],['codex_wait',{threadId,turnId,timeoutMs:1000}],
      ['codex_read',{threadId,turnId,view:'summary'}],['codex_wait',{threadId,turnId,timeoutMs:1000,view:'summary'}],
    ] as const) {
      const {stdout}=await fixture.shell(`echo '${JSON.stringify(args)}' | arc cli control ${op} --stdin`);
      const response=JSON.parse(stdout);
      assert.equal(response.ok,true,JSON.stringify(response));assert.equal(response.schemaVersion,1);
      assert.equal(response.result.state,'cancelled');assert.equal(response.result.recordedStatus,'interrupted');
      assert.equal(response.result.stateScope,'turn');assert.equal(response.error,undefined);
      if('view' in args){assert.equal(response.result.arcInbox,undefined);assert.equal(response.result.turnId,turnId);}
      assertNextCalls(response);
    }
    const {stdout}=await fixture.shell(`echo '${JSON.stringify({threadId,turnId,view:'summary'})}' | arc cli wait --control --op codex_wait --stdin --until '/conditionMet==true' --timeout 2`);
    const waited=JSON.parse(stdout);assert.equal(waited.schemaVersion,1);assert.equal(waited.ok,true);
    assert.equal(waited.result.lastResult.turnId,turnId);assert.equal(waited.result.lastResult.arcInbox,undefined);
    await assert.rejects(fixture.shell(`echo '${JSON.stringify({threadId,turnId,view:'summary'})}' | arc cli wait --control --op codex_wait --stdin --until '/state=="running"' --timeout 1`),(error:any)=>{
      const timeout=JSON.parse(error.stdout);assert.equal(timeout.ok,false);assert.equal(timeout.error.code,'WAIT_TIMEOUT');
      assert.equal(timeout.error.lastResult.turnId,turnId);assert.equal(timeout.error.lastResult.arcInbox,undefined);return true;
    });
  }finally{await fixture.close();}
});

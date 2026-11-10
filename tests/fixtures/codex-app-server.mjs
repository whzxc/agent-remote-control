
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const fixtureState = process.env.ARC_FIXTURE_DATA + '/dispatch-fixture.json';
const saveFixture = saved => {
  const temporary = fixtureState + '.tmp';
  writeFileSync(temporary, JSON.stringify(saved));
  renameSync(temporary, fixtureState);
};
const counts = new Map();
let sizeRevision=0;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (!method && result) {
    const saved = JSON.parse(readFileSync(fixtureState,'utf8'));
    const row = Object.values(saved).find(r=>r.pendingId===id);
    if(row){row.answer=result;row.turns.at(-1).status='completed';delete row.pendingId;saveFixture(saved);}
    continue;
  }
  if (id === undefined) continue;
  const calls = (counts.get(method) || 0) + 1; counts.set(method, calls);
  const reply = () => {
    if (params?.fail) return emit({ id, error: { code: -32042, message: 'native fixture rejection', data: { retryable: false, detail: params.fail } } });
    if (method === 'initialize') return emit({ id, result: { userAgent: 'fixture' } });
    if (method === 'fixture/change-size-item') {sizeRevision++;return emit({id,result:{revision:sizeRevision}});}
    if (method === 'fixture/counts') return emit({ id, result: Object.fromEntries(counts) });
    if (method === 'fixture/null') return emit({ id, result: null });
    if (method === 'fixture/array') return emit({ id, result: [null, 1, { native: true }] });
    const saved = existsSync(fixtureState) ? JSON.parse(readFileSync(fixtureState, 'utf8')) : {};
    if (method === 'fixture/external-review') {
      const threadId=params.threadId,turnId=randomUUID();
      const configuration=params.known===false?{}:{model:'fixture-external-model',effort:'high',serviceTier:'priority'};
      saved[threadId]={thread:{...saved[threadId].thread,...configuration},model:'fixture-dispatch-external',externalReview:true,turns:[{id:turnId,status:'completed',items:[]},{id:randomUUID(),status:'inProgress',items:[]}],metadataReads:0};
      saveFixture(saved);return emit({id,result:{threadId,turnId,activeTurnId:saved[threadId].turns.at(-1).id}});
    }
    if (method === 'thread/list' && params.searchTerm === 'fixture-external-review') return emit({id,result:{data:Object.values(saved).filter(r=>r.externalReview).map(r=>({...r.thread,status:{type:'active'}})),nextCursor:null}});
    if (method === 'thread/start' && params.model?.startsWith('fixture-dispatch')) {
      const thread = {id:randomUUID(),cwd:params.cwd,path:params.model.includes('lazy-seed')?null:process.env.ARC_FIXTURE_DATA+'/seed-'+randomUUID()+'.jsonl'};
      if(thread.path)writeFileSync(thread.path, '{}');
      saved[thread.id] = {thread,model:params.model,turns:[],metadataReads:0,archived:false,creator:process.pid};
      saveFixture(saved);
      return emit({id,result:{thread,model:params.model}});
    }
    if (saved[params?.threadId]) {
      const row = saved[params.threadId];
      if (row.model.includes('unmaterialized') && !row.turns.length && ['thread/turns/list','thread/archive'].includes(method)) {
        row.prematureReads=(row.prematureReads||0)+1;saveFixture(saved);
        return emit({id,error:{code:-32600,message:'thread '+params.threadId+' is not materialized yet; '+method+' is unavailable before first user message'}});
      }
      if (method === 'thread/name/set') {
        row.named=true;row.thread.name=params.name;saveFixture(saved);return emit({id,result:{}});
      }
      if (method === 'thread/unsubscribe') {
        row.unsubscribed=true;saveFixture(saved);return emit({id,result:{}});
      }
      if (method === 'thread/read') {
        if(row.model.includes('lazy-seed') && !row.named)return emit({id,error:{code:-32000,message:'seed not durable until named'}});
        if(row.model.includes('lazy-seed'))row.independentReader=process.pid!==row.creator;
        if (params.includeTurns && row.model.includes('question')) return emit({id,result:{thread:{...row.thread,turns:row.turns,status:{type:row.turns.at(-1)?.status==='inProgress'?'active':'idle'}}}});
        if (params.includeTurns) return emit({id,error:{code:-32601,message:'list_turns is not supported yet'}});
        row.metadataReads++;
        saveFixture(saved);
        return emit({id,result:{thread:{...row.thread,status:{type:row.turns.at(-1)?.status==='inProgress'?'active':'idle'}}}});
      }
      if (method === 'turn/start') {
        if (row.model === 'fixture-dispatch-reject' || row.model === 'fixture-dispatch-unmaterialized-reject') return emit({id,error:{code:-32602,message:'invalid turn configuration'}});
        const overload=row.model.includes('overload') && (row.model.includes('exhausted') || row.model.includes('side-effect') || row.turns.length<2);
        row.turns.push({id:randomUUID(),status:overload?'failed':(row.model.includes('queue')||(row.model.includes('question')&&row.turns.length===0))?'inProgress':'completed',error:overload?{codexErrorInfo:'serverOverloaded',message:'Selected model is at capacity'}:null,items:overload?(row.model.includes('side-effect')?[{type:'commandExecution',status:'completed'}]:[]):[{id:randomUUID(),type:'agentMessage',status:'completed',text:'pong'}],input:params.input,model:params.model||row.model,effort:params.effort});
        saveFixture(saved);
        if(row.model==='fixture-dispatch-question-terminal')emit({method:'turn/started',params:{threadId:params.threadId,turn:row.turns.at(-1)}});
        if(row.model.includes('queue'))emit({method:'item/completed',params:{threadId:params.threadId,turnId:row.turns.at(-1).id,item:row.turns.at(-1).items[0]}});
        if(row.model.includes('question')&&row.turns.length===1) {row.pendingId='question:'+params.threadId;saveFixture(saved);emit({id:row.pendingId,method:'item/tool/requestUserInput',params:{threadId:params.threadId,turnId:row.turns.at(-1).id,questions:[{id:'q',question:'2+2?',options:[]}]}});}
        if (row.model === 'fixture-dispatch-uncertain') return process.exit(0);
        return emit({id,result:{turn:row.turns.at(-1)}});
      }
      if (method === 'turn/steer') { row.turns.at(-1).input.push(...params.input);saveFixture(saved);return emit({id,result:{turnId:row.turns.at(-1).id}}); }
      if (method === 'turn/interrupt') { if(row.turns.at(-1)?.id!==params.turnId)return emit({id,error:{code:-32600,message:'stale turn'}}); row.turns.at(-1).status='interrupted';saveFixture(saved);return emit({id,result:{}}); }
      if (method === 'fixture/finish-turn') { row.turns.at(-1).status=params.status||'completed';saveFixture(saved);return emit({id,result:{}}); }
      if (method === 'fixture/finish-with-pending') {
        row.turns.at(-1).status='completed';saveFixture(saved);
        emit({method:'turn/completed',params:{threadId:params.threadId,turn:row.turns.at(-1)}});
        return emit({id,result:{}});
      }
      if (method === 'fixture/update-turn') {
        Object.assign(row.turns.find(turn=>turn.id===params.turnId),params.patch);
        saveFixture(saved);return emit({id,result:{}});
      }
      if (method === 'thread/turns/list') {
        const rows = [...row.turns];
        if(params.sortDirection === 'desc') rows.reverse();
        const offset = Number(params.cursor || 0);
        return emit({id,result:{data:rows.slice(offset,offset+1),nextCursor:offset+1<rows.length?String(offset+1):null}});
      }
      if (method === 'thread/archive') {
        if(row.model.includes('archive-busy')) return emit({id,error:{code:-32600,message:'thread '+params.threadId+' already has an active writer'}});
        row.archived=true;saveFixture(saved);
        return emit({id,result:{}});
      }
    }
    if(params?.threadId==='review-outcomes') {
      const items=[
        {type:'agentMessage',phase:'commentary',text:'Working'},
        {type:'fileChange',status:'completed',changes:[{path:'src/example.rs',kind:{type:'update'},diff:'--- a/src/example.rs\n+++ b/src/example.rs\n@@ -1 +1 @@\n-old\n+new'}]},
        {type:'fileChange',status:'completed',changes:[{path:'src/example.rs',kind:{type:'update'},diff:'@@ -1 +1,3 @@\n unchanged\n+one\n+two'}]},
        {type:'fileChange',status:'failed',changes:[{path:'rejected.rs',diff:'@@ -0,0 +1 @@\n+no'}]},
        {type:'commandExecution',command:'cat README.md',exitCode:0,status:'completed',aggregatedOutput:'PRIVATE_COMMAND_OUTPUT'.repeat(100)},
        {type:'commandExecution',command:'npm run check',commandActions:[{type:'unknown',command:"npm run check && node --test --test-name-pattern='review|full' checks.test.ts > check.log 2>&1"}],exitCode:1,status:'completed',aggregatedOutput:'PRIVATE_COMMAND_OUTPUT'.repeat(100)+'\ntest result: FAILED. 2 passed; 1 failed; 0 ignored\n'},
        {type:'commandExecution',command:'cargo check',commandActions:[{type:'unknown',command:"cat <<'EOF'\nnpm test --not-executed\nEOF\ncargo check"}],exitCode:0,status:'completed',aggregatedOutput:''},
        {type:'agentMessage',phase:'final_answer',text:'Complete final response. '.repeat(100)},
        {type:'agentMessage',phase:'commentary',text:'After final commentary'}
      ];
      if(method==='thread/read')return emit({id,result:{thread:{id:params.threadId,cwd:'/fixture',status:{type:'idle'}}}});
      if(method==='thread/turns/list')return emit({id,result:{data:[{id:'review-turn',status:'completed',items}],nextCursor:'history-cursor'}});
    }
    if (params?.threadId === 'response-size') {
      const thread={id:'response-size',name:'Response size fixture',cwd:'/fixture/response-size',status:{type:'idle'},model:'fixture-model'};
      const items=[{id:'user',type:'userMessage',content:[{type:'text',text:'Inspect this change and explain the result. '.repeat(3)}]},...Array.from({length:8},(_,i)=>({id:'reason-'+i,type:'reasoning',summary:[],content:[]})),{id:'command',type:'commandExecution',command:'git diff --stat',exitCode:0,aggregatedOutput:' src/example.rs | 4 ++--\n'.repeat(12),status:'completed'},{id:'change',type:'fileChange',status:'completed',changes:[{path:'src/example.rs',kind:{type:'update'},diff:'@@ -1 +1 @@\n-old\n+new'}]},{id:'agent',type:'agentMessage',text:'The change is complete and the checks passed. '.repeat(9)+(sizeRevision?'Changed':'')}];
      const turns=Array.from({length:6},(_,i)=>({id:'size-turn-'+i,status:'completed',items}));
      if(method==='thread/read')return emit({id,result:{thread}});
      if(method==='thread/turns/list') {
        const rows=params.sortDirection==='desc'?[...turns].reverse():turns;
        const offset=Number(params.cursor||0),end=offset+(params.limit||6);
        return emit({id,result:{data:rows.slice(offset,end),nextCursor:end<rows.length?String(end):null}});
      }
      if(method==='thread/items/list') {
        if ('knownItemKeys' in params || 'includeItemKeys' in params) return emit({id,error:{message:'ARC parameters leaked'}});
        const rows=params.sortDirection==='desc'?[...items].reverse():items;
        const offset=Number(params.cursor||0),end=offset+(params.limit||1);
        return emit({id,result:{data:rows.slice(offset,end).map(item=>({turnId:params.turnId||'size-turn-0',item})),nextCursor:end<rows.length?String(end):null}});
      }
    }
    if (params?.threadId === 'image-pagination' || params?.threadId === 'empty-images') {
      if (method === 'thread/turns/list') return emit({id,result:{data:params.threadId === 'empty-images' ? [] : [{id:'turn-latest',items:[]}],nextCursor:null}});
      if (method === 'thread/items/list') {
        if ('view' in params || 'latest' in params || 'includeImages' in params || 'maxImages' in params) return emit({id,error:{message:'connector parameters leaked'}});
        const binding = (params.turnId || 'all') + ':' + params.sortDirection;
        const rows = [{turnId:'turn-old',item:{id:'old-first',type:'agentMessage',text:'old first'}},{turnId:'turn-latest',item:{id:'latest-first',type:'agentMessage',text:'latest first'}},{turnId:'turn-latest',item:{id:'latest-last',type:'agentMessage',text:'latest last'}}].filter(r=>!params.turnId || r.turnId===params.turnId);
        if(params.sortDirection === 'desc') rows.reverse();
        let offset=0;
        if(params.cursor) {
          const cursor=JSON.parse(params.cursor);
          if(cursor.binding!==binding) return emit({id,error:{message:'cursor binding changed'}});
          offset=cursor.offset;
        }
        const end=offset+(params.limit||1);
        return emit({id,result:{data:rows.slice(offset,end),nextCursor:end<rows.length?JSON.stringify({binding,offset:end}):null}});
      }
    }
    if (method === 'thread/list' && params.searchTerm === 'fixture-overview') {
      if ('view' in params) return emit({id,error:{message:'ARC view leaked to native API'}});
      return emit({id,result:{data:[{id:'overview-live',name:'Live',cwd:'/fixture',preview:'x'.repeat(77000),updatedAt:123,status:{type:'notLoaded'}},{id:'overview-unloaded',name:'Unloaded',cwd:'/fixture',preview:'history',status:{type:'notLoaded'}},{id:'overview-unavailable',name:'Unavailable',cwd:'/fixture',status:{type:'notLoaded'}}],nextCursor:'native-cursor'}});
    }
    if (params?.threadId?.startsWith('overview-')) {
      if(params.threadId==='overview-unavailable' && method==='thread/read')return emit({id,error:{code:-32000,message:'owner unavailable'}});
      if(method==='thread/read')return emit({id,result:{thread:{id:params.threadId,cwd:'/fixture',updatedAt:124,model:'fixture-model',status:{type:params.threadId==='overview-live'?'active':'notLoaded'}}}});
      if(method==='thread/turns/list')return emit({id,result:{data:[{id:'current-turn',status:params.threadId==='overview-live'?'inProgress':'completed'}],nextCursor:null}});
    }
    if (method === 'project/list' && existsSync(process.env.ARC_FIXTURE_DATA+'/projects-fixture.json')) return emit({id,result:{data:JSON.parse(readFileSync(process.env.ARC_FIXTURE_DATA+'/projects-fixture.json','utf8')),nextCursor:null}});
    if (method === 'model/list' || method === 'thread/list' || method === 'project/list') return emit({ id, result: { data: [], nextCursor: null } });
    if (method === 'command/exec' && params.command?.at(-1)==='fixture-signal-command') return emit({id,result:{stdout:'',stderr:'terminated',exitCode:null,signal:15}});
    if (method === 'command/exec' && params.command?.at(-1)==='fixture-failed-command') return emit({id,result:{stdout:'',stderr:'failed check',exitCode:7}});
    if (method === 'command/exec' && params.command?.at(-1)==='fixture-budget') return emit({id,result:{stdout:'é'.repeat(40),stderr:'err'.repeat(20),exitCode:0}});
    if (method === 'command/exec' && params.command?.at(-1)==='fixture-cwd') return emit({id,result:{stdout:params.cwd,stderr:'',exitCode:0}});
    if (method === 'process/spawn') {
      emit({ method: 'process/outputDelta', params: { processHandle: params.processHandle, stream: 'stdout', deltaBase64: 'b2s=' } });
      emit({ method: 'process/exited', params: { processHandle: params.processHandle, exitCode: 0 } });
    }
    if (method === 'fs/watch') emit({ method: 'fs/changed', params: { watchId: params.watchId, paths: [params.path] } });
    emit({ id, result: { method, params, echoedParams: params } });
  };
  if (method==='command/exec' && params.command?.at(-1)==='fixture-delayed') setTimeout(() => params.timeoutMs === 2000 ? reply() : emit({id,error:{code:-32602,message:'process timeout changed'}}),100);
  else if (method==='command/exec' && params.command?.at(-1)==='fixture-mcp-deadline') setTimeout(reply,46000);
  else if (params?.delay) setTimeout(reply, params.delay); else reply();
}

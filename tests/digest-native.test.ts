import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { nativeControl } from './helpers/native-control.ts';

const catalog = JSON.parse(await readFile(new URL('../native/src/catalog.json', import.meta.url), 'utf8'));
const engine = new AjvJsonSchemaValidator();
const validators = new Map(catalog.ops.map((o: any) => [o.name, engine.getValidator(o.inputSchema)]));
const payload = 'private task content 🚀 '.repeat(80);
const entries = Array.from({length: 37}, (_, i) => ({
  id: `id-${String(i).padStart(3, '0')}`, status: i === 36 ? 'failed' : 'completed', payload,
}));
const cases: {op: string; args?: any; value: any; count: number; actionable?: boolean}[] = [
  {op:'ax_list', value:{entries:entries.map((r,i)=>({...r,id:`ax-${String(i).padStart(8,'0')}-0000-4000-8000-000000000000`,status:i===36?'open':'closed',severity:'blocking'})),nextCursor:null},count:37,actionable:true},
  {op:'codex_tasks',value:{tasks:entries.map(r=>({...r,threadId:r.id,currentTurn:{turnId:'turn-a',status:r.status},pendingInteractions:r.status==='failed'?[{}]:[]})),nextCursor:null},count:37,actionable:true},
  {op:'agent_tasks',args:{agent:'pi'},value:{tasks:entries.map(r=>({...r,taskId:r.id,turnId:'turn-a'})),total:37,nextOffset:null},count:37,actionable:true},
  {op:'notify_status',value:{targets:entries.map(r=>({...r,channel:'mcp-events',target:`https://routing.invalid/${r.id}`,reachability:r.status==='failed'?'failed':'verified',pending:[]})),threads:[],subscriptions:[],deliveries:[],summary:{totalTargets:37,totalThreads:0,totalBindings:0,totalDeliveries:0,totalSubscriptions:0,hidden:{targets:0}}},count:37,actionable:true},
  {op:'board',value:{notices:entries.slice(0,36).map(r=>({...r,state:'active'})),blockers:[{...entries[36],state:'open'}],attention:{items:[],coverage:{notifications:'unavailable'}},nextCursor:null,activityCoverage:'observed'},count:37,actionable:true},
  {op:'messages',value:{messages:entries.map(r=>({...r,messageId:r.id,deliveryState:r.status==='failed'?'failed':'delivered',type:'notice',escalated:r.status==='failed'})),hasMore:false,nextCursor:'saved-owner-cursor'},count:37,actionable:true},
  {op:'events',value:{events:entries.map(r=>({...r,kind:r.status==='failed'?'receipt.stalled':'turn.terminal',resources:['project:fixture/main']})),hasMore:false,nextCursor:'saved-event-cursor',coverage:{history:'retained-window'}},count:37,actionable:true},
  {op:'src_conversations',value:{accounts:entries.map(r=>({...r,accountId:r.id,status:r.status==='failed'?'import-blocked':'signed-in',conversations:[]}))},count:37,actionable:true},
  {op:'projects',value:{projects:entries.map(r=>({...r,roots:[{path:'/fictional'}]}))},count:37},
  {op:'mcp_tools',value:{servers:[{name:'fixture',state:'failed',tools:entries.map(r=>({...r,name:r.id,description:payload,annotations:{readOnlyHint:true}}))}]},count:38,actionable:true},
  {op:'accounts',value:{accounts:entries.map(r=>({...r,health:{state:r.status==='failed'?'attention':'ready'},agentProfiles:[{agent:'codex',state:'signed-in',default:r.status==='failed'},{agent:'codex',state:'signed-in',default:false}],quota:{state:'available',windows:[{usedPercent:12.5}]},credentials:'secret-value',email:'private@example.invalid'}))},count:37,actionable:true},
  {op:'codex_thread',args:{action:'search',params:{searchTerm:'fixture'}},value:{data:entries.map(r=>({thread:{...r,status:{type:r.status==='failed'?'systemError':'idle'}},snippet:payload})),nextCursor:null},count:37,actionable:true},
  {op:'codex_thread',args:{action:'timeline',params:{threadId:'thread-a'}},value:{data:entries.map((r,i)=>({...r,type:'turnCompleted',position:i,turn_id:r.id})),nextCursor:null},count:37,actionable:true},
  {op:'codex_thread',args:{action:'backgroundTerminals/list',params:{threadId:'thread-a'}},value:{data:entries.map(r=>({...r,processId:r.id,itemId:r.id,command:payload,cwd:'/fictional',cpuPercent:2.5,rssKb:512})),nextCursor:null},count:37},
];
let directory: string;
let fixtureFile: string;
let stateDirectory: string;
let control: Awaited<ReturnType<typeof nativeControl>>;
before(async () => {
  directory=await mkdtemp(path.join(tmpdir(),'arc-digest-'));
  fixtureFile=path.join(directory,'responses.json');
  await writeFile(fixtureFile,'{}');
  control=await nativeControl(`import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const {id}=JSON.parse(line); if(id!==undefined) console.log(JSON.stringify({id,result:{}}));
}`,{ARC_FIXTURE_DIGESTS:fixtureFile});
  await control.restart(async state=>{stateDirectory=state;});
  await control.api('preferences', {values:{'mcp-services':'on'}}, 'PUT');
});
after(async () => {await control?.close();await rm(directory,{recursive:true,force:true});});
async function fixture(op: string,value: any) {await writeFile(fixtureFile,JSON.stringify({[op]:value}));}
function validateAction(action: any) {
  assert.equal(action.via,'query');
  const valid=(validators.get(action.op) as any)(action.args);
  assert.equal(valid.valid,true,JSON.stringify({action,valid}));
}
async function follow(action: any) {validateAction(action);return control.call(action.op,action.args);}
function budget(value: any) {
  assert.equal(value.view,'digest',JSON.stringify(value));
  assert.ok(Buffer.byteLength(JSON.stringify(value))<=8192);
  assert.ok(value.rows.length<=20);
  assert.ok(!('text' in value));
  assert.ok(!JSON.stringify(value).includes('private task content'));
  assert.ok(!JSON.stringify(value).includes('routing.invalid'));
  assert.ok(!JSON.stringify(value).includes('secret-value'));
  assert.ok(!JSON.stringify(value).includes('private@example.invalid'));
  for (const row of value.rows) {
    assert.equal(typeof row.id,'string'); assert.equal(typeof row.state,'string');
    if(row.summary)assert.ok(!row.summary.includes('\n'));
    validateAction(row.detail);if(row.read)validateAction(row.read);
  }
  if(value.next)validateAction(value.next);
  validateAction(value.omitted.full);
}
async function full(action: any) {
  let result=await follow(action), text=result.text;
  while(result.nextOffset!==null){result=await follow({...action,args:{...action.args,offset:result.nextOffset}});text+=result.text;}
  return JSON.parse(text);
}

test('owner digests and oversized defaults expose every snapshot row through valid MCP actions',async()=>{
  // Regression: ax-9d1b45c5 oversized list reads exposed raw JSON prefixes instead of actionable metadata.
  for(const c of cases){
    await fixture(c.op,c.value);
    const initial=await control.call(c.op,{...c.args,view:'digest'});
    budget(initial);assert.equal(initial.counts.rows.value,c.count);
    if(c.actionable)assert.equal(initial.rows[0].actionable,true,c.op);
    const allRows:any[]=[];let page=initial;
    do {
      budget(page);allRows.push(...page.rows);
      for(const r of page.rows){
        let result=await follow(r.detail);
        if(result.outputId)result=await full({via:'query',op:'control_output',args:{outputId:result.outputId,offset:0}});
        const detail=result.row;
        assert.ok(detail&&(detail.payload===payload||detail.snippet===payload||detail.tools?.length===37),`${c.op}: detail must reach its full owner row: ${JSON.stringify(result).slice(0,500)}`);
      }
      page=page.next?await follow(page.next):null;
    }while(page);
    assert.equal(allRows.length,c.count,c.op);
    assert.equal(new Set(allRows.map(r=>r.id)).size,c.count,c.op);
    const sorted=[...allRows].sort((a,b)=>Number(b.actionable)-Number(a.actionable)||(a.id<b.id?-1:a.id>b.id?1:0));
    assert.deepEqual(allRows.map(r=>r.id),sorted.map(r=>r.id));
    assert.deepEqual(await full(initial.omitted.full),c.value);
    budget(await control.call(c.op,c.args??{}));
    const explicit=await control.call(c.op,{...c.args,view:'full'});
    assert.notEqual(explicit.view,'digest');
    const guide=await control.call('guide',{op:c.op});
    assert.ok(guide.signature.includes('digest'));
  }
  await writeFile(fixtureFile,'{}');
  budget(await control.call('events',{view:'digest'}));
  budget(await control.call('board',{view:'digest'}));
});

test('digest owner pagination preserves filters and reaches the next native page',async()=>{
  // Contract: query digest next actions retain owner cursors and filtered page semantics.
  for(const c of cases.filter(c=>['ax_list','codex_tasks','agent_tasks','board','messages','events','codex_thread'].includes(c.op))){
    const first={...c.value,...(c.op==='agent_tasks'?{nextOffset:37}:{nextCursor:'opaque-upstream',hasMore:true})};
    await fixture(c.op,first);
    let page=await control.call(c.op,{...c.args,view:'digest'});
    assert.equal(page.counts.rows.kind,'bounded');
    while(page.omitted.rows.value>0)page=await follow(page.next);
    const next=page.next;assert.ok(next,c.op);validateAction(next);
    // The owner changes between snapshot pages; retained rows stay immutable.
    const last={...c.value,nextCursor:null,nextOffset:null,hasMore:false};
    const expect={...c.args,view:'digest',...(c.op==='agent_tasks'?{offset:37}:c.op==='codex_thread'?{params:{...c.args.params,cursor:'opaque-upstream'}}:{[c.op==='events'?'since':'cursor']:'opaque-upstream'})};
    await writeFile(fixtureFile,JSON.stringify({[c.op]:last,expect}));
    const continued=await follow(next);budget(continued);assert.equal(continued.counts.rows.value,c.count);
    assert.notEqual(continued.revision,page.revision);
  }
});

test('oversized opaque identities retain JSON, detail access and UTF-16 full continuation',async()=>{
  // Regression: a single oversized list row overflowed into an unusable sliced JSON prefix.
  const value={projects:[{id:'oversized-'+ '🧪'.repeat(6000),status:'registered',payload}]};
  await fixture('projects',value);
  const digest=await control.call('projects',{view:'digest'});budget(digest);
  assert.equal(digest.rows.length,1);assert.equal(digest.rows[0].id,(await control.call('projects',{view:'digest'})).rows[0].id);
  const row=await follow(digest.rows[0].detail);
  assert.equal(row.row.id,value.projects[0].id);
  assert.deepEqual(await full({...digest.omitted.full,args:{...digest.omitted.full.args,length:1024}}),value);
});

test('expired digest and full-output cursors return schema-valid restart actions',async()=>{
  // Contract: temporary digest cursors and control_output expiry expose actionable restart errors.
  await fixture('projects',cases.find(c=>c.op==='projects')!.value);
  const digest=await control.call('projects',{view:'digest'});
  const old=new Date(Date.now()-3_700_000);
  await utimes(path.join(stateDirectory,'outputs',digest.revision+'.digest'),old,old);
  const expired=await follow(digest.next);
  assert.equal(expired.error.code,'DIGEST_CURSOR_EXPIRED');
  const output=await follow(digest.omitted.full);
  assert.equal(output.error.code,'OUTPUT_EXPIRED',JSON.stringify(output));budget(await follow(output.next));budget(await follow(expired.next));
});

test('remote query and CLI both return bounded digests without changing frozen tools',async()=>{
  // Contract: query and CLI control share digest projection and preserve the frozen MCP tool envelopes.
  await fixture('projects',cases.find(c=>c.op==='projects')!.value);
  await control.restart(async state=>{
    await mkdir(path.join(state,'ingresses/default'),{recursive:true});
    await writeFile(path.join(state,'ingresses/index.json'),'["default"]');
    await writeFile(path.join(state,'ingresses/default/config.json'),JSON.stringify({id:'default',name:'Fixture',controlSource:'chatgpt',transport:'openai-tunnel',auth:'openai',enabled:true,toolPolicy:'all',config:{}}));
    await writeFile(path.join(state,'ingresses/default/secrets.json'),JSON.stringify({apiKey:'',cloudflareToken:'',ngrokAuthtoken:''}));
  });
  const remote=await control.sourceCall('default','projects',{},'query');budget(remote);
  const next=remote.next;const continued=await control.sourceCall('default',next.op,next.args,'query');budget(continued);
  const wrongSource=await control.call(next.op,next.args);assert.equal(wrongSource.error.code,'DIGEST_SCOPE_CHANGED');
  const cli=await control.shell(`arc cli control projects`);
  const result=JSON.parse(cli.stdout);budget(result.result??result.structuredContent?.result??result);
});

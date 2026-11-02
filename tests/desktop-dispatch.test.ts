import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { appendFile, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeControl } from './helpers/native-control.ts';

test('Desktop and connector owners dispatch FIFO and steer only a confirmed native turn', { skip: process.platform !== 'darwin' }, async () => {
  // Regression: Desktop handoff after connector restart lost resume notifications; optimistic turns also broke FIFO/steering.
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-owner-'));
  const dataFile = path.join(directory, 'native.json');
  const openFile = path.join(directory, "opened-url");
  const desktopThread = randomUUID(), desktopTurn = randomUUID();
  const read = () => JSON.parse(readFileSync(dataFile, 'utf8'));
  const save = (data: any) => { writeFileSync(dataFile + '.tmp', JSON.stringify(data)); renameSync(dataFile + '.tmp', dataFile); };
  save({ [desktopThread]: { id: desktopThread, cwd: directory, turns: [{ id: desktopTurn, status: 'inProgress', items: [], input: [] }], phantom: false } });
  await mkdir(path.join(directory, 'ipc'));
  const sockets = new Set<Socket>();
  let revision = 0;
  const send = (socket: Socket, value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); socket.write(Buffer.concat([header, bytes])); };
  const snapshot = (socket: Socket, thread: string) => {
    const row = read()[thread], entities = Object.fromEntries(row.turns.map((turn: any) => [turn.id, { ...turn, turnId: turn.id }]));
    // A real native turn and an unconfirmed Desktop UI placeholder coexist.
    if (row.phantom) entities.placeholder = { turnId: null, status: 'inProgress', items: [] };
    const state = { id: thread, cwd: directory, rolloutPath: row.path, requests: row.requests || [], threadRuntimeStatus: { type: row.turns.at(-1)?.status === 'inProgress' ? 'active' : 'idle' }, latestModel: 'fixture-model',
      turnHistory: { kind: 'canonical', history: { isComplete: true, entitiesByKey: entities, islands: [{ newerBoundary: { status: 'exhausted' }, entries: Object.keys(entities).map(value => ({ value })) }] } } };
    send(socket, { type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'fixture-owner', params: { hostId: 'local', conversationId: thread, change: { type: 'snapshot', revision: ++revision, conversationState: state } } });
  };
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, size + 4).toString()); buffer = buffer.subarray(size + 4);
        const { method, params } = request, thread = params?.conversationId;
        if (method === 'thread-stream-following-changed') { snapshot(socket, thread); continue; }
        let result: unknown = {};
        if (method === 'initialize') result = { clientId: 'fixture-follower' };
        else if (method === 'thread-owner-discovery') {
          if (thread !== desktopThread && !read()[thread]?.detached && (!existsSync(openFile) || !readFileSync(openFile,'utf8').endsWith(thread))) continue;
          result = {};
        }
        else if (method === 'thread-follower-update-thread-settings') result = { applied: true };
        else if (method === 'thread-follower-start-turn') {
          const data = read(), turn = { id: randomUUID(), status: 'inProgress', items: [], input: params.turnStart.request.input };
          data[thread].turns.push(turn); save(data); result = { result: { turn } }; snapshot(socket, thread);
        } else if (method === 'thread-follower-interrupt-turn') {
          const data=read(); data[thread].turns.at(-1).status='interrupted'; save(data); result={ok:true}; snapshot(socket,thread);
        } else if (['thread-follower-command-approval-decision','thread-follower-submit-user-input'].includes(method)) {
          const data=read(); data[thread].requests=data[thread].requests.filter((row:any)=>row.id!==params.requestId); save(data); result={ok:true}; snapshot(socket,thread);
        } else if (method === 'thread-follower-steer-turn') {
          const data = read();
          if (data[thread].phantom) {
            send(socket, { type: 'response', requestId: request.requestId, handledByClientId: 'fixture-owner', resultType: 'error', error: 'thread-follower-steer-turn-timeout' }); continue;
          }
          const turn = data[thread].turns.at(-1); turn.input.push(...params.input); save(data); result = { result: { turnId: turn.id } }; snapshot(socket, thread);
        }
        send(socket, { type: 'response', requestId: request.requestId, handledByClientId: 'fixture-owner', resultType: 'success', result });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path.join(directory, 'ipc/ipc.sock'), resolve));
  const fixture = await nativeControl(`
    import { createInterface } from 'node:readline'; import {readFileSync,writeFileSync,renameSync} from 'node:fs'; import {randomUUID} from 'node:crypto';
    const file=process.env.ARC_OWNER_DATA, save=data=>{writeFileSync(file+'.rpc',JSON.stringify(data));renameSync(file+'.rpc',file);};
    for await (const line of createInterface({input:process.stdin})) {
      const {id,method,params}=JSON.parse(line); if(id===undefined)continue;
      const data=JSON.parse(readFileSync(file,'utf8')); let row=data[params?.threadId],result={};
      if(row?.detached && ['thread/resume','turn/start','turn/steer','turn/interrupt'].includes(method)){process.stdout.write(JSON.stringify({id,error:{code:-32600,message:'thread '+params.threadId+' already has an active writer'}})+'\\n');continue;}
      if(method==='thread/start'){const threadId=randomUUID();row=data[threadId]={id:threadId,cwd:params.cwd,turns:[]};save(data);result={thread:row};}
      if(method==='thread/read')result={thread:{...row,status:{type:row?.detached?'notLoaded':row?.turns.at(-1)?.status==='inProgress'?'active':'idle'}}};
      if(method==='thread/turns/list')result={data:[...row.turns].reverse().slice(0,params.limit),nextCursor:null};
      if(method==='turn/start'){const turn={id:randomUUID(),status:'inProgress',items:[],input:params.input};row.turns.push(turn);save(data);result={turn};}
      if(method==='turn/steer'){row.turns.at(-1).input.push(...params.input);save(data);result={turnId:row.turns.at(-1).id};}
      process.stdout.write(JSON.stringify({id,result})+'\\n');
    }
  `, { CODEX_HOME: directory, ARC_OWNER_DATA: dataFile, ARC_FIXTURE_DESKTOP: '1', ARC_FIXTURE_OPEN_FILE:openFile, ARC_DEV_INSTANCE_ID: 'ax3-fault-test' });
  const waitQueue = async (threadId: string, queueId: string, state: string) => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const row = (await fixture.call('codex_queue', {threadId, queueId})).items[0];
      if (row.state === state) return row;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(JSON.stringify(await fixture.call('codex_queue', {threadId, queueId})));
  };
  try {
    const fresh = await fixture.completed('codex_create',{prompt:'Fresh Desktop turn',thread:{cwd:directory}});
    assert.equal(fresh.state,'completed',JSON.stringify(fresh));
    assert.equal((await fixture.call('codex_query',{method:'thread/read',params:{threadId:fresh.threadId,includeTurns:true}})).thread.turns.length,1);
    assert.equal((await fixture.completed('codex_send', {threadId:desktopThread,prompt:'Establish self-test dispatch',sendMode:'steer'})).state, 'completed');
    const queued = await fixture.completed('codex_send', { threadId: desktopThread, prompt: 'After completion', sendMode: 'next' });
    assert.equal(queued.dispatchMode, 'queued');
    const injected = await fixture.call('acceptance_fault', {threadId:desktopThread,mode:'placeholder'});
    assert.equal(injected.injected, true, JSON.stringify(injected));
    const rejected = await fixture.call('codex_queue_control', {threadId:desktopThread, queueId:queued.queueId, action:'promote'});
    assert.equal(rejected.error.code, 'DESKTOP_STEER_UNAVAILABLE');
    assert.equal((await fixture.call('codex_queue', {queueId:queued.queueId})).items[0].state, 'queued');
    for (const sendMode of ['steer', 'auto', undefined]) {
      const result = await fixture.completed('codex_send', {threadId:desktopThread, prompt:'Steer', ...(sendMode ? {sendMode} : {})});
      assert.equal(result.error?.code ?? result.result?.error?.code, 'DESKTOP_STEER_UNAVAILABLE');
    }
    assert.equal((await fixture.call('acceptance_fault', {threadId:desktopThread,mode:'clear'})).injected, false);
    let data = read(); data[desktopThread].turns.at(-1).status = 'completed'; save(data);
    for (const socket of sockets) snapshot(socket, desktopThread);
    assert.equal((await waitQueue(desktopThread, queued.queueId, 'sent')).state, 'sent');
    data = read(); data[desktopThread].phantom = false; save(data);
    for (const socket of sockets) snapshot(socket, desktopThread);
    await fixture.api('task-settings', {autoOpenCodex:false}, 'PUT');
    const created = await fixture.completed('codex_create', {prompt:'Start', thread:{cwd:directory}});
    assert.equal(created.state, 'completed', JSON.stringify(created));
    for (const threadId of [desktopThread, created.threadId]) {
      const queue = await fixture.completed('codex_send', {threadId, prompt:'Promote once', sendMode:'queue'});
      const promoted = await fixture.call('codex_queue_control', {threadId, queueId:queue.queueId, action:'promote'});
      assert.equal(promoted.changed, 1, JSON.stringify(promoted));
      await waitQueue(threadId, queue.queueId, 'steered');
      for (const sendMode of ['steer', 'auto', undefined]) {
        const result = await fixture.completed('codex_send', {threadId, prompt:'Steer input', ...(sendMode ? {sendMode} : {})});
        assert.equal(result.state, 'completed', JSON.stringify(result)); assert.equal(result.dispatchMode, 'steered');
      }
      const next = await fixture.completed('codex_send', {threadId, prompt:'FIFO input', sendMode:'next'});
      assert.equal(next.dispatchMode, 'queued');
      const state = read(); state[threadId].turns.at(-1).status = 'completed'; save(state);
      if (threadId === desktopThread) for (const socket of sockets) snapshot(socket, threadId);
      const sent = await waitQueue(threadId, next.queueId, 'sent');
      const turns = await fixture.call('codex_call', {method:'thread/turns/list', params:{threadId,limit:1,sortDirection:'desc'}, waitMs:1000});
      assert.equal(turns.result.data[0].id, sent.turnId);
    }
    // A former connector thread remains fully controllable through the Desktop writer.
    const detached = read(); detached[created.threadId].detached = true;
    detached[created.threadId].turns.at(-1).status = 'completed'; save(detached);
    await mkdir(path.join(directory, 'thread-writer-locks'));
    const writer = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()', path.join(directory, 'thread-writer-locks', created.threadId + '.lock')]);
    await new Promise<void>(resolve => writer.stdout.once('data', () => resolve()));
    try {
      const observed = await fixture.call('codex_wait', {threadId:created.threadId, timeoutMs:5000});
      assert.equal(observed.state, 'completed', JSON.stringify(observed));
      assert.equal(observed.runtimeSource, 'codex-desktop-owner');
      const release = await fixture.completed('codex_release', {threadId:created.threadId});
      assert.equal(release.error?.code, 'WRITER_RELEASE_REQUIRES_OWNER', JSON.stringify(release));
      const owner = await fixture.call('codex_owner', {threadId:created.threadId});
      assert.equal(owner.owner, 'desktop'); assert.equal(owner.state, 'held');
      const sentDesktop=await fixture.completed('codex_send',{threadId:created.threadId,prompt:'Control-source intent after handoff',sendMode:'next'});
      assert.equal(sentDesktop.state,'completed',JSON.stringify(sentDesktop));
      assert.equal(sentDesktop.executionOwner,'desktop'); assert.equal(sentDesktop.dispatchMode,'new-turn');
      const steeredDesktop=await fixture.completed('codex_send',{threadId:created.threadId,prompt:'Steer through Desktop',sendMode:'steer'});
      assert.equal(steeredDesktop.state,'completed',JSON.stringify(steeredDesktop)); assert.equal(steeredDesktop.turnId,sentDesktop.turnId);
      for (const method of ['item/commandExecution/requestApproval','item/tool/requestUserInput']) {
        const approval=method.includes('requestApproval');
        const state=read(); state[created.threadId].requests=[{id:approval?1:2,method,params:{turnId:sentDesktop.turnId,command:'true',questions:[{id:'q',question:'Choose',options:[{label:'A'}]}]}}];save(state);
        for(const socket of sockets)snapshot(socket,created.threadId);
        const pending=await fixture.call('codex_pending',{threadId:created.threadId});
        assert.equal(pending.requests.length,1,JSON.stringify(pending));
        const answer=await fixture.completed('codex_respond',{id:pending.requests[0].responseId,backendSession:pending.backendSession,result:approval?{decision:'accept'}:{answers:{q:{answers:['A']}}}});
        assert.equal(answer.state,'completed',JSON.stringify(answer));
        assert.equal((await fixture.call('codex_pending',{threadId:created.threadId})).requests.length,0);
      }
      const staleCallback=await fixture.completed('codex_respond',{id:'stale-connector-callback',backendSession:randomUUID(),result:{decision:'accept'}});
      assert.equal(staleCallback.error.code,'STALE_INTERACTION'); assert.equal(staleCallback.next.op,'codex_pending');
      const queueAfterHandoff=await fixture.completed('codex_send',{threadId:created.threadId,prompt:'Queue after handoff',sendMode:'queue'});
      const nextAfterHandoff=await fixture.completed('codex_send',{threadId:created.threadId,prompt:'Next after handoff',sendMode:'next'});
      assert.equal(queueAfterHandoff.dispatchMode,'queued'); assert.equal(nextAfterHandoff.dispatchMode,'queued');
      const interruptedDesktop=await fixture.completed('codex_interrupt',{threadId:created.threadId,turnId:sentDesktop.turnId});
      assert.equal(interruptedDesktop.state,'completed',JSON.stringify(interruptedDesktop));
      await fixture.call('codex_queue_control',{threadId:created.threadId,action:'cancel'});
      const remainsDesktop=await fixture.call('codex_owner',{threadId:created.threadId});
      assert.equal(remainsDesktop.owner,'desktop');assert.equal(remainsDesktop.state,'held');
    } finally { writer.stdin.end(); await new Promise(resolve => writer.once('exit', resolve)); }
    await fixture.api('task-settings', {notificationsEnabled:false}, 'PUT');
    const target = 'session_010000000000000000000009';
    const interrupted = await fixture.completed('codex_create', {prompt:'Resume fixture task', thread:{cwd:directory}, notify:{channel:'claude-session',target}});
    assert.equal(interrupted.state, 'completed', JSON.stringify(interrupted));
    const successor = randomUUID();
    const historyPath = path.join(directory, 'sessions', 'resume.jsonl');
    await mkdir(path.dirname(historyPath));
    const ended = Math.floor(Date.now() / 1000) - 2000;
    const history = [
      {type:'session_meta',payload:{id:interrupted.threadId}},
      {type:'event_msg',payload:{type:'task_started',turn_id:interrupted.turnId}},
      {type:'event_msg',payload:{type:'turn_aborted',turn_id:interrupted.turnId,completed_at:ended}},
      {type:'event_msg',payload:{type:'task_started',turn_id:successor,started_at:ended+18,turn_attribution:{turn_trigger:'resume_interrupted_task'}}},
      {type:'response_item',payload:{role:'user',content:[{type:'input_text',text:'<environment_context>\n  <current_date>2000-01-01</current_date>\n</environment_context>'}]}},
      {type:'turn_context',payload:{turn_id:successor,cwd:directory,model:'fixture-model',effort:'high',service_tier:null}},
      {type:'event_msg',payload:{type:'task_complete',turn_id:successor,completed_at:ended+100}},
    ];
    await writeFile(historyPath, history.map(row=>JSON.stringify(row)).join('\n')+'\n');
    const resumed = read(), row = resumed[interrupted.threadId];
    row.turns.at(-1).status = 'interrupted'; row.detached = true; row.path = await realpath(historyPath);
    row.turns.push({id:successor,status:'completed',items:[{type:'agentMessage',text:'Done',status:'completed'}]}); save(resumed);
    const desktopWriter = spawn('python3', ['-c', 'import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()', path.join(directory, 'thread-writer-locks', interrupted.threadId + '.lock')]);
    await new Promise<void>(resolve=>desktopWriter.stdout.once('data',resolve));
    try {
      await fixture.restart();
      const status = async () => fixture.call('notify_status',{threadId:interrupted.threadId,all:true});
      let report: any;
      const deadline = Date.now()+20000;
      do { report=await status(); if(report.deliveries?.filter((d:any)=>d.kind!=='handoff').length===2)break; await new Promise(resolve=>setTimeout(resolve,100)); } while(Date.now()<deadline);
      assert.equal(report.deliveries.filter((d:any)=>d.kind!=='handoff').length,2,JSON.stringify(report));
      assert.deepEqual(report.deliveries.filter((d:any)=>d.kind!=='handoff').map((d:any)=>d.kind).sort(),['completed','interrupted']);
      assert.ok(report.threads[0].turns.some((turn:any)=>turn.turnId===successor && turn.target===target));
      assert.equal(report.deliveries.filter((d:any)=>d.kind==='handoff').length,1);
      assert.equal(report.threads[0].ownership.currentOwner,'desktop');
      assert.ok(report.threads[0].diagnosis.reasons.includes('ownership-moved-to-desktop'));
      const owner = await fixture.call('codex_owner',{threadId:interrupted.threadId});
      assert.equal(owner.history.at(-1).to,'desktop');
      const timeline=await fixture.call('task_timeline',{agent:'codex',id:interrupted.threadId});
      assert.equal(timeline.ownership.currentOwner,'desktop');
      const eventIds=report.deliveries.map((d:any)=>d.eventId).sort();
      await fixture.restart();
      await new Promise(resolve=>setTimeout(resolve,2500));
      const replayed=await status();
      assert.deepEqual(replayed.deliveries.map((d:any)=>d.eventId).sort(),eventIds);
      assert.equal(replayed.targets[0].tokens,report.targets[0].tokens);
      assert.equal(replayed.targets[0].breaker,report.targets[0].breaker);
      assert.equal((await fixture.call('codex_owner',{threadId:interrupted.threadId})).owner,'desktop');
      const continuedOrigin=await fixture.api('tasks/control',{op:'codex_send',args:{threadId:interrupted.threadId,prompt:'Continue the source-owned task',purpose:'task',sendMode:'next',requestId:randomUUID()}});
      assert.equal(continuedOrigin.state,'completed',JSON.stringify(continuedOrigin));
      assert.equal(continuedOrigin.executionOwner,'desktop');
      const originStatus=await status();
      assert.ok(originStatus.threads[0].turns.some((turn:any)=>turn.turnId===continuedOrigin.turnId && turn.target===target));
      const archivedPath=path.join(directory,'archived_sessions','resume.jsonl');
      await mkdir(path.dirname(archivedPath)); await writeFile(archivedPath,history.map(row=>JSON.stringify(row)).join('\n')+'\n');
      const archived=read(); archived[interrupted.threadId].path=await realpath(archivedPath); archived[interrupted.threadId].turns.at(-1).status='completed';save(archived);
      for(const socket of sockets)snapshot(socket,interrupted.threadId);
      const archiveDeadline=Date.now()+10000; let archiveStatus:any;
      do {archiveStatus=await status(); if(archiveStatus.threads[0].turns.every((turn:any)=>turn.diagnosis.scope.endedBy==='thread-archived'))break; await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<archiveDeadline);
      assert.ok(archiveStatus.threads[0].turns.every((turn:any)=>turn.diagnosis.scope.endedBy==='thread-archived'),JSON.stringify(archiveStatus));
    } finally {desktopWriter.stdin.end(); await new Promise(resolve=>desktopWriter.once('exit',resolve));}
    const action = await fixture.completed('codex_create',{prompt:'ARC resume fixture',thread:{cwd:directory},notify:{channel:'claude-session',target}});
    const actionData=read(); actionData[action.threadId].turns.at(-1).status='interrupted'; save(actionData);
    const requestId=randomUUID();
    const recovered=await fixture.completed('codex_resume',{threadId:action.threadId,turnId:action.turnId,requestId});
    assert.equal(recovered.state,'completed',JSON.stringify(recovered));
    assert.equal(recovered.result.resumedFrom,action.turnId);
    assert.notEqual(recovered.turnId,action.turnId);
    const replay=await fixture.completed('codex_resume',{threadId:action.threadId,turnId:action.turnId,requestId});
    assert.equal(replay.turnId,recovered.turnId);
    const stale=await fixture.completed('codex_resume',{threadId:action.threadId,turnId:action.turnId});
    assert.equal(stale.error.code,'RESUME_TURN_ADVANCED',JSON.stringify(stale));
    const actionStatus=await fixture.call('notify_status',{threadId:action.threadId,all:true});
    assert.ok(actionStatus.threads[0].turns.some((turn:any)=>turn.turnId===recovered.turnId && turn.target===target));
    const desktopAction=read(); desktopAction[action.threadId].turns.at(-1).status='interrupted'; desktopAction[action.threadId].detached=true; save(desktopAction);
    const actionWriter=spawn('python3',['-c','import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); sys.stdin.read()',path.join(directory,'thread-writer-locks',action.threadId+'.lock')]);
    await new Promise<void>(resolve=>actionWriter.stdout.once('data',resolve));
    try {
      const fromPanel=await fixture.api('tasks/control',{op:'codex_resume',args:{threadId:action.threadId,turnId:recovered.turnId,requestId:randomUUID()}});
      assert.equal(fromPanel.state,'completed',JSON.stringify(fromPanel));
      assert.equal(fromPanel.result.executionOwner,'desktop');
      const stillOwned=await fixture.call('codex_owner',{threadId:action.threadId});
      assert.equal(stillOwned.owner,'desktop'); assert.equal(stillOwned.state,'held');
      await fixture.call('notify_control',{action:'rebind',threadId:action.threadId,target:null});
      const unbound=await fixture.completed('codex_resume',{threadId:action.threadId,turnId:fromPanel.turnId});
      assert.equal(unbound.error.code,'RESUME_SOURCE_MISMATCH',JSON.stringify(unbound));
    } finally {actionWriter.stdin.end(); await new Promise(resolve=>actionWriter.once('exit',resolve));}
    await fixture.api('task-settings',{codexRetryInitialSeconds:3600},'PUT');
    const failedDuringDowntime=await fixture.completed('codex_create',{prompt:'Capacity failure during downtime',thread:{cwd:directory},model:'fixture-model',notify:{channel:'claude-session',target}});
    const capacity=read(); capacity[failedDuringDowntime.threadId].turns.at(-1).status='failed';
    capacity[failedDuringDowntime.threadId].turns.at(-1).error={codexErrorInfo:'serverOverloaded'};save(capacity);
    await fixture.restart();
    const capacityDeadline=Date.now()+15000;
    let capacityStatus:any;
    do { capacityStatus=await fixture.call('notify_status',{threadId:failedDuringDowntime.threadId,all:true});
      if(capacityStatus.deliveries.some((d:any)=>d.kind==='failed') && capacityStatus.threads[0].diagnosis.retry.status==='scheduled')break;
      await new Promise(resolve=>setTimeout(resolve,100));
    } while(Date.now()<capacityDeadline);
    assert.equal(capacityStatus.deliveries.filter((d:any)=>d.kind==='failed').length,1,JSON.stringify(capacityStatus));
    assert.equal(capacityStatus.threads[0].diagnosis.retry.status,'scheduled',JSON.stringify(capacityStatus));
    await fixture.restart();
    await new Promise(resolve=>setTimeout(resolve,1000));
    const capacityReplay=await fixture.call('notify_status',{threadId:failedDuringDowntime.threadId,all:true});
    assert.equal(capacityReplay.deliveries.filter((d:any)=>d.kind==='failed').length,1);
  } finally { await fixture.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, {recursive:true,force:true}); }
});

test('AX unheld thread reads recover from silent Desktop discovery', {skip:process.platform!=='darwin'}, async()=>{
  // Regression: AX-05 an unheld persisted thread could not be read when Desktop never answered owner discovery.
  const directory=await mkdtemp(path.join(tmpdir(),'arc-unheld-'));
  await mkdir(path.join(directory,'ipc'));
  const sockets=new Set<Socket>();
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
    socket.on('data',bytes=>{
      buffer=Buffer.concat([buffer,bytes]);
      while(buffer.length>=4 && buffer.length>=buffer.readUInt32LE()+4){
        const size=buffer.readUInt32LE(),request=JSON.parse(buffer.subarray(4,size+4).toString());buffer=buffer.subarray(size+4);
        if(request.method!=='initialize')continue;
        const payload=Buffer.from(JSON.stringify({type:'response',requestId:request.requestId,handledByClientId:'silent-owner',resultType:'success',result:{clientId:'fixture-follower'}}));
        const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);socket.write(Buffer.concat([header,payload]));
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(path.join(directory,'ipc/ipc.sock'),resolve));
  const threadId=randomUUID();
  const fixture=await nativeControl(`
    import {createInterface} from 'node:readline';
    for await(const line of createInterface({input:process.stdin})){
      const {id,method,params}=JSON.parse(line);if(id===undefined)continue;
      let result={};
      if(method==='thread/read')result={thread:{id:params.threadId,cwd:process.env.CODEX_HOME,status:{type:'idle'},model:'persisted-model'}};
      if(method==='thread/turns/list')result={data:[],nextCursor:null};
      process.stdout.write(JSON.stringify({id,result})+'\\n');
    }
  `,{CODEX_HOME:directory,ARC_FIXTURE_DESKTOP:'1'});
  try {
    const result=await fixture.call('codex_query',{method:'thread/read',params:{threadId,includeTurns:false}});
    assert.equal(result.thread.id,threadId,JSON.stringify(result));
    assert.equal(result.thread.model,'persisted-model');
    assert.equal((await fixture.call('codex_owner',{threadId})).state,'unheld');
  } finally {
    await fixture.close();for(const socket of sockets)socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});
  }
});

test('Codex activity and timelines retain the active native turn', { skip: process.platform !== 'darwin' }, async () => {
  // Regression: large tool output hid an active task, whose timeline could then report a utility terminal snapshot.
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-timeline-owner-'));
  await mkdir(path.join(directory, 'ipc'));
  const threadId = randomUUID(), turnId = randomUUID();
  let status = 'inProgress', revision = 0;
  const sockets = new Set<Socket>();
  const send = (socket: Socket, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
    header.writeUInt32LE(bytes.length); socket.write(Buffer.concat([header, bytes]));
  };
  const snapshot = (socket: Socket) => send(socket, {
    type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: 'timeline-owner',
    params: { hostId: 'local', conversationId: threadId, change: { type: 'snapshot', revision: ++revision, conversationState: {
      id: threadId, cwd: directory, threadRuntimeStatus: { type: status === 'inProgress' ? 'active' : 'idle' },
      turnHistory: { kind: 'canonical', history: { isComplete: true, entitiesByKey: {
        [turnId]: { turnId, status, items: [{ id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'Review a module' }] }] },
      }, islands: [{ newerBoundary: { status: 'exhausted' }, entries: [{ value: turnId }] }] } },
    } } },
  });
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const size = buffer.readUInt32LE(), request = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        if (request.method === 'thread-stream-following-changed') { snapshot(socket); continue; }
        send(socket, { type: 'response', requestId: request.requestId, handledByClientId: 'timeline-owner', resultType: 'success',
          result: request.method === 'initialize' ? { clientId: 'timeline-follower' } : {} });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path.join(directory, 'ipc/ipc.sock'), resolve));
  const fixture = await nativeControl(`
    import {createInterface} from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const {id,method,params}=JSON.parse(line); if(id===undefined)continue;
      const turn={id:process.env.ARC_TIMELINE_TURN,status:'completed',items:[{id:'prompt',type:'userMessage',content:[{type:'text',text:'Review a module'}]}]};
      const result=method==='thread/read'?{thread:{id:params.threadId,cwd:process.env.CODEX_HOME,status:{type:'notLoaded'},turns:[turn]}}:
        method==='thread/turns/list'?{data:[turn],nextCursor:null}:{};
      process.stdout.write(JSON.stringify({id,result})+'\\n');
    }
  `, { CODEX_HOME: directory, ARC_FIXTURE_DESKTOP: '1', ARC_TIMELINE_TURN: turnId });
  try {
    const activityThread = randomUUID(), activityTurn = randomUUID();
    const rollout = path.join(directory, 'sessions', `${activityThread}.jsonl`);
    await mkdir(path.dirname(rollout));
    const record = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + '\n';
    await writeFile(rollout, record('session_meta', { id: activityThread })
      + record('event_msg', { type: 'task_started', turn_id: activityTurn })
      + record('response_item', { type: 'message', role: 'user', content: [{ text: 'Review a module' }] })
      + record('response_item', { type: 'function_call', call_id: 'read', name: 'exec_command', arguments: '{}' }));
    const activity = async () => (await fixture.api('agents/activity')).agents.codex?.sessions ?? [];
    assert.equal((await activity()).find((row: any) => row.id === activityThread)?.turnId, activityTurn);
    await appendFile(rollout, record('response_item', { type: 'function_call_output', call_id: 'read', output: 'x'.repeat(192 * 1024) }));
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal((await activity()).find((row: any) => row.id === activityThread)?.turnId, activityTurn);
    await appendFile(rollout, record('event_msg', { type: 'task_complete', turn_id: activityTurn }));
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal((await activity()).some((row: any) => row.id === activityThread), false);
    const external = await fixture.api('agents/conversations/timeline', { agent: 'codex', id: threadId }, 'POST');
    assert.equal(external.turnStatuses[turnId], 'running');
    assert.equal(external.readOnly, true);
    const observed = await fixture.api(`agents/timeline/${threadId}`);
    assert.equal(observed.turnStatuses[turnId], 'running');
    assert.equal((await fixture.call('codex_read', { threadId, statusOnly: true })).state, 'running');
    status = 'completed'; for (const socket of sockets) snapshot(socket);
    const terminal = await fixture.api(`agents/timeline/${threadId}`);
    assert.equal(terminal.turnStatuses[turnId], 'completed');
  } finally {
    await fixture.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

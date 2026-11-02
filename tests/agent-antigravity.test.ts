import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';

const native = `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 if(request.id!==undefined)process.stdout.write(JSON.stringify({id:request.id,result:{data:[],nextCursor:null}})+'\\n');
}`;

const agy = `import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')) { console.log('1.4.12'); process.exit(0); }
if(process.argv.includes('--help')) { console.log('--input-format stream-json --output-format stream-json --conversation ID'); process.exit(0); }
appendFileSync(process.env.AGY_ARGS,JSON.stringify(process.argv.slice(2))+'\\n');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const conversationIndex=process.argv.indexOf('--conversation');
const conversation=conversationIndex>=0?process.argv[conversationIndex+1]:'fixture-conversation';
let turns=0, step=0, active=false;
process.on('SIGINT',()=>{
 if(active)emit({event:'result',result:{conversation_id:conversation,status:'ERROR',response:'',error:'interrupted',finished_reason:'interrupted',num_turns:turns}});
 setTimeout(()=>process.exit(1),10);
});
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line), prompt=request.message.content;
 if(turns===0)emit({event:'init',conversation_id:conversation,init:{cwd:process.cwd(),tools:[],permission_mode:'request-review'}});
 turns+=1; active=true;
 emit({event:'step_update',step_update:{conversation_id:conversation,step_index:step++,state:'DONE',step_type:'user_input'}});
 if(prompt==='hold') { emit({event:'step_update',step_update:{conversation_id:conversation,step_index:step++,state:'ACTIVE',step_type:'agent_response',text_delta:'Waiting'}}); continue; }
 if(prompt==='exit-without-result') { process.exit(0); }
 if(prompt==='denied')emit({event:'step_update',step_update:{conversation_id:conversation,step_index:step++,state:'ERROR',step_type:'permission',error:'command denied'}});
 const response=prompt==='large'?'x'.repeat(300*1024):prompt.toUpperCase();
 emit({event:'step_update',step_update:{conversation_id:conversation,step_index:step,state:'ACTIVE',step_type:'agent_response',text_delta:response}});
 emit({event:'step_update',step_update:{conversation_id:conversation,step_index:step++,state:'DONE',step_type:'agent_response',text_delta:'\\n'}});
 emit({event:'result',result:{conversation_id:conversation,status:'SUCCESS',response:response+'\\n',num_turns:turns,...(prompt==='denied'?{denied_actions:[{action:'command',display_name:'RunCommand'}]}:{})}});
 active=false;
}`;

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-antigravity-'));
  const home = path.join(directory, 'home');
  const args = path.join(directory, 'args.jsonl');
  await mkdir(home);
  await writeFile(args, '');
  await writeFile(path.join(directory, 'agy'), `#!${process.execPath}\n${agy}`, { mode: 0o755 });
  const fixture = await nativeControl(native, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    PATH: directory + path.delimiter + process.env.PATH,
    AGY_ARGS: args,
  });
  return {
    ...fixture,
    directory,
    args,
    async close() {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
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

async function completeResult(fixture: Awaited<ReturnType<typeof setup>>, result: any) {
  if (!result.outputId) return result;
  let text = result.text;
  let offset = result.nextOffset;
  while (offset !== null) {
    const page = await fixture.call('control_output', { outputId: result.outputId, offset, length: 30000 });
    text += page.text;
    offset = page.nextOffset;
  }
  return JSON.parse(text);
}

test('Antigravity discovery and stream transport preserve terminal evidence and interrupt active work', { skip: process.platform === 'win32' }, async () => {
  // Contract: Antigravity runs only after identity probes and uses result events as persistent turn boundaries.
  const fixture = await setup();
  try {
    const inventory = await fixture.api('agents');
    const agent = inventory.agents.find((row: any) => row.agent === 'antigravity');
    assert.equal(agent.installed, true);
    assert.equal(agent.available, true);
    assert.equal(agent.version, '1.4.12');
    assert.equal(agent.protocol, 'antigravity-stream-json');

    const created = await fixture.completed('agent_create', {
      agent: 'antigravity', cwd: fixture.directory, prompt: 'first', approval: 'approved',
      model: 'fixture-model', options: { effort: 'low', mode: 'plan' },
    });
    assert.equal(created.state, 'completed', JSON.stringify(created));
    const task = { agent: 'antigravity', taskId: created.taskId };
    const first = await fixture.call('agent_read', task);
    assert.equal(first.status, 'completed', JSON.stringify(first));
    assert.equal(first.output, 'FIRST\n');
    assert.equal(first.sessionId, 'fixture-conversation');

    const followed = await fixture.completed('agent_send', { ...task, prompt: 'denied' });
    assert.equal(followed.state, 'completed', JSON.stringify(followed));
    const second = await fixture.call('agent_read', task);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.output, 'DENIED\n');
    assert.equal(second.deniedActions[0].action, 'command');
    assert.equal(second.toolErrors.length, 1);
    assert.equal(second.toolErrors[0].step_type, 'permission');

    const oversized = await fixture.completed('agent_send', { ...task, prompt: 'large' });
    assert.equal(oversized.state, 'completed', JSON.stringify(oversized));
    const bounded = await completeResult(fixture, await fixture.call('agent_read', task));
    assert.equal(bounded.output.length, 256 * 1024);
    assert.equal(bounded.outputTruncated, true);

    const missingResult = await fixture.completed('agent_create', {
      agent: 'antigravity', cwd: fixture.directory, prompt: 'exit-without-result', approval: 'approved',
    });
    assert.equal(missingResult.state, 'unconfirmed', JSON.stringify(missingResult));
    const unknown = await fixture.call('agent_read', { agent: 'antigravity', taskId: missingResult.taskId });
    assert.equal(unknown.status, 'unknown');
    assert.notEqual(unknown.status, 'completed');

    const bypass = await fixture.completed('agent_create', {
      agent: 'antigravity', cwd: fixture.directory, prompt: 'bypass', approval: 'bypass',
    });
    assert.equal(bypass.state, 'completed', JSON.stringify(bypass));
    const launches = (await readFile(fixture.args, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(launches.some((launch: string[]) => launch.includes('--model') && launch.includes('fixture-model')));
    assert.ok(launches.some((launch: string[]) => launch.includes('--dangerously-skip-permissions')));

    const pending = await fixture.call('agent_send', { ...task, prompt: 'hold', purpose: 'self-test', notify: null, waitMs: 0 });
    await until(() => fixture.call('agent_read', task), value => value.status === 'running');
    const interrupted = await fixture.completed('agent_interrupt', task);
    assert.equal(interrupted.state, 'completed', JSON.stringify(interrupted));
    await until(() => fixture.call('receipt', { requestId: pending.requestId }), value => value.state === 'completed');
    const stopped = await fixture.call('agent_read', task);
    assert.equal(stopped.status, 'cancelled');

    const resumed = await fixture.completed('agent_send', { ...task, prompt: 'recovered' });
    assert.equal(resumed.state, 'completed', JSON.stringify(resumed));
    const recovered = await completeResult(fixture, await fixture.call('agent_read', task));
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.output, 'RECOVERED\n');
    const resumedLaunch = (await readFile(fixture.args, 'utf8')).trim().split('\n').map(JSON.parse).at(-1);
    const conversationIndex = resumedLaunch.indexOf('--conversation');
    assert.equal(resumedLaunch[conversationIndex + 1], 'fixture-conversation');
  } finally {
    await fixture.close();
  }
});

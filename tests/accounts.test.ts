import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeControl } from './helpers/native-control.ts';

const server = `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const {id,method}=JSON.parse(line); if(id===undefined) continue;
 let result={};
 if(method==='account/read') result={account:{type:'chatgpt',email:'person@example.com',planType:'plus'}};
 if(method==='account/rateLimits/read') result={rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:2000000000}}};
 if(method==='model/list') result={data:[]};
 console.log(JSON.stringify({id,result}));
}`;

async function claudeFixture(extraEnv: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-claude-accounts-'));
  const observed = path.join(directory, 'observed.jsonl');
  const cli = path.join(directory, 'claude');
  await writeFile(cli, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2),config=process.env.CLAUDE_CONFIG_DIR;
if(args[0]==='auth'&&args[1]==='login')process.exitCode=0;
else if(args[0]==='auth'&&args[1]==='status')console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',accountId:path.basename(path.dirname(config)),email:path.basename(path.dirname(config))+'@example.test',orgName:'Fixture'}));
else if(args[0]==='-p'){fs.appendFileSync(${JSON.stringify(observed)},JSON.stringify({profile:path.basename(path.dirname(config)),config})+'\\n');console.log(JSON.stringify({ok:true,session_id:args[3]}));}
else throw Error('Unexpected native fixture operation');
`, { mode: 0o755 });
  const fixture = await nativeControl(server, { HOME: directory, USERPROFILE: directory, PATH: directory + path.delimiter + process.env.PATH, ...extraEnv });
  const addClaude = async () => {
    await fixture.call('account_add', { kind: 'claude' });
    const deadline = Date.now() + 5000;
    let progress;
    do {
      progress = await fixture.call('accounts', { agent: 'claude' });
      if (progress.login?.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(progress.login?.state, 'completed', JSON.stringify(progress));
    return progress.login.accountId as string;
  };
  return { fixture, directory, observed, addClaude, close: async () => { await fixture.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('Account operations retain identity and removal tombstones', { skip: process.platform === 'win32' }, async () => {
  // Contract: accounts list omits identity contact fields, detail retains them, and removal keeps history identity.
  const { fixture, addClaude, close } = await claudeFixture();
  try {
    const id = await addClaude();
    const list = await fixture.call('accounts');
    const account = list.accounts.find((a: any) => a.id === id);
    assert.ok(account);
    assert.equal(account.email, undefined);
    assert.equal(account.orgName, undefined);
    assert.equal(account.agentProfiles[0].agent, 'claude');
    assert.equal(account.agentProfiles[0].kind, 'cli-profile');
    assert.equal(account.agentProfiles[0].state, 'signed-in');
    const detail = await fixture.call('accounts', { id: account.id });
    assert.equal(detail.orgName, 'Fixture');
    assert.ok(detail.email.endsWith('@example.test'));
    const renamed = await fixture.call('account_update', { id: account.id, alias: 'Example account' });
    assert.equal(renamed.alias, 'Example account');
    assert.equal((await fixture.api(`accounts/${account.id}`)).alias, 'Example account');
    const self = await fixture.call('whoami');
    assert.equal(self.id, null);
    assert.equal(self.authority, 'local');
    assert.equal(self.identityResolution.state, 'not-applicable');
    assert.ok(self.sourceId);
    assert.ok(!(await fixture.api('source')).sources.some((source: any) => source.id === self.sourceId));
    assert.ok(!(await fixture.call('accounts')).accounts.some((row: any) => row.sources.includes(self.sourceId)));
    await assert.rejects(fixture.shell(`arc cli source disconnect ${self.sourceId}`), (error: any) => {
      const result = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(result.error.code, 'LOCAL_SOURCE_PROTECTED');
      assert.equal(result.next.op, null);
      assert.ok(result.next.hint);
      return true;
    });
    assert.equal((await fixture.call('whoami')).sourceId, self.sourceId);
    const removed = await fixture.call('account_remove', { id: account.id, running: 'finish' });
    assert.ok(removed.removedAt);
    assert.equal(removed.health.state, 'removed');
    assert.equal((await fixture.call('accounts')).accounts.some((a: any) => a.id === account.id), false);
    assert.equal((await fixture.call('accounts', { id: account.id })).email, detail.email);
    await fixture.restart();
    assert.equal((await fixture.call('accounts', { id: account.id })).health.state, 'removed');
    assert.equal((await fixture.call('accounts')).accounts.some((a: any) => a.id === account.id), false);
  } finally { await close(); }
});

test('unchanged account reads reuse the index without account cost passes or row scans', { skip: process.platform === 'win32' }, async () => {
  // Recurring bug class: persistence: visible Desktop account polling rescanned unchanged rows tens of times per second.
  const { fixture, addClaude, close } = await claudeFixture();
  try {
    const id = await addClaude();
    await fixture.api(`accounts/${id}`);
    const before = (await fixture.call('runtime_metrics')).cost.accounts;
    for (let n = 0; n < 6; n++) {
      assert.equal((await fixture.api(`accounts/${id}`)).id, id);
      assert.ok((await fixture.api('accounts')).accounts.some((a: any) => a.id === id));
      await fixture.api('agents/activity');
    }
    const after = (await fixture.call('runtime_metrics')).cost.accounts;
    for (const key of ['passes', 'rowsVisited', 'bytesParsed', 'recordsChanged']) {
      assert.equal(after[key] - before[key], 0, key);
    }
  } finally { await close(); }
});

test('account reads observe a replaced index and retain add remove and quota changes', { skip: process.platform === 'win32' }, async () => {
  // Recurring bug class: persistence: account index caching must expose changed records on the next UI or op read.
  const { fixture, addClaude, close } = await claudeFixture();
  try {
    let directory = '';
    await fixture.restart(async state => { directory = state; });
    const id = await addClaude();
    await fixture.api(`accounts/${id}`);
    const indexPath = `${directory}/accounts/index.json`;
    const rows = JSON.parse(await readFile(indexPath, 'utf8'));
    const changed = rows.find((a: any) => a.id === id);
    changed.alias = 'Changed fixture';
    changed.quota = { state: 'ready', observedAt: new Date().toISOString(), windows: [{ usedPercent: 73 }] };
    const extra = { ...changed, id: 'fixture-added', identityKey: 'other:unidentified:fixture-added', agentProfiles: [] };
    rows.push(extra);
    const before = (await fixture.call('runtime_metrics')).cost.accounts;
    await writeFile(`${indexPath}.tmp`, JSON.stringify(rows));
    await rename(`${indexPath}.tmp`, indexPath);
    const detail = await fixture.api(`accounts/${id}`);
    assert.equal(detail.alias, changed.alias);
    assert.equal(detail.quota.windows[0].usedPercent, 73);
    const listed = await fixture.call('accounts');
    assert.ok(listed.accounts.some((a: any) => a.id === extra.id));
    const after = (await fixture.call('runtime_metrics')).cost.accounts;
    assert.equal(after.passes - before.passes, 1);
    assert.equal(after.rowsVisited - before.rowsVisited, rows.length + 1);
    assert.equal(after.recordsChanged - before.recordsChanged, 2);
    await writeFile(indexPath, JSON.stringify(rows.filter((a: any) => a.id !== extra.id)));
    assert.ok(!(await fixture.api('accounts')).accounts.some((a: any) => a.id === extra.id));
  } finally { await close(); }
});

test('Claude L1 notification profiles stay isolated across accounts', { skip: process.platform === 'win32' }, async () => {
  // Contract: multiple Claude L1 notification profiles authenticate independently and deliver cloud notifications through their own config directories.
  const { fixture, observed, addClaude, close } = await claudeFixture();
  try {
    const accounts = [];
    for (let i = 0; i < 2; i++) {
      const id = await addClaude();
      const account = await fixture.call('accounts', { id });
      const sent = await fixture.call('account_notify', { id: account.id, action: 'send', target: 'session_01000000000000000000002' + (i + 1), message: 'Native session fixture' });
      assert.equal(sent.deliveryStatus, 'delivered', JSON.stringify(sent));
      accounts.push(account);
    }
    assert.notEqual(accounts[0].id, accounts[1].id);
    const observations = (await readFile(observed, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const distinctConfigs = new Set(observations.map(row => row.config));
    assert.equal(distinctConfigs.size, 2);
    for (const account of accounts) {
      assert.ok(observations.some(row => row.profile === account.agentProfiles[0].profileId));
    }
  } finally { await close(); }
});

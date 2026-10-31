import {assertNextCalls} from './continuations.ts';
import {promisify} from 'node:util';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareCoreBinary(target: string) {
  execFileSync('cargo', ['build', '--locked', '--quiet', '-p', 'arc-core', '--bin', 'arc', '--target-dir', target], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit',
  });
  const executable = `arc${process.platform === 'win32' ? '.exe' : ''}`;
  const source = path.join(target, 'debug', executable);
  const binDirectory = path.join(target, 'debug', 'bin');
  const destination = path.join(binDirectory, executable);
  const sourceStat = await stat(source);
  const matchesSource = async () => {
    try {
      const destinationStat = await stat(destination);
      return destinationStat.size === sourceStat.size && destinationStat.mtime.getTime() === sourceStat.mtime.getTime();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  if (await matchesSource()) return;
  await mkdir(binDirectory, { recursive: true });
  const temporary = path.join(binDirectory, `.${executable}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    await utimes(temporary, sourceStat.atime, sourceStat.mtime);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!await matchesSource()) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function nativeControl(script: string, extraEnv: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-control-'));
  if (extraEnv.ARC_DEV_INSTANCE_ID) {
    await mkdir(path.join(directory, "state"));
    await writeFile(path.join(directory, "state/acceptance-instance.json"), JSON.stringify({instanceId:extraEnv.ARC_DEV_INSTANCE_ID}));
  }
  const fixture = path.join(directory, 'server.mjs');
  await writeFile(fixture, script);
  const target = process.env.CARGO_TARGET_DIR || path.resolve('target');
  execFileSync('cargo', ['build', '--locked', '--quiet', '-p', 'contract-fixture', '--target-dir', target], { stdio: 'inherit' });
  await prepareCoreBinary(target);
  const launch = async () => {
    const processHandle = spawn(path.join(target, 'debug', `contract-fixture${process.platform === 'win32' ? '.exe' : ''}`), ['http'], {
      env: { ...process.env, ARC_STATE_DIR: path.join(directory, 'state'), CODEX_HOME:path.join(directory,'codex'), ARC_FIXTURE_SCRIPT: fixture, ARC_FIXTURE_BINARY: process.execPath, ...extraEnv }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: processHandle.stdout });
    const endpoint = JSON.parse((await lines[Symbol.asyncIterator]().next()).value!);
    return {processHandle, lines, endpoint};
  };
  let runtime = await launch();
  const stop = async () => {
    runtime.processHandle.stdin.end('\n');
    await new Promise<void>(resolve => runtime.processHandle.once('exit', () => resolve()));
    runtime.lines.close();
  };
  const api = async (route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${runtime.endpoint.port}/api/${route}`, {
      method, headers: { authorization: `Bearer ${runtime.endpoint.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json() as Promise<any>;
  };
  const call = async (op: string, args: Record<string, unknown> = {}) => {
    const value = await api('cli/control', { op, args });
    assertNextCalls(value.structuredContent);
    return value.structuredContent?.result ?? value;
  };
  const sourceCall = async (ingressId: string, op: string, args: Record<string,unknown> = {}, tool: 'act' | 'query' = 'act') => {
    const response=await fetch(`http://127.0.0.1:${runtime.endpoint.port}/mcp/${ingressId}`, {
      method:'POST',headers:{authorization:`Bearer ${runtime.endpoint.token}`,'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:{op,args}}}),
    });
    const value=await response.json() as any;
    assertNextCalls(value.result?.structuredContent);
    return value.result?.structuredContent?.result??value;
  };
  const completed = async (op: string, args: Record<string, unknown> = {}) => {
    let result = await call(op, { ...(['codex_create','codex_send','agent_create','agent_send'].includes(op) ? {purpose:'self-test',notify:null} : {}), ...args });
    const deadline = Date.now() + 10000;
    while (['pending', 'reserved', 'executing', 'submitting', 'turn-submitting', 'thread-submitting', 'thread-created'].includes(result.state)) {
      if (Date.now() > deadline) throw new Error('Fixture receipt did not finish');
      await new Promise(resolve => setTimeout(resolve, 20));
      result = await call('receipt', { requestId: result.requestId });
    }
    return result;
  };
  const shell = async (command: string) => {
    const binary=path.join(target,'debug',process.platform === 'win32' ? 'contract-fixture.exe' : 'contract-fixture');
    const quoted="'"+binary.replaceAll("'","'\\''")+"'";
    return promisify(execFile)('/bin/sh',['-c',command.replace('arc cli',`${quoted} cli`)],{env:{...process.env,ARC_STATE_DIR:path.join(directory,'state')}});
  };
  return { api, call, sourceCall, completed, shell, async restart() {
    await stop(); runtime = await launch();
  }, async close() {
    await stop(); await rm(directory, { recursive: true, force: true });
  } };
}

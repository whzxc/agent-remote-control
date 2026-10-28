import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);

export function summarize(samples) {
  if (samples.length < 2) throw new Error('At least two samples are required.');
  const first = samples[0], last = samples.at(-1);
  if (samples.some(s => s.instance !== first.instance || s.pid !== first.pid)) throw new Error('Core restarted; compare separate instance windows.');
  const elapsedMs = last.elapsedMs - first.elapsedMs;
  if (!(elapsedMs > 0)) throw new Error('The observation window must advance.');
  const memory = field => {
    const values = samples.map(s => s.process?.[field]);
    if (values.some(v => typeof v !== 'number')) return null;
    const seconds = samples.map(s => (s.elapsedMs - first.elapsedMs) / 1000);
    const meanX = seconds.reduce((a,b) => a+b) / seconds.length;
    const meanY = values.reduce((a,b) => a+b) / values.length;
    const numerator = seconds.reduce((sum,x,i) => sum + (x-meanX)*(values[i]-meanY), 0);
    const denominator = seconds.reduce((sum,x) => sum + (x-meanX)**2, 0);
    return { first: values[0], last: values.at(-1), min: Math.min(...values), max: Math.max(...values), slopeBytesPerMinute: numerator / denominator * 60 };
  };
  const cpu = [first.process?.cpuTotalMs, last.process?.cpuTotalMs];
  const cpuPercent = cpu.every(v => typeof v === 'number') && cpu[1] >= cpu[0] ? 100 * (cpu[1] - cpu[0]) / elapsedMs : null;
  return { instance:first.instance, pid:first.pid, samples:samples.length, elapsedMs, cpuPercent,
    residentBytes:memory('residentBytes'), physicalFootprintBytes:memory('physicalFootprintBytes'),
    work:last.work.map(row => {
      const before = first.work.find(v => v.name === row.name);
      return {name:row.name, calls:before ? row.calls-before.calls : null, totalWallMs:before ? row.totalWallMs-before.totalWallMs : null, inFlight:row.inFlight};
    }), firstRetention:{caches:first.caches,desktopIpc:first.desktopIpc,events:first.events},
    lastRetention:{caches:last.caches,desktopIpc:last.desktopIpc,events:last.events},
    interpretation:'CPU percent uses one logical CPU as 100%. Work durations include waits and overlap. Cache bytes measure serialized input. Memory slope alone does not establish a leak.' };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: node tooling/diagnostics/runtime.mjs [--arc <executable>] [--duration <seconds>] [--interval <seconds>] --out <new-directory>\nRead-only sampling of the selected Core via cli call runtime.inspect. Defaults: arc, 180 seconds, 5 seconds. ARC_STATE_DIR selects an explicit instance. No processes are started or restarted.');
    return;
  }
  const options = {arc:'arc',duration:'180',interval:'5'};
  for (let i=0;i<args.length;i+=2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith('--') || !['arc','duration','interval','out'].includes(key) || !args[i+1]) throw new Error('Read --help for valid arguments.');
    options[key] = args[i+1];
  }
  const duration = Number(options.duration), interval = Number(options.interval);
  if (!options.out || !Number.isFinite(duration) || !Number.isFinite(interval) || duration < 2 || duration > 86400 || interval < 1 || interval > 60 || duration < interval) throw new Error('Use --out, duration 2..86400 and interval 1..60 seconds, with duration >= interval.');
  const directory = path.resolve(options.out);
  await mkdir(directory); // Never overwrite an earlier observation.
  const samples = [];
  const deadline = performance.now() + duration * 1000;
  do {
    const {stdout} = await exec(options.arc, ['cli','call','runtime.inspect'], {timeout:15000,maxBuffer:1024*1024});
    const envelope = JSON.parse(stdout);
    if (envelope.ok === false) throw new Error(JSON.stringify(envelope.error));
    const sample = envelope.result ?? envelope;
    if (sample.schemaVersion !== 1 || !sample.instance) throw new Error('runtime.inspect is unavailable; use a Core build with runtime diagnostics.');
    samples.push(sample);
    await appendFile(path.join(directory,'samples.jsonl'), JSON.stringify(sample)+'\n');
    if (samples.length > 1 && performance.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(interval*1000, Math.max(0,deadline-performance.now()))));
  } while (true);
  const summary = summarize(samples);
  await writeFile(path.join(directory,'summary.json'), JSON.stringify(summary,null,2)+'\n');
  console.log(JSON.stringify({directory,...summary},null,2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode=1; });

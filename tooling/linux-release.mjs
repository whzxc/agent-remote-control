import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileDigest, ghOptions, ghTransfer } from './release-support.mjs';

const repo = 'whzxc/agent-remote-control';
const workflow = 'release-linux.yml';
const execute = promisify(execFile);
const query = async args => JSON.parse((await execute('gh', args, ghOptions)).stdout);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateLinuxElf(bytes, arch) {
  const machine = { x86_64: 62, aarch64: 183 }[arch];
  if (!machine || bytes.length < 64 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1
      || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== machine) throw new Error(`Expected a little-endian Linux ${arch} ELF64 binary`);
}

export function validateLinuxReceipt(receipt, { sourceSha, version, arch, digest }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || receipt.sourceSha !== sourceSha || receipt.version !== version
      || receipt.arch !== arch || receipt.file !== `agent-remote-control-v${version}-linux-${arch}.tar.gz`
      || receipt.sha256 !== digest.replace(/^sha256:/, '') || receipt.glibcBaseline !== '2.28'
      || receipt.runtimeVersion !== version || receipt.runtimeHelp !== true) {
    throw new Error(`Linux ${arch} receipt version/SHA/architecture/checksum/runtime mismatch`);
  }
}

export async function preflightLinux(sourceSha) {
  const remote = await query(['api', `repos/${repo}/commits/main`]);
  if (remote.sha !== sourceSha) throw new Error('Linux Actions builds require the exact source SHA pushed to main before release; push source and retry');
  const current = await query(['api', `repos/${repo}/actions/workflows/${workflow}`]);
  if (current.state !== 'active') throw new Error(`Enable ${workflow} in GitHub Actions before selecting Linux`);
}

export async function buildLinux({ sourceSha, version, output, timer, platforms = ['linux'] }) {
  const requestId = randomUUID();
  const title = `Linux ${version} ${requestId}`;
  await timer.run('Linux Actions dispatch', () => execute('gh', ['workflow', 'run', workflow, '--repo', repo, '--ref', 'main',
    '-f', `source_sha=${sourceSha}`, '-f', `version=${version}`, '-f', `platforms=${platforms.join(',')}`, '-f', `request_id=${requestId}`], ghOptions));
  const run = await timer.run('Linux Actions wait', async () => {
    const deadline = Date.now() + 90 * 60_000;
    let id;
    while (Date.now() < deadline) {
      const current = id ? await query(['api', `repos/${repo}/actions/runs/${id}`]) :
        (await query(['api', `repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`])).workflow_runs.find(item => item.display_title === title);
      if (current) {
        if (!id) console.log(`Linux Actions: ${current.html_url}`);
        id = current.id;
        if (current.head_sha !== sourceSha) throw new Error(`Linux Actions workflow SHA changed; retry from current main: ${current.html_url}`);
        if (current.status === 'completed') {
          if (current.conclusion !== 'success') throw new Error(`Linux Actions ${current.conclusion}: ${current.html_url}`);
          return current;
        }
      }
      await sleep(15_000);
    }
    throw new Error(`Linux Actions timed out; inspect ${id ? `https://github.com/${repo}/actions/runs/${id}` : title}`);
  });
  const downloads = path.join(output, 'linux-actions');
  await mkdir(downloads);
  await timer.run('Linux Actions collect', async () => {
    await ghTransfer(['run', 'download', String(run.id), '--repo', repo, '--dir', downloads]);
    const receipts = [];
    for (const arch of ['x86_64', 'aarch64']) {
      const directory = path.join(downloads, `linux-${arch}`);
      const file = `agent-remote-control-v${version}-linux-${arch}.tar.gz`;
      const receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8'));
      const digest = await fileDigest(path.join(directory, file));
      validateLinuxReceipt(receipt, { sourceSha, version, arch, digest });
      if ((await readdir(directory)).sort().join(',') !== [file, 'receipt.json'].sort().join(',')) throw new Error(`Unexpected Linux ${arch} artifact inventory`);
      receipts.push(receipt);
    }
    // Only expose payloads to finalize after both native jobs and their receipts pass.
    for (const receipt of receipts) await copyFile(path.join(downloads, `linux-${receipt.arch}`, receipt.file), path.join(output, receipt.file));
    await copyFile('tooling/install-agent-remote-control.sh', path.join(output, 'install-agent-remote-control.sh'));
    await writeFile(path.join(output, 'linux-receipts.json'), JSON.stringify({ runId: run.id, url: run.html_url, receipts }, null, 2) + '\n');
  });
}

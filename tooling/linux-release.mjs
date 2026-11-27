import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileDigest } from './release-support.mjs';
import { buildOnlyEnv, verifier } from './release-signing.mjs';
import { prepareLocalSource, runCommand } from './windows-release.mjs';

const capture = (file, args) => execFileSync(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 }).trim();

export function validateLinuxElf(bytes, arch) {
  const machine = { x86_64: 62, aarch64: 183 }[arch];
  if (!machine || bytes.length < 64 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1
      || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== machine) throw new Error(`Expected a little-endian Linux ${arch} ELF64 binary`);
}

export function validateLinuxReceipt(receipt, { sourceSha, version, arch, digest }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || receipt.sourceSha !== sourceSha || receipt.version !== version
      || receipt.arch !== arch || receipt.file !== `agent-remote-control-v${version}-linux-${arch}.tar.gz`
      || receipt.sha256 !== digest.replace(/^sha256:/, '') || receipt.glibcBaseline !== '2.28'
      || receipt.linkage !== 'static') {
    throw new Error(`Linux ${arch} receipt version/SHA/architecture/checksum/linkage mismatch`);
  }
}

export async function buildLinux({ sourceSha, version, output, env, timer }) {
  const source = await prepareLocalSource('.linux-source', sourceSha, env, timer, 'Linux checkout/dependencies');
  const buildEnvironment = { ...buildOnlyEnv(env), ARC_BUILD_VERSION: version, ARC_RELEASE_PLATFORM: 'linux' };
  await timer.run('Linux frontend stage', () => runCommand(process.execPath, ['tooling/prepare-desktop.mjs'], { cwd: source, env: buildEnvironment }));
  const stageRoot = path.join(source, 'dist/linux-release');
  await rm(stageRoot, { recursive: true, force: true });
  const receipts = [];
  await timer.run('Linux cross-build and verification', async () => {
    const arches = [
      { arch: 'x86_64', target: 'linux/amd64' },
      { arch: 'aarch64', target: 'linux/arm64' },
    ];
    await Promise.all(arches.map(async ({ arch, target }) => {
      const stage = path.join(stageRoot, arch);
      await mkdir(stage, { recursive: true });
      await runCommand(process.execPath, ['-e',
        `import('./tooling/build-native.mjs').then(m => m.buildNative({ target: ${JSON.stringify(target)}, release: true, directory: ${JSON.stringify(stage)} }))`,
      ], { cwd: source, env: buildEnvironment });
      const binary = path.join(stage, 'arc');
      validateLinuxElf(await readFile(binary), arch);
      console.log(verifier('verify-linux', version, [arch, binary], { publicOnly: true, env }));
      await copyFile(path.join(source, 'LICENSE'), path.join(stage, 'LICENSE'));
      await cp(path.join(source, 'licenses'), path.join(stage, 'licenses'), { recursive: true });
      const file = `agent-remote-control-v${version}-linux-${arch}.tar.gz`;
      await runCommand('tar', ['-czf', path.join(output, file), '-C', stage, 'arc', 'LICENSE', 'skills', 'licenses'],
        { env: { ...buildOnlyEnv(env), COPYFILE_DISABLE: '1' } });
      const digest = await fileDigest(path.join(output, file));
      const receipt = { version, sourceSha, arch, file, sha256: digest.slice(7), glibcBaseline: '2.28', linkage: 'static' };
      validateLinuxReceipt(receipt, { sourceSha, version, arch, digest });
      receipts.push(receipt);
    }));
  });
  if (capture('git', ['-C', source, 'status', '--porcelain']) || capture('git', ['-C', source, 'rev-parse', 'HEAD']) !== sourceSha) {
    throw new Error('Linux build changed source');
  }
  await copyFile(path.join(source, 'tooling/install-agent-remote-control.sh'), path.join(output, 'install-agent-remote-control.sh'));
  receipts.sort((a, b) => a.arch.localeCompare(b.arch));
  await writeFile(path.join(output, 'linux-receipts.json'), JSON.stringify({ receipts }, null, 2) + '\n');
}

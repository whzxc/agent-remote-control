import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, realpath, copyFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { buildEnv } from './build-env.mjs';
import { fileDigest, parallelPlatforms } from './release-support.mjs';
import { runCommand } from './windows-release.mjs';

export function validateLinuxElf(bytes, arch) {
  const machine = { x86_64: 62, aarch64: 183 }[arch];
  if (!machine || bytes.length < 64 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1
      || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== machine) throw new Error(`Expected a little-endian Linux ${arch} ELF64 binary`);
}

export async function buildLinux({ sourceSha, version, output, timer }) {
  const root = process.cwd(), source = path.resolve('release-artifacts/.linux-source');
  const linuxEnv = { ...buildEnv(true), ARC_BUILD_VERSION: version,
    PATH: [path.join(root, 'release-artifacts/.linux-tools/bin'), path.join(root, 'release-artifacts/.linux-tools/lima/bin'), process.env.PATH].join(path.delimiter),
    LIMA_HOME: path.resolve('release-artifacts/.l') };
  const capture = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', env: linuxEnv, ...options }).trim();
  const initial = JSON.parse(capture('limactl', ['list', '--json', 'arc']));
  if (!initial.name) throw new Error('Linux validation VM is missing; follow docs/dev/release.md Linux prerequisites');
  let started = false;
  const runtimeReady = timer.run('Linux runtime readiness', async () => {
    if (initial.status !== 'Running') {
      started = true;
      await runCommand('limactl', ['start', '--tty=false', 'arc'], { env: linuxEnv });
    }
  });
  runtimeReady.catch(() => {});
  try {
    await timer.run('Linux checkout', async () => {
      try { await readFile(path.join(source, '.git/HEAD')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await runCommand('git', ['clone', '--no-hardlinks', '.', source]);
      }
      if (capture('git', ['-C', source, 'status', '--porcelain'])) throw new Error('Linux release checkout is dirty');
      await runCommand('git', ['-C', source, 'fetch', root, sourceSha]);
      if (capture('git', ['-C', source, 'rev-parse', 'HEAD']) !== sourceSha) await runCommand('git', ['-C', source, 'checkout', '--detach', sourceSha]);
    });
    const cache = await realpath('target');
    const receipts = await parallelPlatforms(['x86_64', 'aarch64'].map(arch => () => timer.run(`Linux ${arch} wall`, async () => {
      const target = `${arch}-unknown-linux-gnu`;
      const env = { ...linuxEnv, CARGO_TARGET_DIR: path.join(cache, `linux-${arch}`), CARGO_BUILD_JOBS: '3' };
      await timer.run(`Linux ${arch} clippy`, () => runCommand('cargo-zigbuild', ['clippy', '--locked', '--manifest-path', 'native/Cargo.toml', '--target', `${target}.2.28`], { cwd: source, env }));
      await timer.run(`Linux ${arch} build`, () => runCommand('cargo', ['zigbuild', '--locked', '--release', '--manifest-path', 'native/Cargo.toml', '--bin', 'arc', '--target', `${target}.2.28`], { cwd: source, env }));
      const binary = path.join(env.CARGO_TARGET_DIR, target, 'release/arc');
      validateLinuxElf(await readFile(binary), arch);
      const validation = path.resolve('release-artifacts/.linux-validation', arch);
      await mkdir(validation, { recursive: true });
      await copyFile(binary, path.join(validation, 'arc'));
      await runtimeReady;
      return timer.run(`Linux ${arch} runtime/package`, async () => {
        const command = arch === 'x86_64' ? ['/mnt/lima-rosetta/rosetta', '/usr/x86_64-linux-gnu/lib/ld-linux-x86-64.so.2', '--library-path', '/usr/x86_64-linux-gnu/lib', path.join(validation, 'arc')] : [path.join(validation, 'arc')];
        const actual = capture('limactl', ['shell', 'arc', '--', ...command, '--version']);
        if (actual !== version) throw new Error(`Linux ${arch} embedded version mismatch: ${actual}`);
        capture('limactl', ['shell', 'arc', '--', ...command, 'cli', '--help']);
        const symbols = capture('limactl', ['shell', 'arc', '--', 'readelf', '--version-info', path.join(validation, 'arc')]);
        const versions = [...symbols.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map(match => [Number(match[1]), Number(match[2])]);
        if (!versions.length || versions.some(([major, minor]) => major > 2 || (major === 2 && minor > 28))) throw new Error('Linux build exceeds the GLIBC 2.28 compatibility baseline');
        const stage = path.join(output, `.linux-${arch}`);
        await mkdir(stage);
        try {
          await copyFile(binary, path.join(stage, 'arc'));
          await copyFile(path.join(source, 'LICENSE'), path.join(stage, 'LICENSE'));
          await mkdir(path.join(stage, 'skills'));
          await cp(path.join(source, 'skills'), path.join(stage, 'skills'), { recursive: true });
          await cp(path.join(source, 'licenses'), path.join(stage, 'licenses'), { recursive: true });
          const file = `agent-remote-control-v${version}-linux-${arch}.tar.gz`;
          await runCommand('tar', ['-czf', path.join(output, file), '-C', stage, 'arc', 'LICENSE', 'skills', 'licenses'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
          return { version, sourceSha, arch, file, sha256: (await fileDigest(path.join(output, file))).slice(7),
            glibcBaseline: '2.28', runtimeVersion: actual, runtimeHelp: true, targetDir: env.CARGO_TARGET_DIR };
        } finally { await rm(stage, { recursive: true, force: true }); }
      });
    })));
    await copyFile(path.join(source, 'tooling/install-agent-remote-control.sh'), path.join(output, 'install-agent-remote-control.sh'));
    await writeFile(path.join(output, 'linux-receipts.json'), JSON.stringify(receipts, null, 2) + '\n');
    if (capture('git', ['-C', source, 'status', '--porcelain']) || capture('git', ['-C', source, 'rev-parse', 'HEAD']) !== sourceSha) throw new Error('Linux build changed source');
  } finally {
    await runtimeReady.catch(() => {});
    if (started) await timer.run('Linux runtime cleanup', () => runCommand('limactl', ['stop', 'arc'], { env: linuxEnv }));
    await runCommand(process.execPath, ['tooling/prune-build-cache.mjs']);
  }
}

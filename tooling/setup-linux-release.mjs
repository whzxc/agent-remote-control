// Local release prerequisites only; no service, tag, or publication changes.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runCommand } from './windows-release.mjs';
import { fileDigest } from './release-support.mjs';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Local Linux releases require an Apple Silicon Mac');
const root = process.cwd(), tools = path.resolve('release-artifacts/.linux-tools');
await mkdir(tools, { recursive: true });
if (!existsSync(path.join(tools, 'bin/python'))) await runCommand('uv', ['venv', tools]);
await runCommand('uv', ['pip', 'install', '--upgrade', '--python', path.join(tools, 'bin/python'), 'cargo-zigbuild>=0.24.0,<1', 'ziglang>=0.17.0,<1']);
await runCommand('rustup', ['target', 'add', 'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu']);
const lima = path.join(tools, 'lima');
await mkdir(lima, { recursive: true });
const releases = JSON.parse(execFileSync('gh', ['api', 'repos/lima-vm/lima/releases?per_page=100'], { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2 }));
const release = releases.filter(item => !item.draft && !item.prerelease && /^v2\.\d+\.\d+$/.test(item.tag_name))
  .sort((a, b) => {
    const left = a.tag_name.slice(1).split('.').map(Number), right = b.tag_name.slice(1).split('.').map(Number);
    return right[1] - left[1] || right[2] - left[2];
  })[0];
if (!release) throw new Error('No stable Lima 2 release found');
const name = `lima-${release.tag_name.slice(1)}-Darwin-arm64.tar.gz`;
const asset = release.assets.find(item => item.name === name);
if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error(`Missing SHA-256 for ${name}`);
const archive = path.join(lima, name);
if (!existsSync(archive)) await runCommand('gh', ['release', 'download', release.tag_name, '--repo', 'lima-vm/lima',
  '--pattern', name, '--dir', lima]);
if (await fileDigest(archive) !== asset.digest) throw new Error('Lima archive checksum mismatch');
const marker = path.join(lima, '.arc-version');
const installed = await readFile(marker, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
if (installed.trim() !== release.tag_name || !existsSync(path.join(lima, 'bin/limactl'))) {
  await runCommand('tar', ['-xzf', archive, '-C', lima]);
  await writeFile(marker, `${release.tag_name}\n`);
}
const env = { ...process.env, LIMA_HOME: path.resolve('release-artifacts/.l') };
const limactl = path.join(lima, 'bin/limactl');
const mount = path.resolve('release-artifacts/.linux-validation');
await mkdir(mount, { recursive: true });
// Rosetta must already be installed through macOS. This does not accept a license.
if (!existsSync('/Library/Apple/usr/libexec/oah/libRosettaRuntime')) throw new Error('Install Rosetta through macOS before setting up the Linux x64 validator');
await runCommand(limactl, existsSync(path.join(env.LIMA_HOME, 'arc/lima.yaml')) ? ['start', '--tty=false', 'arc'] :
  ['start', '--name', 'arc', '--vm-type', 'vz', '--cpus', '2', '--memory', '2', '--disk', '10',
    '--containerd', 'none', '--rosetta', '--mount-only', mount, '--tty=false', 'template:ubuntu-24.04'], { env });
await runCommand(limactl, ['shell', 'arc', '--', 'sudo', 'sh', '-c',
  'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libc6-amd64-cross libgcc-s1-amd64-cross binutils'], { env });
console.log(`Linux release tools ready under ${path.relative(root, tools)}. The project VM mounts only ${mount}.`);

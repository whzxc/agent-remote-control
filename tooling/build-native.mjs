import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildEnv, coreFlags, goTarget } from './build-env.mjs';
import { macosSigningArgs } from './macos-signing.mjs';
import { prepareDesktop } from './prepare-desktop.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildNative({
  release = false, target, directory = path.join(root, 'dist/native'), bundled = true,
  pack = false, identity = '-', identifier = 'com.whzxc.agent-remote-control',
} = {}) {
  const platform = goTarget(target);
  const env = { ...buildEnv(), GOOS: platform.os, GOARCH: platform.arch };
  const run = (command, args) => execFileSync(command, args, { cwd: root, env, stdio: 'inherit' });
  await mkdir(directory, { recursive: true });
  const binary = path.join(directory, 'arc' + platform.suffix);
  run('go', ['build', ...coreFlags(env.ARC_BUILD_VERSION, release), ...(bundled ? ['-tags', 'arcbrowser'] : []), '-o', binary, './cmd/arc']);
  const helper = path.join(directory, 'arc-screen');
  await rm(helper, { force: true });
  if (pack && platform.os === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('The macOS screen helper must be built on macOS.');
    const arch = platform.arch === 'amd64' ? 'x86_64' : platform.arch;
    run('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos11.0`, path.join(root, 'native/screen/main.swift'), '-o', helper]);
    run('codesign', [...macosSigningArgs(identity, `${identifier}.core`), binary]);
    run('codesign', [...macosSigningArgs(identity, `${identifier}.screen`), helper]);
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commits = git('log', '-100', '--format=%H%x09%s').split('\n').filter(Boolean).map(line => {
    const [build, ...subject] = line.split('\t');
    return { build, subject: subject.join('\t') };
  });
  const metadata = { build: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
    landedLanes: git('branch', '--merged', 'HEAD', '--format=%(refname:short)').split('\n').filter(name => name.startsWith('wt/')).map(name => name.slice(3)), commits };
  await writeFile(path.join(directory, 'build-metadata.json'), JSON.stringify(metadata));
  return binary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const targetFlag = args.find(arg => arg.startsWith('--target='));
  const target = targetFlag?.slice(9);
  if (args.some(arg => arg !== '--release' && arg !== targetFlag) || targetFlag && !target) {
    throw new Error('Usage: node tooling/build-native.mjs [--release] [--target=GOOS/GOARCH]');
  }
  await prepareDesktop();
  await buildNative({ release: args.includes('--release'), target });
}

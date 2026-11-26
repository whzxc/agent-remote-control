import { enterHeavyBuild } from './heavy-build.mjs';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildEnv, goTarget, versionSymbol } from './build-env.mjs';
import { preflightMacosSigning } from './macos-signing.mjs';
import { resolveMygoUpdatePublicKey } from './mygo-update-public-key.mjs';
import { compileIcon, requireXcode } from './macos-icons.mjs';
import { stageTimer } from './release-support.mjs';
import { buildNative } from './build-native.mjs';
import { prepareDesktop } from './prepare-desktop.mjs';
import { finishMacosApp } from './macos-dev-app.mjs';
import { desktopExecutable, desktopIdentifier, desktopName, desktopScheme, developmentConfig, developmentEnvironment } from './dev-identity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function uninstallFiles(directory, prefix = '') {
  const commands = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (/["$\r\n]/.test(entry.name)) throw new Error('NSIS resource paths must not contain installer syntax.');
    const relative = prefix + entry.name;
    const destination = `"$INSTDIR\\${relative}"`;
    if (entry.isDirectory()) {
      commands.push(...await uninstallFiles(path.join(directory, entry.name), relative + '\\'));
      commands.push(`RMDir ${destination}`);
    } else if (entry.isFile() && relative !== desktopExecutable + '.exe') {
      commands.push(`Delete ${destination}`);
    }
  }
  return commands;
}

export async function buildDesktop({ target, output, development = false, release = false, noImage = false, debug = false, adhoc = false, updateFixture } = {}) {
  const platform = goTarget(target);
  if (!['darwin/arm64', 'windows/amd64'].includes(platform.name)) throw new Error('Desktop packages support darwin/arm64 and windows/amd64.');
  if (platform.os === 'darwin' && process.platform !== 'darwin') throw new Error('macOS bundles require a macOS build host.');
  const env = buildEnv();
  const version = env.ARC_BUILD_VERSION;
  const config = development ? developmentConfig(env) : { identifier: desktopIdentifier, productName: desktopName, scheme: desktopScheme };
  if (release && (development || adhoc)) throw new Error('A release requires the production identity and certificate.');
  for (const name of Object.keys(env)) {
    if (/^(TAURI_SIGNING_|MYGO_UPDATER_PRIVATE_KEY$|ARC_MYGO_UPDATE_PRIVATE_KEY_FILE$|CSC_|WIN_CSC_)/.test(name)) delete env[name];
  }
  delete env.ARC_MYGO_FIXTURE_FRONTEND;
  if (!updateFixture) delete env.ARC_MYGO_UPDATE_BASE;
  if (updateFixture) {
    developmentEnvironment(updateFixture);
    const feed = new URL(env.ARC_MYGO_UPDATE_BASE);
    if (!development || platform.os !== 'darwin' || feed.protocol !== 'http:' || feed.hostname !== '127.0.0.1' || !feed.port) {
      throw new Error('An updater fixture requires macOS development packaging with a private loopback feed.');
    }
    env.GOFLAGS = '-tags=arcfixture';
    env.ARC_MYGO_FIXTURE_FRONTEND = path.join(updateFixture, 'frontend');
  }
  env.ARC_MYGO_DEVELOPMENT = development ? '1' : '0';
  env.ARC_MYGO_MACOS = platform.os === 'darwin' ? '1' : '0';
  const updateKey = resolveMygoUpdatePublicKey(env, development, updateFixture);
  if (updateKey && !/^[A-Za-z0-9+/]{43}=$/.test(updateKey)) throw new Error('ARC_MYGO_UPDATE_PUBLIC_KEY must be a Base64 Ed25519 key.');
  env.ARC_MYGO_UPDATE_PUBLIC_KEY = updateKey;
  // MyGo owns its native frontend and package flags. Append ARC's matching
  // runtime identity and Core version via its supported linker flag input.
  env.MYGO_LDFLAGS = [
    `-X ${versionSymbol}=${version}`, `-X main.bundleID=${config.identifier}`,
    `-X 'main.appName=${config.productName}'`, `-X main.linkScheme=${config.scheme}`,
    ...(updateKey ? [`-X main.updatePublicKey=${updateKey}`] : []),
    ...(updateFixture ? [`-X 'main.updateFixtureHome=${updateFixture}'`] : []),
    ...(env.ARC_MYGO_UPDATE_BASE ? [`-X main.updateBase=${new URL(env.ARC_MYGO_UPDATE_BASE).href}`] : []),
  ].join(' ');
  const productionSignature = platform.os === 'darwin' && !development && !adhoc;
  const identity = productionSignature ? preflightMacosSigning(env) : '-';
  const timed = (name, operation) => env.ARC_RELEASE_TIMINGS_FILE ? stageTimer().run(name, operation) : operation();
  const run = (command, args, directory = root) => execFileSync(command, args, { cwd: directory, env, stdio: 'inherit' });
  const input = path.join(root, 'dist/mygo-input');
  await rm(input, { recursive: true, force: true });
  await timed('Frontend and Core', async () => {
    await prepareDesktop();
    if (platform.os === 'darwin') requireXcode(env);
    await buildNative({ release: !debug, target: platform.name, directory: path.join(input, 'bin'), pack: true, identifier: config.identifier });
  });
  if (platform.os === 'darwin') {
    const icon = path.join(root, 'desktop/icons/AgentRemoteControl.icon');
    let source = icon;
    if (development) {
      source = path.join(input, 'Icon-dev.icon');
      await cp(icon, source, { recursive: true });
      const file = path.join(source, 'icon.json');
      const design = JSON.parse(await readFile(file, 'utf8'));
      design['fill-specializations'][0].value = { solid: 'srgb:0.87843,0.94902,0.99216,1.00000' };
      await writeFile(file, JSON.stringify(design));
    }
    compileIcon(source, path.join(input, 'icon'), env);
  }
  const parent = path.resolve(output || path.join(root, 'dist/desktop', development ? 'development' : version));
  await mkdir(parent, { recursive: true });
  const work = await mkdtemp(path.join(parent, '.build-'));
  const name = `${platform.os}-${platform.arch}`;
  try {
    await timed('MyGo package', async () => run(process.execPath, [path.join(root, 'node_modules/mygo-cli/bin/mygo.js'), 'build',
      '-platform', platform.name, '-o', work, '-skip-build-command', '-skip-dmg', '-skip-installer', '-skip-notarize', '-sign', '-',
      ...(!updateFixture && (debug || development) ? ['-debug'] : [])]));
    const stage = path.join(work, name);
    if (platform.os === 'darwin') {
      const app = await finishMacosApp(stage, config, identity, env, path.join(input, 'icon/Icon.icns'));
      const verification = productionSignature ? [] : ['--adhoc'];
      run(process.execPath, [path.join(root, 'tooling/check-package.mjs'), app, ...verification]);
      if (!noImage) await timed('macOS DMG', async () => run('uv', ['run', '--script', path.join(root, 'tooling/build-dmg.py'), app,
        path.join(stage, `agent-remote-control_${version}_aarch64.dmg`)]));
    } else if (!noImage) {
      const uninstall = path.join(work, 'uninstall-files.nsh');
      await writeFile(uninstall, (await uninstallFiles(stage)).join('\n') + '\n');
      const installedNSIS = process.platform === 'win32' && process.env['ProgramFiles(x86)']
        ? path.join(process.env['ProgramFiles(x86)'], 'NSIS/makensis.exe') : '';
      const makensis = env.ARC_MAKENSIS || (installedNSIS && existsSync(installedNSIS) ? installedNSIS : 'makensis');
      await timed('Windows NSIS installer', async () => run(makensis, [
        `-DARC_VERSION=${version}`, `-DARC_PAYLOAD=${stage}`, `-DARC_UNINSTALL_FILES=${uninstall}`,
        `-DARC_OUTPUT=${path.join(work, `agent-remote-control_${version}_x64-setup.exe`)}`,
        path.join(root, 'tooling/windows-installer/installer.nsi'),
      ]));
      await rename(path.join(work, `agent-remote-control_${version}_x64-setup.exe`), path.join(stage, `agent-remote-control_${version}_x64-setup.exe`));
    }
    const destination = path.join(parent, name);
    const previous = path.join(work, 'previous');
    try { await rename(destination, previous); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, destination); }
    catch (error) {
      try { await rename(previous, destination); }
      catch (rollback) { if (rollback.code !== 'ENOENT') throw rollback; }
      throw error;
    }
    console.log(`Desktop package: ${destination}`);
    return destination;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  enterHeavyBuild();
  const { values } = parseArgs({ options: {
    target: { type: 'string' }, output: { type: 'string' }, release: { type: 'boolean' }, adhoc: { type: 'boolean' },
    development: { type: 'boolean' }, 'update-fixture': { type: 'string' }, debug: { type: 'boolean', short: 'd' },
    'no-image': { type: 'boolean' }, 'no-bundle': { type: 'boolean' },
  } });
  await buildDesktop({ ...values, updateFixture: values['update-fixture'], noImage: values['no-image'] || values['no-bundle'] || values.development });
}

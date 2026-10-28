import { developmentConfig } from './dev-identity.mjs';
import { verifyMacosReleaseSignature } from './macos-signing.mjs';
import { buildVersion } from './version.mjs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { toolFingerprint } from './catalog.mjs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2] || 'target/aarch64-apple-darwin/release/bundle/macos/Agent Remote Control.app';
const catalog = JSON.parse(await readFile(new URL('../native/src/catalog.json', import.meta.url), 'utf8'));
toolFingerprint(catalog.tools);
let bytes = 0;
async function inspect(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (['node_modules', 'runtime', 'node', 'node.exe', 'npm', 'npx', 'desktop-launch.mjs'].includes(item.name)) throw new Error(`The artifact still contains the old runtime: ${file}`);
    if (item.isDirectory()) await inspect(file);
    else bytes += (await stat(file)).size;
  }
}
await inspect(root);
for (const name of ['arc-setup', 'arc-local-code']) {
  const skill = path.join(root, ...(root.endsWith('.app') ? ['Contents', 'Resources'] : []), `skills/${name}`);
  const files = name === 'arc-setup' ? ['SKILL.md', ...(await readdir(new URL('../skills/arc-setup/playbooks/', import.meta.url))).map(file => `playbooks/${file}`)] : ['SKILL.md'];
  for (const file of files) {
    const actual = await readFile(path.join(skill, file), 'utf8');
    const expected = await readFile(new URL(`../skills/${name}/${file}`, import.meta.url), 'utf8');
    if (actual !== expected) throw new Error(`Packaged skill resource differs from source: ${name}/${file}`);
  }
}
if (process.platform === 'darwin' && root.endsWith('.app')) {
  const identifier = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(root, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (!['com.whzxc.agent-remote-control', developmentConfig().identifier].includes(identifier)) throw new Error('Incorrect package bundle identifier.');
  if (identifier === 'com.whzxc.agent-remote-control') {
    verifyMacosReleaseSignature(root, identifier);
    verifyMacosReleaseSignature(path.join(root, 'Contents/Resources/bin/arc'), `${identifier}.core`);
    verifyMacosReleaseSignature(path.join(root, 'Contents/Resources/bin/arc-screen'), `${identifier}.screen`);
  }
  const resources = path.join(root, 'Contents', 'Resources');
  const native = path.join(resources,'bin/arc');
  const version = buildVersion();
  const appVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(root, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (appVersion !== version) throw new Error('Package version differs from build version.');
  if (execFileSync(native,['--version'],{encoding:'utf8'}).trim() !== version) throw new Error('The package lacks a standalone Core of the same version.');
  execFileSync('codesign',['--verify','--strict',native],{stdio:'inherit'});
  execFileSync('codesign',['--verify','--strict',path.join(resources, 'bin/arc-screen')],{stdio:'inherit'});
  const assets = JSON.parse(execFileSync('xcrun', ['assetutil', '--info', path.join(resources, 'Assets.car')], { encoding: 'utf8' }));
  const name = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconName', path.join(root, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  const file = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(root, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (file !== name) throw new Error('CFBundleIconFile and CFBundleIconName must use the same native icon name.');
  await stat(path.join(resources, `${file}.icns`));
  if (!assets.some(asset => asset.AssetType === 'Icon Image' && asset.Name === name)) {
    throw new Error('The package lacks the native layered icon specified by CFBundleIconName.');
  }
  for (const appearance of ['NSAppearanceNameAqua', 'NSAppearanceNameDarkAqua']) {
    if (!assets.some(asset => asset.AssetType === 'IconImageStack' && asset.Name === name && asset.Appearance === appearance)) {
      throw new Error(`The package lacks native icon appearance: ${appearance}`);
    }
  }
}
console.log(`Native distribution check passed: ${(bytes / 1024 / 1024).toFixed(2)} MiB. No Node/npm runtime.`);

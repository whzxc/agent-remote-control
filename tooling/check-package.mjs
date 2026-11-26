import { desktopExecutable, desktopIdentifier, desktopName, desktopScheme, developmentConfig } from './dev-identity.mjs';
import { verifyMacosReleaseSignature } from './macos-signing.mjs';
import { requireXcode } from './macos-icons.mjs';
import { buildVersion } from './version.mjs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { toolFingerprint } from './catalog.mjs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2] || `dist/desktop/${buildVersion()}/darwin-arm64/${desktopName}.app`;
const adhoc = process.argv.includes('--adhoc');
const catalog = JSON.parse(await readFile(new URL('../shared/core/catalog.json', import.meta.url), 'utf8'));
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
  requireXcode(process.env);
  const plist = path.join(root, 'Contents/Info.plist');
  const value = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  const identifier = value('CFBundleIdentifier');
  const config = identifier === desktopIdentifier ? { productName: desktopName, scheme: desktopScheme } : developmentConfig();
  if (![desktopIdentifier, developmentConfig().identifier].includes(identifier) ||
      value('CFBundleExecutable') !== desktopExecutable || value('CFBundleDisplayName') !== config.productName ||
      value('CFBundleName') !== config.productName || value('LSMinimumSystemVersion') !== '13.0' ||
      value('CFBundleURLTypes:0:CFBundleURLSchemes:0') !== config.scheme) {
    throw new Error('Incorrect macOS package identity.');
  }
  for (const [file, id] of [[root, identifier], [path.join(root, 'Contents/Resources/bin/arc'), identifier + '.core'],
    [path.join(root, 'Contents/Resources/bin/arc-screen'), identifier + '.screen']]) {
    if (identifier === desktopIdentifier && !adhoc) verifyMacosReleaseSignature(file, id);
    else execFileSync('codesign', ['--verify', '--strict', '-R', `=identifier "${id}"`, file], { stdio: 'inherit' });
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

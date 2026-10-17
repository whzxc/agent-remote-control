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
    if (['node_modules', 'runtime', 'node', 'node.exe', 'npm', 'npx', 'desktop-launch.mjs'].includes(item.name)) throw new Error(`产物仍包含旧运行环境：${file}`);
    if (item.isDirectory()) await inspect(file);
    else bytes += (await stat(file)).size;
  }
}
await inspect(root);
if (process.platform === 'darwin' && root.endsWith('.app')) {
  const resources = path.join(root, 'Contents', 'Resources');
  const native = path.join(resources,'bin/arc');
  const version = buildVersion();
  const appVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(root, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (appVersion !== version) throw new Error('安装包版本与构建版本不一致。');
  if (execFileSync(native,['--version'],{encoding:'utf8'}).trim() !== version) throw new Error('安装包缺少同版本独立 Core。');
  execFileSync('codesign',['--verify','--strict',native],{stdio:'inherit'});
  execFileSync('codesign',['--verify','--strict',path.join(resources, 'bin/arc-screen')],{stdio:'inherit'});
  const assets = JSON.parse(execFileSync('xcrun', ['assetutil', '--info', path.join(resources, 'Assets.car')], { encoding: 'utf8' }));
  const name = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconName', path.join(root, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  const file = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(root, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (file !== name) throw new Error('CFBundleIconFile 与 CFBundleIconName 必须使用同一个原生图标名称。');
  await stat(path.join(resources, `${file}.icns`));
  if (!assets.some(asset => asset.AssetType === 'Icon Image' && asset.Name === name)) {
    throw new Error('安装包缺少与 CFBundleIconName 对应的原生分层图标。');
  }
  for (const appearance of ['NSAppearanceNameAqua', 'NSAppearanceNameDarkAqua']) {
    if (!assets.some(asset => asset.AssetType === 'IconImageStack' && asset.Name === name && asset.Appearance === appearance)) {
      throw new Error(`安装包缺少原生图标外观：${appearance}`);
    }
  }
}
console.log(`原生发行产物检查通过：${(bytes / 1024 / 1024).toFixed(2)} MiB，无 Node/npm 运行环境。`);

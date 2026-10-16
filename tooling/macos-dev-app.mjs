import { buildVersion } from './version.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { macosSigningIdentity, macosSigningArgs } from './macos-signing.mjs';

// Cargo's target runner receives the freshly built executable and app arguments.
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = path.resolve(process.argv[2]);
const contents = path.join(path.dirname(binary), 'bundle/macos/Agent Remote Control Dev.app/Contents');
const resources = path.join(contents, 'Resources');
mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
mkdirSync(resources, { recursive: true });
cpSync(path.join(root, 'target/dev-icon/Resources'), resources, { recursive: true });
cpSync(path.join(root, 'dist/native'), path.join(resources, 'bin'), { recursive: true });
const executable = path.join(contents, 'MacOS', path.basename(binary));
cpSync(binary, executable);
const config = JSON.parse(readFileSync(path.join(root, 'desktop/tauri.dev.conf.json'), 'utf8'));
const base = JSON.parse(readFileSync(path.join(root, 'desktop/tauri.conf.json'), 'utf8'));
const plist = path.join(contents, 'Info.plist');
cpSync(path.join(root, 'desktop/Info.plist'), plist);
const values = {
  CFBundleExecutable: path.basename(binary), CFBundleIdentifier: config.identifier,
  CFBundleName: config.productName, CFBundleDisplayName: config.productName,
  CFBundlePackageType: 'APPL', CFBundleVersion: buildVersion(),
  CFBundleShortVersionString: buildVersion(), CFBundleIconName: 'Icon',
};
for (const [key, value] of Object.entries(values)) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
}
// Keep the development bundle's URL handlers aligned with the shipped bundle.
const schemes = base.plugins?.['deep-link']?.desktop?.schemes || [];
if (schemes.length) {
  const add = value => execFileSync('/usr/libexec/PlistBuddy', ['-c', value, plist]);
  add('Add :CFBundleURLTypes array');
  add('Add :CFBundleURLTypes:0 dict');
  add(`Add :CFBundleURLTypes:0:CFBundleURLName string ${config.identifier}`);
  add('Add :CFBundleURLTypes:0:CFBundleURLSchemes array');
  schemes.forEach((scheme, index) => add(`Add :CFBundleURLTypes:0:CFBundleURLSchemes:${index} string ${scheme}`));
}
const env = { ...process.env };
const identity = macosSigningIdentity(env);
execFileSync('codesign', [...macosSigningArgs(identity, config.identifier, false), path.dirname(contents)], { env, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(root, 'tooling/check-package.mjs'), path.dirname(contents)], { env, stdio: 'inherit' });
// Tauri can kill its runner during rebuilds. A private stdin pipe lets the app
// observe that even after SIGKILL and shut down its managed tunnels normally.
const app = spawn(executable, process.argv.slice(3), {
  env: { ...env, CLC_DEV_SUPERVISED: '1' },
  stdio: ['pipe', 'inherit', 'inherit'],
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.stdin.end());
app.on('error', error => { console.error(error.message); process.exitCode = 1; });
app.on('exit', code => { process.exitCode = code ?? 1; });

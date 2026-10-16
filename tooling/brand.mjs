import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const variant = process.argv[2] || 'primary';
if (!['primary', 'alternate'].includes(variant) || process.argv.length > 3) {
  throw new Error('Usage: npm run brand -- primary|alternate');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'assets/brand', variant);
const icons = path.join(root, 'desktop/icons');
const copy = (from, to) => {
  const destination = path.join(root, to);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(path.join(source, from), destination);
};
execFileSync(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
  'icon', path.join(source, 'png/app-icon-1024.png'), '--output', icons], { stdio: 'inherit' });
// Keep the existing desktop-only layout; mobile targets are not shipped.
rmSync(path.join(icons, 'android'), { recursive: true, force: true });
rmSync(path.join(icons, 'ios'), { recursive: true, force: true });
cpSync(path.join(icons, 'icon.icns'), path.join(icons, 'macos/Icon.icns'));
rmSync(path.join(icons, 'icon.icns'));
copy('png/app-icon-1024.png', 'desktop/icons/dev/icon.png');
copy('png/app-icon-32.png', 'desktop/icons/tray-logo.png');
for (const suffix of ['', '@2x']) copy(`png/menubar-18Template${suffix}.png`, `desktop/icons/menubar-18Template${suffix}.png`);
copy('svg/app-icon.svg', 'desktop/icon.svg');
for (const file of ['mark.svg', 'mark-dark.svg', 'lockup.svg', 'lockup-dark.svg']) copy(`svg/${file}`, `ui/assets/arc/${file}`);
for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png']) copy(`icons/${file}`, `ui/assets/arc/${file}`);
copy('png/app-icon-256.png', 'ui/assets/arc/app-icon.png');

const composer = path.join(icons, 'AgentRemoteControl.icon');
rmSync(composer, { recursive: true, force: true });
copy('svg/mark.svg', 'desktop/icons/AgentRemoteControl.icon/Assets/mark.svg');
copy('svg/mark-dark.svg', 'desktop/icons/AgentRemoteControl.icon/Assets/mark-dark.svg');
writeFileSync(path.join(composer, 'icon.json'), JSON.stringify({
  'fill-specializations': [
    { value: { solid: 'srgb:0.88627,0.91373,0.89804,1.00000' } },
    { appearance: 'dark', value: { solid: 'srgb:0.09020,0.14510,0.12157,1.00000' } },
  ],
  groups: [{ layers: [{
    'image-name-specializations': [{ value: 'mark.svg' }, { appearance: 'dark', value: 'mark-dark.svg' }],
    name: 'ARC', glass: false,
    position: { scale: 5.9, 'translation-in-points': [0, 0] },
  }], shadow: { kind: 'neutral', opacity: 0 }, specular: false, translucency: { enabled: false, value: 0 } }],
  'supported-platforms': { squares: 'shared' },
}, null, 2) + '\n');
console.log(`Agent Remote Control brand: ${variant}`);

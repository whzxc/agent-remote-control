import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export function compileIcon(source, output, env) {
  mkdirSync(output, { recursive: true });
  const icon = path.join(output, 'Icon.icon');
  cpSync(source, icon, { recursive: true });
  execFileSync('xcrun', ['actool', icon, '--compile', output,
    '--output-format', 'human-readable-text', '--output-partial-info-plist', path.join(output, 'icon.plist'),
    '--app-icon', 'Icon', '--include-all-app-icons', '--enable-on-demand-resources', 'NO',
    '--development-region', 'en', '--target-device', 'mac', '--minimum-deployment-target', '26.0',
    '--platform', 'macosx'], { env, stdio: ['ignore', 'inherit', 'inherit'] });
}

export function requireXcode(env) {
  if (!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app/Contents/Developer')) {
    env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
  }
  let version;
  try {
    version = execFileSync('xcrun', ['actool', '--version', '--output-format=human-readable-text'],
      { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('Native macOS light and dark icons require full Xcode 26+. Set DEVELOPER_DIR to Xcode.app/Contents/Developer. Command Line Tools does not include actool.');
  }
  if (Number(version.match(/short-bundle-version:\s*(\d+)/)?.[1] ?? 0) < 26) {
    throw new Error('Native macOS light and dark icons require Xcode 26+. The current actool version is too old.');
  }
}

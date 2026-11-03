import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { releasePlatforms } from './release-support.mjs';
import { stableVersion } from './version.mjs';

const platforms = releasePlatforms(process.env.RELEASE_PLATFORMS);
const sourceSha = process.env.SOURCE_SHA;
const version = stableVersion(process.env.ARC_BUILD_VERSION);
if (!/^[a-f0-9]{40}$/.test(sourceSha) || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceSha
    || process.env.GITHUB_SHA !== sourceSha) throw new Error('Dispatch the workflow from the same full source SHA; refresh main and retry');
const linux = platforms.includes('linux');
console.log(JSON.stringify({ sourceSha, version, platforms, linux }, null, 2));
await appendFile(process.env.GITHUB_OUTPUT, `linux=${linux}\n`);

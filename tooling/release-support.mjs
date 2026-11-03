import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
export const ghOptions = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 };
export const transferOptions = {
  ...ghOptions, timeout: 10 * 60_000,
  env: { ...process.env, GODEBUG: [...(process.env.GODEBUG || '').split(',').filter(v => v && !v.startsWith('http2client=')), 'http2client=0'].join(',') },
};
export const gh = (args, options = {}) => execFileSync('gh', args, { ...ghOptions, ...options });
export const ghTransfer = args => execute('gh', args, transferOptions);
const ghRead = async args => (await execute('gh', args, ghOptions)).stdout;

export function releasePlatforms(value = 'mac,windows') {
  const platforms = value.split(',');
  if (new Set(platforms).size !== platforms.length || platforms.some(platform => !['mac', 'windows', 'linux'].includes(platform))) {
    throw new Error('--platforms accepts a nonempty comma-separated selection of mac,windows,linux');
  }
  return platforms;
}

export async function releaseById(repo, id, query = ghRead) {
  return JSON.parse(await query(['api', `repos/${repo}/releases/${id}`]));
}

export async function requireDraftRelease(repo, id, tag, query = ghRead) {
  const current = await releaseById(repo, id, query);
  if (current?.draft !== true || current.id !== id || current.tag_name !== tag) throw new Error('Original draft changed; refusing to upload or publish');
  return current;
}

export async function uploadReleaseAsset({ repo, releaseId, tag, asset, file, timer }, { query = ghRead, transfer = ghTransfer } = {}) {
  const current = await timer.run(`asset prepare ${asset.name}`, async () => {
    const draft = await requireDraftRelease(repo, releaseId, tag, query);
    const existing = draft.assets.find(remote => remote.name === asset.name);
    if (existing && !assetMatches(asset, existing)) {
      await query(['api', `repos/${repo}/releases/assets/${existing.id}`, '--method', 'DELETE']);
    }
    return draft;
  });
  if (assetMatches(asset, current.assets.find(remote => remote.name === asset.name))) {
    timer.skip(`asset upload ${asset.name}`);
    return false;
  }
  const url = new URL(current.upload_url.replace(/\{.*$/, ''));
  if (url.origin !== 'https://uploads.github.com' || url.pathname !== `/repos/${repo}/releases/${releaseId}/assets`) throw new Error('Unexpected release upload URL');
  url.searchParams.set('name', asset.name);
  await timer.run(`asset upload ${asset.name}`, async () => {
    const { stdout } = await transfer(['api', url.href, '--method', 'POST', '--header', 'Content-Type: application/octet-stream', '--input', file]);
    if (!assetMatches(asset, JSON.parse(stdout))) throw new Error(`Uploaded asset size/digest mismatch: ${asset.name}`);
  }, { bytes: asset.size });
  return true;
}

export function releaseByTag(repo, tag, query = gh) {
  try { return JSON.parse(query(['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`])); }
  catch (error) {
    if (error.status !== 1 || !/\(HTTP 404\)/.test(String(error.stderr))) throw error;
  }
  // GitHub's tag endpoint omits drafts. Filter pages before buffering,
  // then fetch the matching release by ID with its full asset inventory.
  let id;
  for (let page = 1; ; page++) {
    const result = JSON.parse(query(['api', `repos/${repo}/releases?per_page=100&page=${page}`, '--jq',
      `{count: length, matches: [.[] | select(.tag_name == ${JSON.stringify(tag)}) | {id}]}`]));
    for (const match of result.matches) {
      if (id !== undefined) throw new Error(`Multiple releases match ${tag}; resolve duplicate drafts before resuming`);
      id = match.id;
    }
    if (result.count < 100) return id === undefined ? undefined : JSON.parse(query(['api', `repos/${repo}/releases/${id}`]));
  }
}

// Filter each page with gh's jq before buffering; never slurp release bodies/assets.
export function publishedTags(repo, query = gh) {
  const tags = [];
  for (let page = 1; ; page++) {
    const entries = JSON.parse(query(['api', `repos/${repo}/releases?per_page=100&page=${page}`, '--jq',
      '[.[] | {tag_name, draft, prerelease}]']));
    tags.push(...entries.filter(item => !item.draft && !item.prerelease).map(item => item.tag_name));
    if (entries.length < 100) return tags;
  }
}

export async function fileDigest(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return `sha256:${digest.digest('hex')}`;
}

export function assetMatches(local, remote) {
  return !!remote && remote.name === local.name && remote.state === 'uploaded' && remote.size === local.size
    && (!remote.digest || remote.digest === local.digest);
}

export function validateRemoteAssets(assets, remoteAssets) {
  if (remoteAssets.length !== assets.length) throw new Error('Remote asset inventory differs from the complete platform set');
  for (const asset of assets) {
    if (!assetMatches(asset, remoteAssets.find(item => item.name === asset.name))) {
      throw new Error(`Remote size/digest mismatch or missing asset: ${asset.name}`);
    }
  }
}

export function validateArtifactInventory(assets, checksums, recordedAssets) {
  const sums = checksums.trim().split('\n').sort();
  const expected = assets.filter(asset => asset.name !== 'SHA256SUMS.txt').map(asset => `${asset.digest.slice(7)}  ${asset.name}`).sort();
  if (JSON.stringify(sums) !== JSON.stringify(expected)) throw new Error('Checksum inventory does not match the complete platform set');
  if (recordedAssets && JSON.stringify(assets) !== JSON.stringify(recordedAssets)) throw new Error('Verified release artifacts changed; refusing to resume');
}

export function publicationStages(state, release) {
  if (release && !release.draft) {
    if (!state.publishAttempted || state.releaseId !== release.id) throw new Error('Public versions cannot be overwritten');
    return ['remote verification', 'readback'];
  }
  const complete = release && state.assets.every(asset => assetMatches(asset, release.assets.find(remote => remote.name === asset.name)));
  return [...(complete ? [] : ['upload']), 'remote verification', 'publish', 'readback'];
}

export function validateResume(state, { version, sourceSha, platforms }) {
  if (state.schema !== 1 || !state.verified || state.version !== version || state.sourceSha !== sourceSha
      || !Array.isArray(state.platforms) || !Array.isArray(state.assets) || !state.assets.length
      || [...state.platforms].sort().join(',') !== [...platforms].sort().join(',')) {
    throw new Error('Resume requires verified artifacts for the same version, source commit, and platforms');
  }
}

export function platformAssetNames(manifest, version, platforms) {
  const keys = [...(platforms.includes('mac') ? ['darwin-aarch64'] : []),
    ...(platforms.includes('windows') ? ['windows-x86_64', 'windows-x86_64-nsis'] : [])];
  if (manifest.version !== version || Object.keys(manifest.platforms).sort().join(',') !== keys.sort().join(',')) {
    throw new Error('Incomplete or unexpected updater platform set');
  }
  const names = new Set(['latest.json', 'release-notes.md', 'SHA256SUMS.txt']);
  for (const key of keys) {
    const name = new URL(manifest.platforms[key].url).pathname.split('/').at(-1);
    names.add(name); names.add(name + '.sig');
  }
  if (platforms.includes('mac')) {
    names.add(`agent-remote-control_${version}_aarch64.dmg`);
    names.add('agent-remote-control.rb');
  }
  if (platforms.includes('linux')) {
    for (const arch of ['x86_64', 'aarch64']) names.add(`agent-remote-control-v${version}-linux-${arch}.tar.gz`);
    names.add('install-agent-remote-control.sh');
  }
  return [...names].sort();
}

export async function retry(operation, { attempts = 4, delayMs = 2000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onRetry = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts) throw error;
      const delay = delayMs * 2 ** (attempt - 1);
      onRetry(error, attempt, delay);
      await sleep(delay);
    }
  }
}

export async function boundedMap(items, operation, concurrency = 3) {
  let index = 0, failure;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && index < items.length) {
      const item = items[index++];
      try { await operation(item); } catch (error) { failure ??= error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
}

export async function parallelPlatforms(operations) {
  const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Platform builds failed; successful artifacts are retained');
  return results.map(result => result.value);
}

export function dependencyEnv(env) {
  const result = { ...env };
  // npm run exports user .npmrc settings as CLI-level environment settings.
  // npm ci must read the original .npmrc policy rather than reject that export.
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete result[key];
  return result;
}

export function stageTimer(file = process.env.ARC_RELEASE_TIMINGS_FILE, log = console.log) {
  function record(name, started, status, startedAt, bytes) {
    const elapsed = performance.now() - started;
    const transfer = bytes === undefined ? {} : { bytes, ...(status === 'ok' ? { bytesPerSecond: Math.round(bytes * 1000 / Math.max(elapsed, 1)) } : {}) };
    const rate = transfer.bytesPerSecond === undefined ? '' : `, ${(transfer.bytesPerSecond / 1024 ** 2).toFixed(2)} MiB/s`;
    const size = bytes === undefined ? '' : `, ${(bytes / 1024 ** 2).toFixed(2)} MiB${rate}`;
    log(`[stage] END ${name} ${status} (${(elapsed / 1000).toFixed(1)}s${size})`);
    if (file) appendFileSync(file, JSON.stringify({ stage: name, status, seconds: +(elapsed / 1000).toFixed(1), startedAt, finishedAt: new Date().toISOString(), platform: process.env.ARC_RELEASE_PLATFORM, ...transfer }) + '\n');
  }
  return {
    async run(name, operation, { bytes } = {}) {
      const started = performance.now();
      const startedAt = new Date().toISOString();
      log(`[stage] START ${name}`);
      try { const result = await operation(); record(name, started, 'ok', startedAt, bytes); return result; }
      catch (error) { record(name, started, 'failed', startedAt, bytes); throw error; }
    },
    skip(name) { log(`[stage] START ${name}`); record(name, performance.now(), 'skipped'); },
  };
}

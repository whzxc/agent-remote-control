import type { Locale } from "../i18nMessage.ts";

export type PublishedRelease = { version: string; notes: string };

const languageMarker = /^<!-- lang:zh-CN -->\s*$/m;
const stableVersion = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/;
const headings = [
  ["Features", "功能"],
  ["Improvements", "改进"],
  ["Fixes", "修复"],
  ["Required actions", "需要操作"],
  ["Changes", "更新内容"],
];

export function compareReleaseVersions(a: string, b: string) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function releaseList(releases: readonly PublishedRelease[], through?: string) {
  const bound = through && stableVersion.test(through) ? through : undefined;
  return releases.filter(({ version }) => stableVersion.test(version)
    && (!bound || compareReleaseVersions(version, bound) <= 0))
    .sort((a, b) => compareReleaseVersions(b.version, a.version));
}

export function updateRange(releases: readonly PublishedRelease[], current: string | undefined, target: PublishedRelease) {
  if (!current || !stableVersion.test(current) || !stableVersion.test(target.version)) return [target];
  const published = releaseList(releases, target.version);
  if (!published.some(({ version }) => version === current)) return [target];
  const earlier = published.filter(({ version }) => version !== target.version && compareReleaseVersions(version, current) > 0);
  const targetNotes = published.find(({ version }) => version === target.version)?.notes;
  return [target.notes.trim() || !targetNotes ? target : { ...target, notes: targetNotes }, ...earlier];
}

export function localizedReleaseNotes(release: PublishedRelease, locale: Locale) {
  const [en, zh] = release.notes.split(languageMarker, 2);
  const markdown = ((locale === "zh-CN" && zh?.trim()) || en).trim();
  // The original announcement belongs to 0.9.19. Later legacy releases repeated it.
  return release.version === "0.9.19" ? markdown
    : markdown.replace(/^## MCP Events \/ 事件升级[^\S\r\n]*\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/m, "").trim();
}

export function groupedReleaseNotes(releases: readonly PublishedRelease[], locale: Locale) {
  const language = locale === "zh-CN" ? 1 : 0;
  const groups = new Map<string, Array<{ version: string; markdown: string }>>();
  for (const release of releases) {
    const markdown = localizedReleaseNotes(release, locale);
    const sections = markdown.split(/^##\s+([^\r\n]+)\r?$/m);
    const add = (title: string, text: string) => {
      const body = text.trim();
      if (!body) return;
      const known = headings.find(pair => pair.includes(title.trim()));
      const name = known?.[language] ?? title.trim();
      const entries = groups.get(name) ?? [];
      if (!entries.some(entry => entry.markdown === body)) entries.push({ version: release.version, markdown: body });
      groups.set(name, entries);
    };
    add(headings[4][language], sections[0]);
    for (let i = 1; i < sections.length; i += 2) add(sections[i], sections[i + 1]);
  }
  return [...new Set([...headings.map(pair => pair[language]), ...groups.keys()])]
    .flatMap(title => groups.has(title) ? [{ title, entries: groups.get(title)! }] : []);
}

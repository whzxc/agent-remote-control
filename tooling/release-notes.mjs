import { readFile } from 'node:fs/promises';

const headings = {
  features: ['Features', '功能'],
  improvements: ['Improvements', '改进'],
  fixes: ['Fixes', '修复'],
  actions: ['Required actions', '需要操作'],
};

export const chineseNotesMarker = '<!-- lang:zh-CN -->';

export function renderReleaseNotes(entries) {
  if (!Array.isArray(entries)) throw new Error('Release notes must contain an array of entries');
  const groups = new Map();
  for (const entry of entries) {
    if (!entry || !Object.hasOwn(headings, entry.section)
      || [entry.en, entry['zh-CN']].some(text => typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text))) {
      throw new Error('Each release note needs a section and one line of text in English and Simplified Chinese');
    }
    const rows = groups.get(entry.section) ?? [];
    rows.push(entry);
    groups.set(entry.section, rows);
  }
  const render = (locale, index) => Object.entries(headings).flatMap(([section, titles]) => {
    const rows = groups.get(section);
    return rows ? [`## ${titles[index]}\n\n${rows.map(row => `- ${row[locale].trim()}`).join('\n')}`] : [];
  }).join('\n\n');
  const en = render('en', 0) || 'Maintenance update.';
  const zh = render('zh-CN', 1) || '维护更新。';
  return { en, zh, body: `${en}\n\n${chineseNotesMarker}\n\n${zh}\n` };
}

export async function readReleaseNotes(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release notes require a stable version');
  const file = `release-notes/${version}.json`;
  try {
    return renderReleaseNotes(JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Add English and Simplified Chinese release notes to ${file} before packaging`);
    throw new Error(`${file}: ${error.message}`);
  }
}

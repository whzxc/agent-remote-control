import type { AgentActivitySession, AgentTimelineEntry } from '../types.ts';

/** Fallback for unclassified older Core responses; retire when those projections are no longer supported. */
export function claudeRequestText(text: string): string {
  const wrapper = /^\s*<(?:task-notification\b|local-command-[\w-]+\b|command-(?:name|message|args)\b|bash-(?:input|stdout|stderr)\b|subagent[_-]notification\b|teammate-message\b|hook-output\b|user-prompt-submit-hook\b|ide_(?:opened_file|selection)\b|turn_aborted\b)/i;
  const fields = /^\s*<task-id>[\s\S]*<(?:tool-use-id|output-file)>/i;
  if (wrapper.test(text) || fields.test(text)) return '';
  const cleaned = text.replace(/^(?:\s*<system[-_]reminder\b[^>]*>[\s\S]*?(?:<\/system[-_]reminder\s*>|$)\s*)+/i, '');
  return wrapper.test(cleaned) || fields.test(cleaned) ? '' : cleaned === text ? text : cleaned.trim();
}

export function presentActivity<T extends AgentActivitySession>(agent: string, session: T): T {
  if (agent !== 'claude') return session;
  return { ...session, title: session.title && claudeRequestText(session.title),
    headline: claudeRequestText(session.headline), fallbackHeadline: session.fallbackHeadline && claudeRequestText(session.fallbackHeadline),
    recentContent: session.recentContent?.map(claudeRequestText).filter(Boolean) };
}

export function presentTimelineEntries(agent: string, entries: AgentTimelineEntry[]): AgentTimelineEntry[] {
  if (agent !== 'claude') return entries;
  return entries.flatMap(entry => {
    if (entry.type !== 'user' || !entry.text || entry.inputOrigin === 'human' || entry.controlSource) return [entry];
    const text = claudeRequestText(entry.text);
    return text ? [text === entry.text ? entry : { ...entry, text }] : [];
  });
}

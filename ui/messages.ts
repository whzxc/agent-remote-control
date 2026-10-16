import { t, type MessageKey } from './i18n';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

// Only the presentation boundary translates known ARC messages. Raw service
// responses, logs, task content, identifiers and MCP contracts stay unchanged.
const messagePatterns = Object.entries({ en, 'zh-CN': zhCN }).flatMap(([, messages]) =>
  Object.entries(messages).map(([key, message]) => {
    const names: string[] = [];
    const pattern = message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{(\w+)\\\}/g, (_match, name: string) => { names.push(name); return name === 'count' || name === 'minutes' ? '(\\d+(?:\\.\\d+)?)' : '(.*?)'; });
    return { key: key as MessageKey, message, names, pattern: new RegExp(`^${pattern}$`, 's') };
  }),
);
export function displayMessage(message: string | undefined | null, depth = 0): string {
  if (!message) return '';
  const exact = messagePatterns.find(entry => entry.message === message);
  if (exact) return t(exact.key);
  for (const entry of messagePatterns) {
    if (!entry.names.length) continue;
    const match = message.match(entry.pattern);
    if (match) return t(entry.key, Object.fromEntries(entry.names.map((name, index) => [name, depth < 3 ? displayMessage(match[index + 1]!, depth + 1) : match[index + 1]!] )));
  }
  return message;
}

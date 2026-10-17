import type { ProviderSnapshot } from './types';

export function usageLink(provider: ProviderSnapshot): string | undefined {
  // The Go usage response currently contains no workspace identity.
  const links: Record<string, string> = {
    antigravity: 'https://antigravity.google/',
    codex: 'https://chatgpt.com/codex/cloud/settings/analytics#usage',
    'opencode-go': 'https://opencode.ai/console',
    'claude-code': 'https://claude.ai/settings/usage',
    cursor: 'https://cursor.com/dashboard?tab=usage',
    grok: 'https://grok.com/',
    'kimi-code': 'https://www.kimi.com/code/console',
  };
  return links[provider.providerId];
}

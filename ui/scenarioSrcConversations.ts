import type { SrcContainer, SrcConversationsResult, SrcBindArgs, SrcOpenArgs, SrcContainerStatus } from './srcConversations';

// Metadata only. This fixture never opens a native view or reads browser credentials.
export function srcConversationsScenario() {
  const at = '2026-01-01T12:00:00.000Z';
  const chatId = '550e8400-e29b-41d4-a716-446655440000';
  const coworkId = 'cse_010000000000000000000001';
  const accounts: SrcContainer[] = (['signed-in', 'expired', 'not-imported', 'unsupported', 'importing', 'signed-in-pending', 'import-blocked', 'import-mismatch', 'import-unverified'] as SrcContainerStatus[]).map((status, i) => ({
    accountId: i === 0 ? 'account-source' : `source-${status}`, storeId: status === 'unsupported' ? null : `550e8400-e29b-41d4-a716-${String(i + 1).padStart(12, '0')}`,
    status, detectedAccountId: status === 'import-mismatch' ? 'account-source' : null, reason: status === 'import-mismatch' ? 'org-mismatch' : status === 'import-unverified' ? 'org-unverified' : status === 'import-blocked' ? 'keychain-denied' : null, hint: status === 'import-mismatch' ? 'Import this profile into the detected ARC account instead.' : status === 'import-unverified' ? 'Select a known matching profile or explicitly retry with allowUnverified:true.' : ['importing', 'import-blocked'].includes(status) ? 'Enter the macOS login password in the Chrome Safe Storage prompt and choose Always Allow.' : null, safariUserAgent: false, open: i === 0, currentConversation: i === 0 ? { kind: 'chat', id: chatId, url: `https://claude.ai/chat/${chatId}` } : null,
    conversations: i === 0 ? [
      { accountId: 'account-source', aliases: [], kind: 'chat', id: chatId, url: `https://claude.ai/chat/${chatId}`, firstSeenAt: at, lastSeenAt: at, lastActiveAt: at, basis: 'observed', taskRefs: [{ agent: 'codex', id: 'fixture-task-1', basis: 'correlated' }] },
      { accountId: 'account-source', aliases: [], kind: 'cowork', id: coworkId, url: `https://claude.ai/cowork/${coworkId}`, firstSeenAt: at, lastSeenAt: at, lastActiveAt: null, basis: 'notify-target', taskRefs: [{ agent: 'claude', id: 'fixture-task-2', basis: 'notify-target' }] },
    ] : [],
  }));
  return (path: string, method: string, raw?: unknown): unknown => {
    if (!path.startsWith('src-conversations/')) return undefined;
    if (path === 'src-conversations/profiles' && method === 'GET') return { profiles: [{ directory: 'Default', name: 'Personal' }, { directory: 'Profile 1', name: 'Example Studio' }] };
    const body = (raw ?? {}) as SrcOpenArgs & SrcBindArgs & { profile?: string };
    if (path === 'src-conversations/query' && method === 'POST') return { accounts: accounts.filter(a => !body.accountId || a.accountId === body.accountId), correlationSeconds: 600 } satisfies SrcConversationsResult;
    const account = accounts.find(a => a.accountId === body.accountId);
    if (!account) throw new Error('SRC_ACCOUNT_REQUIRED');
    if (path === 'src-conversations/bind' && method === 'POST') {
      const conversation = body.conversationId === null ? null : account.conversations.find(c => c.id === body.conversationId);
      if (conversation === undefined) throw new Error('SRC_CONVERSATION_NOT_FOUND');
      for (const row of accounts.flatMap(a => a.conversations)) row.taskRefs = row.taskRefs.filter(t => t.agent !== body.agent || t.id !== body.taskId);
      conversation?.taskRefs.push({ agent: body.agent, id: body.taskId, basis: 'manual' });
      return { conversation: conversation ? { accountId: account.accountId, kind: conversation.kind, id: conversation.id, url: conversation.url, basis: 'manual' } : null };
    }
    if (path === 'src-conversations/clear' && method === 'POST') {
      if (account.status !== 'unsupported') { account.status = 'not-imported'; account.storeId = null; account.open = false; account.currentConversation = null; account.reason = null; account.hint = null; account.detectedAccountId = null; }
      return { accountId: account.accountId, status: account.status };
    }
    if (path === 'src-conversations/import' && method === 'POST') {
      if (account.status !== 'unsupported') { account.status = 'importing'; account.reason = null; account.hint = 'Enter the macOS login password in the Chrome Safe Storage prompt and choose Always Allow.'; }
      return { accountId: account.accountId, status: account.status, ...(account.status === 'importing' ? { next: { via: 'query', op: 'src_conversations', args: { accountId: account.accountId }, hint: 'Poll this account import status.' } } : {}) };
    }
    if (path === 'src-conversations/open' && method === 'POST') {
      if (account.status === 'unsupported') return { accountId: account.accountId, status: account.status };
      if (body.safariUserAgent !== undefined) account.safariUserAgent = body.safariUserAgent;
      if (body.conversationId) {
        const ref = account.conversations.find(c => c.id === body.conversationId);
        if (!ref) throw new Error('SRC_CONVERSATION_NOT_FOUND');
        account.currentConversation = { kind: ref.kind, id: ref.id, url: ref.url };
      } else account.currentConversation = null;
      account.open = true;
      return { accountId: account.accountId, status: account.status };
    }
    throw new Error('SCENARIO_ACTION_UNAVAILABLE: source conversations');
  };
}

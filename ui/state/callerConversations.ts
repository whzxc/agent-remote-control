import type { AgentConversation, AgentConversationPage, DispatchSummary } from '../types';
export type Caller = NonNullable<DispatchSummary['caller']>;
export interface CallerConversation { agent: string; conversation: AgentConversation }
export function findCallerConversation(rows: CallerConversation[], caller: Caller) {
  return rows.find(row => row.agent === caller.agent && (row.conversation.id === caller.conversationId || row.conversation.nativeSessionId === caller.conversationId));
}
// The native metadata API is paginated. Resolve the requested conversation IDs,
// including ARC-task/native-session aliases, without reading timelines or guessing titles.
export async function lookupCallerConversations(callers: Caller[], loaded: CallerConversation[], readPage: (agent: string, cursor?: string) => Promise<AgentConversationPage>) {
  const found = [...loaded];
  for (const agent of new Set(callers.map(c => c.agent))) {
    let pending = callers.filter(c => c.agent === agent && !findCallerConversation(found, c)?.conversation.title);
    let cursor: string | undefined;
    const seen = new Set<string>();
    while (pending.length) {
      const page = await readPage(agent, cursor);
      for (const conversation of page.data) if (pending.some(c => c.conversationId === conversation.id || c.conversationId === conversation.nativeSessionId)) {
        const previous = found.findIndex(row => row.agent === agent && row.conversation.id === conversation.id);
        if (previous >= 0) found[previous] = { agent, conversation };
        else found.push({ agent, conversation });
      }
      pending = pending.filter(c => !findCallerConversation(found, c)?.conversation.title);
      cursor = page.nextCursor ?? undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
  }
  return found.filter(row => callers.some(c => findCallerConversation([row], c)));
}

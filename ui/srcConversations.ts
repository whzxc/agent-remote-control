export type SrcContainerStatus = 'unsupported' | 'not-imported' | 'signed-in' | 'expired' | 'importing' | 'signed-in-pending' | 'import-blocked' | 'import-mismatch' | 'import-unverified';
type SrcConversationBasis = 'observed' | 'notify-target' | 'correlated' | 'manual';
export type SrcConversationRef = { accountId: string; kind: 'chat' | 'cowork'; id: string; url: string; basis: SrcConversationBasis };
type SrcConversation = SrcConversationRef & {
  aliases: string[];
  firstSeenAt: string; lastSeenAt: string; lastActiveAt: string | null;
  taskRefs: Array<{ agent: string; id: string; basis: SrcConversationBasis }>;
};
export type SrcContainer = {
  accountId: string; storeId: string | null; status: SrcContainerStatus; reason?: string | null; hint?: string | null; detectedAccountId?: string | null; safariUserAgent: boolean; open: boolean;
  currentConversation: Pick<SrcConversationRef, 'kind' | 'id' | 'url'> | null;
  conversations: SrcConversation[];
};
export type SrcConversationsResult = { accounts: SrcContainer[]; correlationSeconds: number };
export type SrcOpenArgs = { accountId: string; safariUserAgent?: boolean } & ({ conversationId?: never; url?: string } | { conversationId: string; url?: never });
export type SrcBindArgs = { accountId: string; agent: string; taskId: string; conversationId: string | null };

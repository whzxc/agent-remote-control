export interface AXActor { type: string; sourceId?: string }
export interface AXEvidence {
  kind: string; id?: string; availability?: string; state?: string; operation?: string;
  observedAt?: string | null; coreBuild?: string | null; desktopBuild?: string | null;
  references?: { kind: string; id: string }[];
}
export interface AXHistory {
  action: string; at: string; actor: AXActor; revision: number;
  detail?: { reason?: string; commit?: string; document?: string; verification?: AXEvidence[] };
}
export interface AXEntry {
  id: string; revision: number; kind: string; symptom: string; expected: string;
  reproductionHints?: string; severity?: string | null; resources: string[]; source: AXActor;
  firstSeenAt?: string | null; lastSeenAt?: string | null; occurrenceCount: number;
  status: string; resolution?: string | null; candidateState?: string | null; mergedInto?: string | null;
  evidence?: AXEvidence[]; history: AXHistory[];
}
export interface AXPage {
  entries: AXEntry[]; nextCursor?: string | null; observedAt: string; projectionPending?: boolean;
}
export const axClosed = (entry: AXEntry) => entry.status === 'closed' || entry.status === 'merged';
export function axUpdated(entry: AXEntry) {
  return Math.max(0, ...[entry.firstSeenAt, entry.lastSeenAt, ...entry.history.map(item => item.at)]
    .map(value => Date.parse(value ?? '')).filter(Number.isFinite));
}
export function axRows(entries: readonly AXEntry[], closed: boolean, search: string) {
  const query = search.trim().toLocaleLowerCase();
  return entries.filter(entry => axClosed(entry) === closed && (!query || `${entry.id} ${entry.symptom}`.toLocaleLowerCase().includes(query)))
    .sort((a, b) => axUpdated(b) - axUpdated(a) || a.id.localeCompare(b.id));
}
export function axStatus(entry: AXEntry) {
  if (!axClosed(entry)) return entry.status;
  return entry.status === 'merged' ? 'merged' : entry.candidateState === 'rejected' ? 'rejected' : entry.resolution ?? 'closed';
}
export function axDecision(entry: AXEntry) {
  for (const item of [...entry.history].reverse()) {
    if (item.action === 'reopen') return undefined;
    if (['fix', 'document', 'wontfix', 'merged', 'reject'].includes(item.action)) return item;
  }
}

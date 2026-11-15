export function RecordListRow({ children }: { children: unknown }) { return <span class="text-small leading-5">{children}</span>; }
export function RecordFooter({ children }: { children: unknown }) { return <footer class="text-meta text-text-tertiary">{children}</footer>; }
export function RecordDisclosure({ children }: { children: unknown }) { return <details class="text-meta text-text-tertiary">{children}</details>; }
export function RecordEvent({ children }: { children: unknown }) { return <li class="text-small leading-5">{children}</li>; }
import { Frame } from 'adg';
import { Card } from '../components/card';
import { Tile } from '../components/tile';

export function RecordRow({ children }: { children: unknown }) {
  return <Card class="p-4! gap-4! flex-row! items-center! min-h-16">{children}</Card>;
}
export function RecordCard(props: Parameters<typeof RecordRow>[0]) { return <RecordRow {...props}/>; }
export function RecordMeta({ children }: { children: unknown }) {
  return <span class="flex flex-wrap items-center gap-x-1 text-meta leading-[13px] text-text-secondary">{children}</span>;
}
export function RecordHeading({ children, count, attention = false }: { children: unknown; count?: number; attention?: boolean }) {
  return <h2 class={`flex flex-wrap items-center gap-[6px] mt-[6px] mb-2 text-meta leading-4 font-semibold ${attention ? 'text-warning' : 'text-text-secondary'}`}>
    {children}{count !== undefined && <span class="font-normal text-text-tertiary">{count}</span>}
  </h2>;
}
export default () => <Frame name="record" width={560}><div class="w-full"><RecordHeading count={1}>Activity</RecordHeading><RecordRow>
  <Tile icon="activity" tone="neutral" form="phase"/><div class="flex-1"><strong class="text-small leading-[19px] font-semibold">Review changes</strong><RecordMeta>Completed · Today</RecordMeta></div>
</RecordRow></div></Frame>;

import type { ReactNode } from "react";
export function RecordListRow({ children }: { children: ReactNode }) { return <span className="text-small leading-5">{children}</span>; }
export function RecordFooter({ children }: { children: ReactNode }) { return <footer className="text-meta text-text-tertiary">{children}</footer>; }
export function RecordDisclosure({ children }: { children: ReactNode }) { return <details className="text-meta text-text-tertiary">{children}</details>; }
export function RecordEvent({ children }: { children: ReactNode }) { return <li className="text-small leading-5">{children}</li>; }
import { Frame } from 'adg';
import { Card } from '../components/card';
import { Tile } from '../components/tile';

export function RecordRow({ children }: { children: ReactNode }) {
  return <Card className="p-4! gap-4! flex-row! items-center! min-h-16">{children}</Card>;
}
export function RecordCard(props: Parameters<typeof RecordRow>[0]) { return <RecordRow {...props}/>; }
export function RecordMeta({ children }: { children: ReactNode }) {
  return <span className="flex flex-wrap items-center gap-x-1 text-meta leading-[13px] text-text-secondary">{children}</span>;
}
export function RecordHeading({ children, count, attention = false }: { children: ReactNode; count?: number; attention?: boolean }) {
  return <h2 className={`flex flex-wrap items-center gap-[6px] mt-[6px] mb-2 text-meta leading-4 font-semibold ${attention ? 'text-warning' : 'text-text-secondary'}`}>
    {children}{count !== undefined && <span className="font-normal text-text-tertiary">{count}</span>}
  </h2>;
}
export default () => <Frame name="record" width={560}><div className="w-full"><RecordHeading count={1}>Activity</RecordHeading><RecordRow>
  <Tile icon="activity" tone="neutral" form="phase"/><div className="flex-1"><strong className="text-small leading-(--line-small) font-semibold">Review changes</strong><RecordMeta>Completed · Today</RecordMeta></div>
</RecordRow></div></Frame>;

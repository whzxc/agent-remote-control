import { Frame } from 'adg';
export function RecordSurface({ children }: { children: unknown }) { return <div class="text-small text-text">{children}</div>; }
export function RecordDetail({ children }: { children: unknown }) { return <section class="text-small leading-5">{children}</section>; }
export function RecordListRow({ children }: { children: unknown }) { return <span class="text-small leading-5">{children}</span>; }
export function RecordFooter({ children }: { children: unknown }) { return <footer class="text-meta text-text-tertiary">{children}</footer>; }
export function RecordEmpty({ children }: { children: unknown }) { return <div class="text-small text-text-tertiary text-center">{children}</div>; }
export function RecordDisclosure({ children }: { children: unknown }) { return <details class="text-meta text-text-tertiary">{children}</details>; }
export function RecordEvent({ children }: { children: unknown }) { return <li class="text-small leading-5">{children}</li>; }
export default () => <Frame name="detail" width={512}><RecordSurface><RecordDetail>Review changes</RecordDetail><RecordFooter>Today</RecordFooter></RecordSurface></Frame>;

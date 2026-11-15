import { Frame } from 'adg';
export function RecordSurface({ children, class: extra = '' }: { children: unknown; class?: string }) { return <div class={extra}>{children}</div>; }
export function RecordDetail({ children, class: extra = '', variant = 'record' }: { children: unknown; class?: string; variant?: 'record'|'issue' }) { return <section class={extra} data-variant={variant}>{children}</section>; }
export function RecordEmpty({ children }: { children: unknown }) { return <div class="text-small text-text-tertiary text-center">{children}</div>; }
export default () => <Frame name="detail" width={512}><RecordSurface><RecordDetail>Review changes</RecordDetail><p class="text-meta text-text-tertiary">Today</p></RecordSurface></Frame>;

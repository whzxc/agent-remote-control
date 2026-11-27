import type { ReactNode } from "react";
import { Frame } from 'adg';
export function RecordSurface({ children, className: extra = '' }: { children: ReactNode; className?: string }) { return <div className={extra}>{children}</div>; }
export function RecordDetail({ children, className: extra = '', variant = 'record' }: { children: ReactNode; className?: string; variant?: 'record'|'issue' }) { return <section className={extra} data-variant={variant}>{children}</section>; }
export function RecordEmpty({ children }: { children: ReactNode }) { return <div className="text-small text-text-tertiary text-center">{children}</div>; }
export default () => <Frame name="detail" width={512}><RecordSurface><RecordDetail>Review changes</RecordDetail><p className="text-meta text-text-tertiary">Today</p></RecordSurface></Frame>;

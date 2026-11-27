import type { ReactNode } from "react";
import {Frame} from 'adg';
export function QuotaDetail({children}:{children:ReactNode}){return <div className="flex flex-col gap-2 text-caption leading-[14px]">{children}</div>}
export function QuotaPopover({children}:{children:ReactNode}){return <div className="rounded-tile bg-surface-raised font-(family-name:--font-rounded) text-text shadow-md px-3 py-2">{children}</div>}
export function QuotaHistory({children}:{children:ReactNode}){return <div className="text-meta leading-[1.4]">{children}</div>}
export function QuotaPeriod({children}:{children:ReactNode}){return <div className="flex justify-between gap-[10px] tabular-nums">{children}</div>}
export function QuotaCredit({children}:{children:ReactNode}){return <span className="inline-grid place-items-center w-[18px] h-[18px] rounded-full bg-accent text-white text-caption">{children}</span>}
export function QuotaOverview({children}:{children:ReactNode}){return <section className="text-text">{children}</section>}
export function QuotaBreakdown({children}:{children:ReactNode}){return <div className="text-small">{children}</div>}
export default ()=><Frame name="history" width={288}><QuotaPopover><QuotaDetail><strong className="text-[14px] leading-(--line-small) font-semibold">Reset credits</strong><QuotaPeriod><span><QuotaCredit>2</QuotaCredit>Tomorrow</span><span>12 hours</span></QuotaPeriod></QuotaDetail></QuotaPopover></Frame>;

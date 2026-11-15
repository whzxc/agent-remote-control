import {Frame} from 'adg';
export function QuotaDetail({children}:{children:unknown}){return <div class="flex flex-col gap-2 text-[11.5px] leading-[14px]">{children}</div>}
export function QuotaPopover({children}:{children:unknown}){return <div class="rounded-[10px] bg-surface-raised text-text shadow-md px-3 py-2">{children}</div>}
export function QuotaHistory({children}:{children:unknown}){return <div class="text-meta leading-[1.4]">{children}</div>}
export function QuotaPeriod({children}:{children:unknown}){return <div class="flex justify-between gap-[10px] tabular-nums">{children}</div>}
export function QuotaCredit({children}:{children:unknown}){return <span class="inline-grid place-items-center w-[18px] h-[18px] rounded-full bg-accent text-white text-[10px]">{children}</span>}
export function QuotaOverview({children}:{children:unknown}){return <section class="text-text">{children}</section>}
export function QuotaBreakdown({children}:{children:unknown}){return <div class="text-small">{children}</div>}
export default ()=><Frame name="history" width={288}><QuotaPopover><QuotaDetail><strong class="text-[14px] leading-[19px] font-semibold">Reset credits</strong><QuotaPeriod><span><QuotaCredit>2</QuotaCredit>Tomorrow</span><span>12 hours</span></QuotaPeriod></QuotaDetail></QuotaPopover></Frame>;

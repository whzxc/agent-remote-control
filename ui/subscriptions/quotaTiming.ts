import type { ProviderSnapshot, QuotaWindow } from './types';
export function quotaPeriod(w:QuotaWindow,p:ProviderSnapshot):number|undefined {
  const numeric=/^(\d+) (min|s)$/.exec(w.label);
  if(numeric)return Number(numeric[1])*(numeric[2]==='min'?60000:1000);
  if(['rolling','five_hour','session'].includes(w.label))return 5*3600000;
  if(['weekly','seven_day','weekly_all','weekly_scoped'].includes(w.label))return 7*86400000;
  if(p.agentId==='cursor') {
    const raw=p.rawUsage as {summary?:Record<string,unknown>;usage?:Record<string,unknown>}|undefined;
    const summary=raw?.usage ?? raw?.summary;
    const start=summary?.billingCycleStart ?? summary?.billingCycleStartDate;
    const end=summary?.billingCycleEnd ?? summary?.billingCycleEndDate;
    const date = (value: unknown) => {
      if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) value = Number(value);
      if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
      return typeof value === 'string' ? Date.parse(value) : NaN;
    };
    const length=date(end)-date(start);
    if(Number.isFinite(length)&&length>0)return length;
    return 30*86400000;
  }
  if(w.label==='monthly')return 30*86400000;
}
// Compare consumption with elapsed quota time, using the same projection everywhere.
export function quotaTiming(w: QuotaWindow, p: ProviderSnapshot, now: number) {
  const length = quotaPeriod(w, p), reset = Date.parse(w.resetsAt ?? '');
  if (!length || !Number.isFinite(reset) || now >= reset || !Number.isFinite(w.usedPercent) || w.usedPercent <= 0) return;
  const elapsed = now - (reset - length);
  if (elapsed < Math.max(60000, length * .01)) return;
  const projected = w.usedPercent / elapsed * length;
  return { length, reset, elapsed, projected, warning: w.usedPercent > 75 && projected > 100 };
}

import type { ProviderSnapshot } from './types';
import { isWeekly } from './labels';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

// Native keeps normalized quota windows for scheduling. Display-only
// fields come from the original usage response, shared by every frontend surface.
export function presentSubscription(provider: ProviderSnapshot): ProviderSnapshot {
  const raw = object(provider.rawUsage);
  let plan: string | undefined;
  let windows = provider.windows;
  let availableResetCount: number | undefined;
  let creditBalance: number | undefined;
  let resetCredits: ProviderSnapshot['resetCredits'];
  let productUsage: ProviderSnapshot['productUsage'];
  if (provider.agentId === 'codex') {
    windows = windows.filter(w => w.poolId !== 'base_model_inference' && w.scope !== 'gpt-reserve');
    const groups = Object.values(object(raw.rateLimitsByLimitId));
    const credit = object(object(object(raw.rateLimitsByLimitId).codex).credits).balance
      ?? object(object(raw.rateLimits).credits).balance;
    if ((typeof credit === 'string' && credit.trim() !== '') || typeof credit === 'number') {
      const balance = Number(credit);
      if (Number.isFinite(balance) && balance >= 0) creditBalance = balance;
    }
    plan = groups.map(group => text(object(group).planType)).find(Boolean)
      ?? text(object(raw.rateLimits).planType);
    const count = object(raw.rateLimitResetCredits).availableCount;
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) availableResetCount = count;
    const credits = object(raw.rateLimitResetCredits).credits;
    if (Array.isArray(credits)) resetCredits = credits.map(object).filter(c=>c.status==='available').map(c=>{
      const timestamp = typeof c.expiresAt==='number' ? c.expiresAt*1000 : typeof c.expiresAt==='string' ? Date.parse(c.expiresAt) : NaN;
      return {expiresAt:Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined};
    }).sort((a,b)=>(a.expiresAt ?? 'z').localeCompare(b.expiresAt ?? 'z'));
  } else if (provider.agentId === 'cursor') {
    plan = text(object(object(raw.plan).planInfo).planName) ?? text(object(raw.summary).membershipType) ?? text(raw.membershipType);
    if (plan) plan = plan.charAt(0).toUpperCase()+plan.slice(1);
  } else if (provider.providerId === 'antigravity') {
    const status=object(object(raw.status).userStatus);
    const remote=object(raw.plan);
    plan=text(object(status.userTier).name) ?? text(object(object(status.planStatus).planInfo).planName)
      ?? text(object(remote.paidTier).name) ?? text(object(remote.currentTier).name);
  } else if (provider.agentId === 'grok') {
    // The official CLI enriches billing with its explicit remote-settings tier.
    plan = text(raw.subscriptionTier) ?? text(raw.subscription_tier);
  } else if (provider.agentId === 'kimi') {
    plan = text(object(object(raw.user).membership).level);
  }
  if (provider.agentId === 'claude') {
    const resets = object(raw.cedar_ember);
    if (Array.isArray(resets.grants) && resets.eligible === true) {
      resetCredits = resets.grants.map(object).filter(g => g.usable_now === true && typeof g.resets_left === 'number' && Number.isSafeInteger(g.resets_left) && g.resets_left > 0)
        .map(g => ({expiresAt: text(g.ends_at), count: g.resets_left as number}));
      availableResetCount = resetCredits.reduce((sum, g) => sum + (g.count ?? 0), 0);
    }
    const rows = object(raw.seven_day_breakdown).rows;
    if (Array.isArray(rows)) productUsage = {basis: 'consumed', shared: false, rows: rows.map(object)
      .filter(r => typeof r.percent === 'number' && Number.isFinite(r.percent) && r.percent >= 0 && r.percent <= 100 && typeof r.display_name === 'string')
      .map(r => ({label: r.display_name as string, percent: r.percent as number}))};
  }
  const shared = object(provider.agentId === 'cursor' ? object(raw.sharedUsage).config : provider.agentId === 'grok' ? raw.config : undefined);
  if (shared.isUnifiedBillingUser === true && Array.isArray(shared.productUsage)) {
    const names: Record<string,string> = {PRODUCT_GROK_BOT:'Grok Bot', PRODUCT_GROK_CHAT:'Grok Chat', PRODUCT_CURSOR:'Cursor', PRODUCT_GROK_VOICE:'Grok Voice', PRODUCT_GROK_IMAGINE:'Grok Imagine'};
    productUsage = {basis:'allowance', shared:true, rows:shared.productUsage.map(object)
      .filter(r => typeof r.usagePercent === 'number' && Number.isFinite(r.usagePercent) && r.usagePercent >= 0 && typeof r.product === 'string')
      .map(r => ({label:names[r.product as string] ?? r.product as string, percent:r.usagePercent as number}))};
  }
  if (plan?.trim().toLowerCase() === 'free') plan = 'Free';
  const weekly = windows.filter(w => isWeekly(w.label));
  const displayWindowId = weekly.find(w => w.id === provider.displayWindowId)?.id ?? weekly[0]?.id;
  return {...provider, windows, displayWindowId, plan, availableResetCount, creditBalance, resetCredits, productUsage};
}

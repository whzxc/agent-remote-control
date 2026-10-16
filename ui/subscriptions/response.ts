import type { ProviderSnapshot, UsageHistory } from './types';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

// Native keeps normalized quota windows for scheduling and rail alerts. Display-only
// fields come from the original usage response, shared by every frontend surface.
export function presentSubscription(provider: ProviderSnapshot): ProviderSnapshot {
  const raw = object(provider.rawUsage);
  let plan: string | undefined;
  let windows = provider.windows;
  let availableResetCount: number | undefined;
  let creditBalance: number | undefined;
  let resetCredits: ProviderSnapshot['resetCredits'];
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
  if (plan?.trim().toLowerCase() === 'free') plan = 'Free';
  const history = raw.history && typeof raw.history === 'object' ? raw.history as UsageHistory : undefined;
  const displayWindowId = windows.some(w => w.id === provider.displayWindowId) ? provider.displayWindowId : windows[0]?.id;
  return {...provider, windows, displayWindowId, plan, availableResetCount, creditBalance, resetCredits, history};
}

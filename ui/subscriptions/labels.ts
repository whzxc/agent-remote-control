import { quotaDisplay } from './displayPreferences';
import { t } from '../i18n';
import type { ProviderSnapshot } from './types';
import { duration as readableDuration } from './presentation';
import { quotaPeriod } from './quotaTiming';
export const isWeekly = (value: string) => ['weekly', 'weekly_all', 'weekly_scoped', '10080 min', '604800 s'].includes(value) || value === 'seven_day' || value.startsWith('seven_day_');
export const isFiveHour = (value:string) => ['rolling','five_hour','session','300 min','18000 s'].includes(value);
export const isMonthly = (value: string) => {
  if (value === 'monthly') return true;
  const duration = /^(\d+) (min|s)$/.exec(value);
  const minutes = duration ? Number(duration[1]) / (duration[2] === 's' ? 60 : 1) : 0;
  return minutes >= 40320 && minutes <= 44640;
};
export function agentQuotaWindows(provider: ProviderSnapshot) {
  const windows = provider.windows.filter(window => Number.isFinite(window.usedPercent));
  const weekly = windows.find(window => window.id === provider.displayWindowId && isWeekly(window.label))
    ?? windows.find(window => isWeekly(window.label));
  const shortWindows = windows.filter(window => {
    const period = quotaPeriod(window, provider);
    return isFiveHour(window.label) || (period !== undefined && period < 7 * 86400000);
  });
  const short = shortWindows.find(window => window.poolId === weekly?.poolId) ?? shortWindows[0];
  const monthly = windows.find(window => isMonthly(window.label) && window.poolId === (weekly ?? short)?.poolId)
    ?? windows.find(window => isMonthly(window.label));
  return { short, weekly, monthly };
}
export function windowLabel(value: string) {
  const suffix = quotaDisplay.get() === 'used' ? 'Limit' : '';
  const period = (key:string) => t(key + suffix);
  const names: Record<string, string> = { rolling: period('usageFiveHour'), weekly: period('usageWeekly'), monthly: period('usageMonthly'), five_hour: period('usageFiveHour'), seven_day: period('usageWeekly'), session: period('usageFiveHour'), weekly_all: period('usageWeekly'), weekly_scoped: period('usageWeekly'), 'current-period': t('usageCurrentPeriod'), cursorModels: t('usageCursorModels'), otherModels: t('usageOtherModels'), plan: t('usagePlan') };
  const duration = /^(\d+) (min|s)$/.exec(value);
  if (!duration) return names[value] || value;
  const minutes = Number(duration[1]) / (duration[2] === 's' ? 60 : 1);
  return minutes === 300 ? period('usageFiveHour') : minutes === 10080 ? period('usageWeekly') : isMonthly(value) ? period('usageMonthly') : readableDuration(minutes);
}

export function subscriptionLabel(provider: ProviderSnapshot) {
  if (provider.agentId !== 'codex') return provider.name;
  const plan = provider.plan?.trim();
  const names: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro 20x', prolite: 'Pro 5x', self_serve_business_prolite: 'Business Premium', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', team: 'Team' };
  return plan && plan !== 'unknown' ? `ChatGPT ${names[plan.toLowerCase()] ?? plan}` : 'ChatGPT';
}

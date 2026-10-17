import { quotaDisplay } from './displayPreferences';
import { t } from '../i18n';
import type { ProviderSnapshot } from './types';
import { duration as readableDuration } from './presentation';
export const isFiveHour = (value:string) => ['rolling','five_hour','session','300 min','18000 s'].includes(value);
export function windowLabel(value: string) {
  const suffix = quotaDisplay.get() === 'used' ? 'Limit' : '';
  const period = (key:string) => t(key + suffix);
  const names: Record<string, string> = { rolling: period('usageFiveHour'), weekly: period('usageWeekly'), monthly: period('usageMonthly'), five_hour: period('usageFiveHour'), seven_day: period('usageWeekly'), session: period('usageFiveHour'), weekly_all: period('usageWeekly'), weekly_scoped: period('usageWeekly'), 'current-period': t('usageCurrentPeriod'), cursorModels: t('usageCursorModels'), otherModels: t('usageOtherModels'), plan: t('usagePlan') };
  const duration = /^(\d+) (min|s)$/.exec(value);
  if (!duration) return names[value] || value;
  const minutes = Number(duration[1]) / (duration[2] === 's' ? 60 : 1);
  return minutes === 300 ? period('usageFiveHour') : minutes === 10080 ? period('usageWeekly') : minutes >= 40320 && minutes <= 44640 ? period('usageMonthly') : readableDuration(minutes);
}

export function subscriptionLabel(provider: ProviderSnapshot) {
  if (provider.agentId !== 'codex') return provider.name;
  const plan = provider.plan?.trim();
  const names: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro 20x', prolite: 'Pro 5x', self_serve_business_prolite: 'Business Premium', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', team: 'Team' };
  return plan && plan !== 'unknown' ? `ChatGPT ${names[plan.toLowerCase()] ?? plan}` : 'ChatGPT';
}

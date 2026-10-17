import { preference } from '../state/store';
import { t } from '../i18n';
import { remaining, type QuotaWindow } from './types';

export const quotaDisplay = preference<'remaining' | 'used'>('quota-display', 'remaining', value => value === 'used' ? 'used' : 'remaining', value => value);
export const resetDisplay = preference<'countdown' | 'time'>('quota-reset-display', 'countdown', value => value === 'time' ? 'time' : 'countdown', value => value);
export const quotaLabel = () => t(quotaDisplay.get() === 'used' ? 'usageUsed' : 'usageRemaining');
export function quotaValue(window?: QuotaWindow) {
  const value = remaining(window);
  return value === undefined ? undefined : quotaDisplay.get() === 'used' ? 100 - value : value;
}
export function quotaPercent(window?: QuotaWindow) {
  const value = quotaValue(window);
  return value === undefined ? '—' : value > 0 && value < 1 ? '<1%' : `${Math.floor(value)}%`;
}

export const maxVisibleAgents = preference<number>('agents-max-visible', 4);

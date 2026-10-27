import { preference } from '../state/store';
import { t } from '../i18n';
import { remaining, type QuotaWindow } from './types';
import type { BubbleDensity, BubbleWidth } from '../state/activityModel';

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

export const bubbleDensity = preference<BubbleDensity>('task-bubble-density', 'standard', value => value === 'compact' || value === 'detailed' ? value : 'standard', value => value);
export const bubbleWidth = preference<BubbleWidth>('task-bubble-width', 'medium', value => value === 'narrow' || value === 'wide' ? value : 'medium', value => value);
export const bubbleAutoCompact = preference('task-bubble-auto-compact', true, value => value !== 'off', value => value ? 'on' : 'off');

export type LayoutPreference = 'auto' | 'landscape' | 'portrait';
export const topologyLayout = preference<LayoutPreference>('topology-layout', 'auto', value => value === 'portrait' || value === 'landscape' ? value : 'auto', value => value);

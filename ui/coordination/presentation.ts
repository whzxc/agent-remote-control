import { Activity, BellOff, CircleArrowDown, CirclePause, CircleX, Lightbulb, Megaphone, MessageCircleQuestion, OctagonAlert, Unplug, type LucideIcon } from 'lucide-react';
import type { Locale } from '../i18nMessage';
import type { Attention, BoardRecord, JournalEvent } from './model';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

/** Leading glyph and tone for one current-attention row. */
export function attentionLook(item: Attention): { icon: LucideIcon; tone: Tone } {
  if (item.kind === 'task') return item.state === 'needsYou' ? { icon: MessageCircleQuestion, tone: 'warning' } : item.state === 'failed' ? { icon: CircleX, tone: 'danger' } : { icon: CirclePause, tone: 'warning' };
  if (item.kind === 'connection') return item.notification ? { icon: BellOff, tone: 'warning' } : { icon: Unplug, tone: 'danger' };
  if (item.kind === 'update') return { icon: CircleArrowDown, tone: 'warning' };
  if (item.kind === 'ax') return { icon: Lightbulb, tone: 'neutral' };
  return { icon: OctagonAlert, tone: 'warning' };
}
export const workLook = { icon: Activity, tone: 'accent' as Tone };
export function recordLook(row: BoardRecord): { icon: LucideIcon; tone: Tone } {
  const live = !['closed', 'withdrawn', 'cleared'].includes(row.state);
  if (row.intent != null) return { icon: Megaphone, tone: live ? 'accent' : 'neutral' };
  return { icon: OctagonAlert, tone: !live ? 'neutral' : row.state === 'active' ? 'danger' : 'warning' };
}

const warningStates = ['stale', 'uncertain', 'unconfirmed', 'interrupted', 'cancelled', 'withdrawn'];
export function stateTone(state?: string): Tone {
  if (!state) return 'neutral';
  if (state === 'failed') return 'danger';
  if (state === 'completed' || state === 'cleared') return 'success';
  if (warningStates.includes(state)) return 'warning';
  return 'neutral';
}
export function eventTone(event: JournalEvent): Tone {
  if (event.kind === 'notification.delivery-failed') return 'danger';
  if (event.kind.startsWith('receipt.')) return 'warning';
  return stateTone(event.status);
}

/** Estimated durations are owner estimates; render them in the largest readable unit. */
export function duration(seconds: number, locale: Locale) {
  const unit = (value: number, name: 'second' | 'minute' | 'hour') => new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: 1 }).format(value);
  if (seconds < 60) return unit(seconds, 'second');
  if (seconds < 3600) return unit(Math.round(seconds / 60), 'minute');
  return unit(Math.round(seconds / 360) / 10, 'hour');
}
export function clock(value: string, locale: Locale) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';
}

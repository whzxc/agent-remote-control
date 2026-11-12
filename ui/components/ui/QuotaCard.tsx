import { Tooltip as HoverHelp } from "./index";
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { t } from '../../i18n';
import { quotaLabel, quotaPercent, quotaValue, resetDisplay } from '../../subscriptions/displayPreferences';
import { windowLabel } from '../../subscriptions/labels';
import { quotaPace } from '../../subscriptions/pace';
import { duration, preciseTime, readingStatus, usageColors } from '../../subscriptions/presentation';
import type { ProviderSnapshot, QuotaWindow } from '../../subscriptions/types';
import { Card } from './card';
import './QuotaCard.css';

export function QuotaCard({ window, provider, now, detail, extra }: {
  window: QuotaWindow; provider: ProviderSnapshot; now: number;
  detail?: (pace: NonNullable<ReturnType<typeof quotaPace>>) => ReactNode; extra?: ReactNode;
}) {
  const label = windowLabel(window.label);
  const scope = provider.providerId === 'antigravity' ? window.scope : undefined;
  const value = quotaValue(window);
  const pace = quotaPace(window, provider, now);
  const status = readingStatus(window, provider, now);
  const resetAt = window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : undefined;
  const reset = resetAt ? resetDisplay.get() === 'time' ? preciseTime(resetAt)
    : t('quotaResetIn', { time: duration(Math.max(0, Math.ceil((Date.parse(resetAt) - now) / 60000))) }) : t('quotaResetUnknown');
  const color = status.rank === 4 ? usageColors.exhausted
    : pace?.color ?? (status.rank === 2 ? usageColors.good : status.color);
  return <Card padded className="quota-window-card">
    <HoverHelp text={window.scope}><h3>{scope ? `${scope} · ${label}` : label}</h3></HoverHelp>
    <div className="quota-window-value"><strong>{quotaPercent(window)}</strong><span>{quotaLabel()}</span></div>
    <div className="quota-window-track" role={value === undefined ? undefined : 'meter'}
      aria-label={`${label} · ${quotaLabel()}`} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${value ?? 0}%`, background: color }} />
      {pace?.tick != null && <HoverHelp text={t('quotaTimeTick')}><span style={{ left: `clamp(1px, ${pace.tick}%, calc(100% - 1px))` }} /></HoverHelp>}
    </div>
    <div className="quota-window-meta">
      <HoverHelp text={resetAt ? preciseTime(resetAt) : undefined}><time dateTime={resetAt}>{reset}</time></HoverHelp>
      {status.rank === 4 ? <span className="quota-window-exhausted">{t('quota.exhausted')}</span>
        : pace?.label && <HoverHelp text={pace.tooltip}><span className={pace.flame ? undefined : 'quota-window-warning'}>
          {detail ? detail(pace) : pace.label}
        </span></HoverHelp>}
    </div>
    {extra}
  </Card>;
}

export function QuotaDetailAction({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return <button type="button" {...props} className="quota-detail-action">{children}</button>;
}

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
    <h3 title={window.scope}>{scope ? `${scope} · ${label}` : label}</h3>
    <div className="quota-window-value"><strong>{quotaPercent(window)}</strong><span>{quotaLabel()}</span></div>
    <div className="quota-window-track" role={value === undefined ? undefined : 'meter'}
      aria-label={`${label} · ${quotaLabel()}`} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${value ?? 0}%`, background: color }} />
      {pace?.tick != null && <span title={t('quotaTimeTick')} style={{ left: `clamp(1px, ${pace.tick}%, calc(100% - 1px))` }} />}
    </div>
    <div className="quota-window-meta">
      <time dateTime={resetAt} title={resetAt ? preciseTime(resetAt) : undefined}>{reset}</time>
      {status.rank === 4 ? <span className="quota-window-exhausted">{t('quota.exhausted')}</span>
        : pace?.label && <span className={pace.flame ? undefined : 'quota-window-warning'} title={pace.tooltip}>
          {detail ? detail(pace) : pace.label}
        </span>}
    </div>
    {extra}
  </Card>;
}

export function QuotaDetailAction({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return <button type="button" {...props} className="quota-detail-action">{children}</button>;
}

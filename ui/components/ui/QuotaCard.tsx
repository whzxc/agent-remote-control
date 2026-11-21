import { History } from 'lucide-react';
import { Icon, Tooltip as HoverHelp } from "./index";
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { t } from '../../i18n';
import { quotaDisplay, quotaLabel, quotaPercent, quotaValue, resetDisplay } from '../../subscriptions/displayPreferences';
import { windowLabel } from '../../subscriptions/labels';
import { quotaPace } from '../../subscriptions/pace';
import { duration, preciseTime, readingStatus } from '../../subscriptions/presentation';
import type { ProviderSnapshot, QuotaWindow } from '../../subscriptions/types';
import { Card } from './card';
import './QuotaCard.css';

const segmentCount = 36;

function segmentWidth(percentage: number, index: number) {
  return Math.max(0, Math.min(1, percentage * segmentCount / 100 - index)) * 100;
}

export function QuotaCards({ heading, label, children }: { heading?: ReactNode; label?: string; children: ReactNode }) {
  return <Card variant="reply" className="quota-windows" aria-label={label} role={label ? 'group' : undefined}>
    {heading}
    {children}
  </Card>;
}

export function QuotaCard({ window, provider, now, detail, extra }: {
  window: QuotaWindow; provider: ProviderSnapshot; now: number;
  detail?: (pace: NonNullable<ReturnType<typeof quotaPace>>, label: string) => ReactNode; extra?: ReactNode;
}) {
  const label = windowLabel(window.label);
  const scope = provider.providerId === 'antigravity' ? window.scope : undefined;
  const value = Number.isFinite(window.usedPercent) ? quotaValue(window) : undefined;
  const display = value === undefined ? '—' : quotaPercent(window);
  const pace = quotaPace(window, provider, now);
  const status = readingStatus(window, provider, now);
  const resetAt = window.resetsAt && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : undefined;
  const reset = resetAt ? resetDisplay.get() === 'time' ? preciseTime(resetAt)
    : t('quotaResetIn', { time: duration(Math.max(0, Math.ceil((Date.parse(resetAt) - now) / 60000))) }) : t('quotaResetUnknown');
  const used = quotaDisplay.get() === 'used';
  const projected = pace?.projected === undefined ? undefined : Math.min(100, Math.max(0, pace.projected));
  const forecast = projected === undefined ? undefined : used ? projected : 100 - projected;
  const caption = pace?.label || (forecast === undefined ? '' :
    t(used ? 'quotaProjectedUsed' : 'quotaProjectedRemaining', { percent: Math.round(forecast) }));
  const solid = value === undefined ? 0 : Math.min(value, forecast ?? value);
  const extent = value === undefined ? 0 : Math.max(value, forecast ?? value);
  const tone = status.rank === 4 ? 'danger' : status.rank === 3 ? 'warning' : status.rank === 0 ? 'unknown' : 'normal';
  const windowTitle = scope ? `${scope} · ${label}` : label;
  return <section className="quota-window-card" data-tone={tone}>
    <div className="quota-window-line">
      <HoverHelp text={window.scope}><h3>{windowTitle}</h3></HoverHelp>
      <div className="quota-window-track" role={value === undefined ? undefined : 'meter'}
        aria-hidden={value === undefined ? true : undefined}
        aria-label={`${windowTitle} · ${quotaLabel()}`} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}
        aria-valuetext={caption ? `${display} · ${caption}` : display}>
        {Array.from({ length: segmentCount }, (_, index) => {
          const fill = segmentWidth(solid, index);
          const end = segmentWidth(extent, index);
          return <span className="quota-window-segment" key={index}>
            {end > fill && <span className="quota-window-ghost" style={{ width: `${end}%` }} />}
            {fill > 0 && <span style={{ width: `${fill}%` }} />}
          </span>;
        })}
      </div>
    </div>
    <div className="quota-window-meta">
      <div className="quota-window-reset">
        <HoverHelp text={resetAt ? preciseTime(resetAt) : undefined}>
          <time dateTime={resetAt}><span className="quota-reset-icon"><Icon icon={History} size={13} /></span>{reset}</time>
        </HoverHelp>
        {status.rank === 4 ? <span className="quota-window-exhausted">· {t('quota.exhausted')}</span>
          : pace && caption && <span className={pace.label ? 'quota-window-warning' : undefined}>
            · {detail ? detail(pace, caption) : <HoverHelp text={pace.tooltip}><span>{caption}</span></HoverHelp>}
          </span>}
      </div>
      <span className="quota-window-value">{quotaLabel()} <strong>{display}</strong></span>
    </div>
    {extra}
  </section>;
}

export function QuotaDetailAction({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return <button type="button" {...props} className="quota-detail-action">{children}</button>;
}

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { t } from '../../i18n';
import { useNow } from '../../state/hooks';
import { iconWindows } from '../../subscriptions/AgentQuotaIcon';
import { readingStatus } from '../../subscriptions/presentation';
import type { ProviderSnapshot } from '../../subscriptions/types';
import './TopologyGroup.css';

export function groupQuotaState(provider: ProviderSnapshot | undefined, now: number): 'ok' | 'low' | 'out' | 'unknown' {
  const primary = provider && iconWindows(provider, now, true)[0];
  if (!provider || provider.state !== 'ready' || provider.error || !primary) return 'unknown';
  const { rank } = readingStatus(primary, provider, now);
  return rank === 4 ? 'out' : rank >= 2 ? 'low' : rank === 1 ? 'ok' : 'unknown';
}

export interface TopologyGroupMember { brand: string; mark: ReactNode; quota?: ProviderSnapshot }
export function TopologyGroup({ label, members, layout = 'vertical', hideLabel = false, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string; members: readonly TopologyGroupMember[]; layout?: 'vertical' | 'source' | 'agent'; hideLabel?: boolean; ref?: Ref<HTMLButtonElement>;
}) {
  const now = useNow();
  const brands = [...new Map(members.map(m => [m.brand, m])).values()], pool = brands.length === 1;
  return <div className="topology-group" data-layout={layout} data-hide-label={hideLabel || undefined}>
    <button type="button" {...props} className="topology-group-capsule" aria-label={`${label} · ${t('topology.expand')}`}>
      <span className={pool ? 'topology-group-mark' : 'topology-group-brands'} aria-hidden="true">
        {brands.slice(0, pool ? 1 : 3).map(member => <span key={member.brand}>{member.mark}</span>)}
      </span>
      {pool && <span className="topology-group-dots" aria-hidden="true">{members.slice(0, 12).map((member, index) => <span key={index} className={`quota-${groupQuotaState(member.quota, now)}`} />)}</span>}
      <span className="topology-group-count" aria-hidden="true">{members.length}</span>
    </button>
    {!hideLabel && <span className="topology-group-label" aria-hidden="true">{label}</span>}
  </div>;
}

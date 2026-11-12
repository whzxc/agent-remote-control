import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { t } from '../../i18n';
import './TopologyGroup.css';

export interface TopologyGroupMember { brand: string; mark: ReactNode }
export function TopologyGroup({ label, members, layout = 'vertical', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string; members: readonly TopologyGroupMember[]; layout?: 'vertical' | 'source' | 'agent'; ref?: Ref<HTMLButtonElement>;
}) {
  const brands = [...new Map(members.map(m => [m.brand, m])).values()], pool = brands.length === 1;
  return <div className="topology-group" data-layout={layout}>
    <button type="button" {...props} className="topology-group-capsule" aria-label={`${label} · ${t('topology.expand')}`}>
      <span className={pool ? 'topology-group-mark' : 'topology-group-brands'} aria-hidden="true">
        {brands.slice(0, pool ? 1 : 3).map(member => <span key={member.brand}>{member.mark}</span>)}
      </span>

      <span className="topology-group-count" aria-hidden="true">{members.length}</span>
    </button>
    {layout === 'vertical' && <span className="topology-group-label" aria-hidden="true">{label}</span>}
  </div>;
}

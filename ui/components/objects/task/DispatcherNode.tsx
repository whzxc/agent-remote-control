import { Terminal } from 'lucide-react';
import { Button, PlatformIcon } from '../../ui';
import { controlSource } from '../../../controlSources';
import { t } from '../../../i18n';
import { name } from '../../../state/agents';
import type { DispatchSummary } from '../../../types';

/** A dispatcher without live activity keeps the task bubble's compact identity. */
export function DispatcherNode({ agent, platform, title, account, source, onOpen }: {
  agent?: string; platform?: string; title?: string; account?: string;
  source?: DispatchSummary['controlSource']; onOpen?: () => void;
}) {
  const product = platform ?? source?.kind ?? '';
  const platformName = agent ? name({ agent }) : controlSource(product)?.displayName ?? source?.kind ?? t('setup.otherClient');
  const heading = title || platformName, accountName = account || source?.label;
  const label = [...new Set([platformName, heading, accountName].filter(Boolean))].join(' · ');
  const content = <>
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
      <PlatformIcon role={agent ? 'agent' : 'source'} platform={agent ?? product} size={24} fallback={Terminal} />
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <strong className="truncate text-sm font-semibold">{heading}</strong>
      {accountName && <span className="truncate text-xs text-muted-foreground">{accountName}</span>}
    </span>
  </>;
  return onOpen ? <Button variant="surface" className="activity-bubble" aria-label={label} title={label} data-panel-anchor onClick={onOpen}>{content}</Button>
    : <div className="activity-bubble cursor-default" role="group" tabIndex={0} aria-label={label} title={label}>{content}</div>;
}

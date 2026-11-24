import { Laptop, Monitor, Terminal } from 'lucide-react';
import { deviceSnapshot } from '../../devices/state';
import { icons } from '../../state/agents';
import { accounts } from '../../state/accounts';
import { connector } from '../../state/connector';
import { resolveTaskOriginChain } from '../../state/taskLineage';
import SourceIcon from '../SourceIcon';
import { BrandMark, Icon } from './index';

export function useTaskOrigins(task: Parameters<typeof resolveTaskOriginChain>[0]) {
  const snapshot = deviceSnapshot.use(), { sources, status } = connector.use();
  const { items } = accounts.use();
  return resolveTaskOriginChain(task, { snapshot, sources, ingresses: status?.ingresses, accounts: items }).map(origin => ({
    ...origin,
    graphic: origin.kind === 'agent' ? <BrandMark markup={icons[origin.agent]} size={14} />
      : origin.kind === 'source' && origin.platform !== 'local-cli' ? <SourceIcon platform={origin.platform} size={14} iconSize={13} />
        : <Icon icon={origin.kind === 'controller' ? Monitor : origin.kind === 'device' ? Laptop : Terminal} size={13} />,
  }));
}

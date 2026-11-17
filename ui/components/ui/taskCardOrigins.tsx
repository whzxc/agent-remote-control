import { Laptop, Monitor, Terminal } from 'lucide-react';
import { type ReactNode } from 'react';
import { t } from '../../i18n';
import { deviceSnapshot, pairedDevices } from '../../devices/state';
import { icons, name } from '../../state/agents';
import { accounts } from '../../state/accounts';
import { accountOwns } from '../../accountPresentation';
import { platformSources } from '../../sourcePresentation';
import { controlSourcePlatform } from '../../controlSources';
import { connector } from '../../state/connector';
import type { HomepageTask } from '../../state/activityModel';
import SourceIcon from '../SourceIcon';
import { dispatchSourceLabel } from '../activity';
import { BrandMark, Icon } from './index';

export type TaskOrigin = { label: string; caption?: string; graphic: ReactNode; description?: string };

export function useTaskOrigins(task: Pick<HomepageTask, 'agent' | 'session' | 'deviceId' | 'controllerDeviceId' | 'accountId'> & { sourceIds?: string[] }) {
  const snapshot = deviceSnapshot.use(), { sources, status } = connector.use();
  const { items } = accounts.use();
  const { agent, session, deviceId } = task;
  const origin = session.origin, recorded = session.dispatchSummary?.controlSource;
  const source = sources.find(candidate => task.sourceIds?.includes(candidate.id) || candidate.id === (origin?.sourceId ?? recorded?.id));
  const controllerId = task.controllerDeviceId ?? origin?.deviceId ?? recorded?.deviceId;
  const controller = snapshot?.controller && (controllerId === snapshot.controller.deviceId || source?.ingressId === `peer:${snapshot.controller.deviceId}`) ? snapshot.controller : undefined;
  const label = source?.label || origin?.sourceLabel || dispatchSourceLabel(recorded) || origin?.controlSource;
  const platform = source?.product ?? recorded?.kind ?? origin?.controlSource ?? 'custom';
  const result: TaskOrigin[] = [];
  const controllerLabel = deviceId ? snapshot?.name || label || t('homepage.controller') : controller?.name;
  if (controllerLabel) result.push({
    label: controllerLabel, caption: controllerLabel,
    graphic: <Icon icon={Monitor} size={14} />,
  });
  else if (label) {
    const sourceIds = new Set(platformSources(sources, status?.ingresses ?? [], controlSourcePlatform(platform).id).map(s => s.id));
    const linked = items.filter(a => a.sources.some(id => sourceIds.has(id)));
    const account = linked.find(a => accountOwns(a, recorded?.accountId ?? origin?.accountId))
      ?? linked.find(a => !!source && a.sources.includes(source.id));
    result.push({ label, caption: linked.length > 1 ? account?.alias : undefined, graphic: platform === 'local-cli' ? <Icon icon={Terminal} size={14} /> : <SourceIcon platform={platform} size={14} /> });
  }
  if (deviceId) {
    const device = pairedDevices(snapshot).find(device => device.id === deviceId);
    const description = device?.state === 'online' ? `${device.path === 'lan' ? 'LAN' : 'Tunnel'}${device.latency === null ? '' : ` · ${device.latency} ms`}` : undefined;
    const deviceName = snapshot?.members.find(member => member.deviceId === deviceId)?.name ?? deviceId;
    result.push({ label: deviceName, caption: deviceName, graphic: <Icon icon={Laptop} size={14} />, description });
  }
  const linked = deviceId ? [] : items.filter(a => a.agentProfiles.some(profile => profile.agent === agent));
  const account = linked.find(a => accountOwns(a, task.accountId ?? session.agentAccountId ?? session.dispatchSummary?.agentAccountId));
  const caption = linked.length > 1 ? account?.alias : undefined;
  result.push({ label: [name({ agent }), caption].filter(Boolean).join(' · '), caption, graphic: <BrandMark markup={icons[agent]} size={14} /> });
  return result;
}

import { Laptop, Monitor, Terminal, UserRound } from 'lucide-react';
import { type ReactNode } from 'react';
import { t } from '../../i18n';
import { deviceSnapshot, pairedDevices } from '../../devices/state';
import { accountOwns } from '../../accountPresentation';
import { accounts } from '../../state/accounts';
import { icons, name } from '../../state/agents';
import { connector } from '../../state/connector';
import type { HomepageTask } from '../../state/activityModel';
import SourceIcon from '../SourceIcon';
import { dispatchSourceLabel } from '../activity';
import { BrandMark, Icon } from './index';

export type TaskOrigin = { label: string; graphic: ReactNode; description?: string };

export function useTaskOrigins(task: Pick<HomepageTask, 'agent' | 'session' | 'deviceId' | 'controllerDeviceId' | 'accountId'> & { sourceIds?: string[] }) {
  const snapshot = deviceSnapshot.use(), { sources } = connector.use(), { items: accountList } = accounts.use();
  const { agent, session, deviceId } = task;
  const origin = session.origin, recorded = session.dispatchSummary?.controlSource;
  const source = sources.find(candidate => task.sourceIds?.includes(candidate.id) || candidate.id === (origin?.sourceId ?? recorded?.id));
  const controllerId = task.controllerDeviceId ?? origin?.deviceId ?? recorded?.deviceId;
  const controller = snapshot?.controller && (controllerId === snapshot.controller.deviceId || source?.ingressId === `peer:${snapshot.controller.deviceId}`) ? snapshot.controller : undefined;
  const label = source?.label || origin?.sourceLabel || dispatchSourceLabel(recorded) || origin?.controlSource;
  const platform = source?.product ?? recorded?.kind ?? origin?.controlSource ?? 'custom';
  const result: TaskOrigin[] = [];
  if (deviceId || controller) result.push({
    label: deviceId ? snapshot?.name || label || t('homepage.controller') : controller!.name,
    graphic: <Icon icon={Monitor} size={14} />,
  });
  else if (label) result.push({ label, graphic: platform === 'local-cli' ? <Icon icon={Terminal} size={14} /> : <SourceIcon platform={platform} size={14} /> });
  if (deviceId) {
    const device = pairedDevices(snapshot).find(device => device.id === deviceId);
    const description = device?.state === 'online' ? `${device.path === 'lan' ? 'LAN' : 'Tunnel'}${device.latency === null ? '' : ` · ${device.latency} ms`}` : undefined;
    result.push({ label: snapshot?.members.find(member => member.deviceId === deviceId)?.name ?? deviceId, graphic: <Icon icon={Laptop} size={14} />, description });
  }
  result.push({ label: name({ agent }), graphic: <BrandMark markup={icons[agent]} size={14} /> });
  const accountId = task.accountId ?? session.agentAccountId ?? session.dispatchSummary?.agentAccountId;
  if (accountId) {
    const account = !deviceId && accountList.find(account => accountOwns(account, accountId));
    result.push({ label: account ? account.alias : accountId, graphic: <Icon icon={UserRound} size={14} /> });
  }
  return result;
}

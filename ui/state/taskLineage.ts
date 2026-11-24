import { accountOwns } from '../accountPresentation';
import { controlSource, controlSourcePlatform } from '../controlSources';
import { pairedDevices, type DeviceSnapshot } from '../devices/state';
import { t } from '../i18n';
import { platformSources } from '../sourcePresentation';
import type { AgentActivitySession, DispatchSummary, ProviderAccount } from '../types';
import type { HomepageTask } from './activityModel';
import { name } from './agents';

export function dispatchSourceLabel(source?: DispatchSummary['controlSource']) {
  return source?.label || (source?.kind === 'local-cli' ? t('localCli')
    : controlSource(source?.kind ?? '')?.displayName || source?.kind || source?.id || '');
}

export function resolveEffectiveSource(summary?: DispatchSummary, origin?: AgentActivitySession['origin']) {
  const recorded = summary?.controlSource;
  const inferred = origin && (origin.controlSource || origin.sourceId || origin.sourceLabel) ? {
    id: origin.sourceId, accountId: origin.accountId, kind: origin.controlSource,
    label: origin.sourceLabel, deviceId: origin.deviceId,
  } : undefined;
  const controlSource = recorded?.kind || !inferred ? recorded : { ...inferred, ...recorded };
  return { controlSource, callerAgent: controlSource?.kind === 'local-cli' ? summary?.caller?.agent : undefined };
}

type OriginMark = {
  label: string; caption?: string; description?: string;
} & ({ kind: 'controller' | 'device' } | { kind: 'agent'; agent: string } | { kind: 'source'; platform: string });

export function resolveTaskOriginChain(
  task: Pick<HomepageTask, 'agent' | 'session' | 'deviceId' | 'controllerDeviceId'> & { sourceIds?: string[] },
  { snapshot, sources = [], ingresses = [], accounts = [] }: {
    snapshot?: DeviceSnapshot; sources?: Parameters<typeof platformSources>[0];
    ingresses?: Parameters<typeof platformSources>[1]; accounts?: readonly ProviderAccount[];
  } = {},
): OriginMark[] {
  const { agent, session, deviceId } = task;
  const origin = session.origin;
  const { controlSource: recorded, callerAgent } = resolveEffectiveSource(session.dispatchSummary, origin);
  const source = sources.find(candidate => task.sourceIds?.includes(candidate.id) || candidate.id === (origin?.sourceId ?? recorded?.id));
  const controllerId = task.controllerDeviceId ?? origin?.deviceId ?? recorded?.deviceId;
  const controller = snapshot?.controller && (controllerId === snapshot.controller.deviceId || source?.ingressId === `peer:${snapshot.controller.deviceId}`) ? snapshot.controller : undefined;
  const label = source?.label || origin?.sourceLabel || dispatchSourceLabel(recorded) || origin?.controlSource;
  const controllerLabel = deviceId ? snapshot?.name || label || t('homepage.controller') : controller?.name;
  const chain: OriginMark[] = [];
  if (controllerLabel) {
    chain.push({ kind: 'controller', label: controllerLabel, caption: controllerLabel });
  } else if (callerAgent) {
    const callerLabel = name({ agent: callerAgent });
    chain.push({ kind: 'agent', agent: callerAgent, label: callerLabel, description: t('localCli') });
  } else if (label) {
    const platform = recorded?.kind === 'local-cli' ? 'local-cli' : source?.product ?? recorded?.kind ?? origin?.controlSource ?? 'custom';
    const sourceIds = new Set(platformSources(sources, ingresses, controlSourcePlatform(platform).id).map(item => item.id));
    const linked = accounts.filter(account => account.sources.some(id => sourceIds.has(id)));
    const account = linked.find(item => accountOwns(item, recorded?.accountId ?? origin?.accountId))
      ?? linked.find(item => !!source && item.sources.includes(source.id));
    chain.push({ kind: 'source', platform, label, caption: linked.length > 1 ? account?.alias : undefined });
  }
  if (deviceId) {
    const device = pairedDevices(snapshot).find(item => item.id === deviceId);
    const description = device?.state === 'online' ? `${device.path === 'lan' ? 'LAN' : 'Tunnel'}${device.latency === null ? '' : ` · ${device.latency} ms`}` : undefined;
    const label = snapshot?.members.find(member => member.deviceId === deviceId)?.name ?? deviceId;
    chain.push({ kind: 'device', label, caption: label, description });
  }
  chain.push({ kind: 'agent', agent, label: name({ agent }) });
  return chain;
}

import { deviceSnapshot, pairedDevices } from '../devices/state';
import { deviceTasks } from '../devices/tasks';
import { homepageRemoteReads } from './homepage';
import { useEffect, useMemo } from 'react';
import { trackedActivity, activityBubbleSnapshot, rememberActivityRead, markActivitiesRead } from './activityBubbles';
import { tasks as taskRecords } from './tasks';
import { createStore } from './store';
import { activityApprovals } from './activity';
import { taskExecutions, refreshTaskExecution } from './taskExecution';
import { pendingSessions } from './taskInteractions';
import { executionStatus } from './taskExecutionModel';
import { homepageTaskGroup, projectDeviceTasks, remoteTaskReadKey, type HomepageTask } from './activityModel';
import { taskCardActivity } from './taskProjection';
import { taskOrder } from './taskOrder';

export const homepageReadRevision = createStore(0);
export function markHomepageTaskRead(task: HomepageTask) {
  if (task.group !== 'unread') return;
  if (task.deviceId) {
    homepageRemoteReads.set(old => [...old.filter(key => key !== remoteTaskReadKey(task)), remoteTaskReadKey(task)].slice(-1000));
    return;
  }
  rememberActivityRead(task.agent, task.session, Date.now());
  markActivitiesRead([{ agent: task.agent, id: task.session.id }]);
  homepageReadRevision.set(value => value + 1);
}
export function useHomepageTasks(observe = true) {
  const tracked = trackedActivity.use(), executions = taskExecutions.use(), submissions = activityApprovals.use(), order = taskOrder.use();
  const records = taskRecords.use().records, readRevision = homepageReadRevision.use();
  const devices = deviceSnapshot.use(), remote = deviceTasks.use(), remoteReads = homepageRemoteReads.use();
  const tasks = useMemo(() => {
    const combined = Object.fromEntries(Object.entries(tracked).map(([agent, sessions]) => [agent, [...sessions]]));
    const reads = activityBubbleSnapshot();
    for (const record of records.slice(0, 100)) {
      const agent = record.agent ?? 'codex', id = record.threadId ?? record.taskId ?? record.open?.taskId ?? record.task.threadId;
      if (!id || combined[agent]?.some(session => session.id === id)) continue;
      const execution = executions[JSON.stringify([agent, id])];
      const status = executionStatus(execution, record.turnId) ?? record.runtime?.status ?? record.runtime?.runtimeStatus ?? 'unknown';
      const timing = execution?.turnTimings?.[record.turnId ?? execution.turnId ?? ''];
      const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
      const session = { id, source: 'arc-task' as const, title: record.runtime?.title ?? record.task.title ?? record.task.prompt,
        headline: '', phase: 'idle' as const, phaseSince: null, timeline: true, observed: false, orderAt: Date.parse(record.createdAt),
        turnId: record.turnId, startedAt: record.createdAt, status, origin: record.origin ?? record.task.origin, open: record.open,
        ...(timing?.endedAt ? { endedAt: Date.parse(timing.endedAt) } : {}),
        ...(terminal ? { readAt: reads.find(row => row.agent === agent && row.id === id)?.readAt ?? undefined } : {}) };
      (combined[agent] ??= []).push(session);
    }
    const projected = Object.entries(combined).flatMap(([agent, sessions]) => {
    const ranks = new Map((order[agent] ?? []).map((id, index) => [id, index]));
    return [...sessions].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity) || a.orderAt - b.orderAt).map<HomepageTask>(session => {
      const execution = executions[JSON.stringify([agent, session.id])];
      const pending = pendingSessions(agent, session, execution?.interactions ?? [], submissions);
      const status = executionStatus(execution, session.turnId) ?? session.status ?? undefined;
      const timing = execution?.turnTimings?.[session.turnId ?? execution.turnId ?? ''];
      return { key: JSON.stringify([agent, session.id]), agent, session: { ...session, interaction: pending[0]?.interaction },
        group: homepageTaskGroup(session, pending.length > 0, status), sourceIds: session.origin?.sourceId || session.dispatchSummary?.controlSource?.id ? [session.origin?.sourceId ?? session.dispatchSummary!.controlSource!.id!] : [],
        controllerDeviceId: session.origin?.deviceId ?? session.dispatchSummary?.controlSource?.deviceId, upstreamSourceId: session.origin?.peerOrigin?.sourceId,
        accountId: session.agentAccountId ?? session.dispatchSummary?.agentAccountId,
        activity: taskCardActivity(execution?.entries ?? []), partial: !execution || execution.coverage?.state === 'partial' || execution.executionEvidence !== true,
        startedAt: timing?.startedAt ?? session.turnStartedAt, endedAt: timing?.endedAt };
    });
  });
    projected.push(...pairedDevices(devices).flatMap(device => projectDeviceTasks(device, remote[device.id] ?? {}, remoteReads)));
    const rank = new Map((order.homepage ?? []).map((key, index) => [key, index]));
    return projected.sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
  }, [tracked, executions, submissions, order, records, readRevision, devices, remote, remoteReads]);
  const identities = JSON.stringify(tasks.filter(task => !task.deviceId && task.session.timeline).map(task => [task.agent, task.session.id]));
  useEffect(() => {
    if (!observe) return;
    let stopped = false;
    const identitiesToRead = JSON.parse(identities) as [string, string][];
    const read = async () => {
      for (let index = 0; index < identitiesToRead.length && !stopped; index += 4) {
        await Promise.allSettled(identitiesToRead.slice(index, index + 4).map(([agent, id]) => refreshTaskExecution(agent, id, true)));
      }
    };
    void read();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, 10000);
    return () => { stopped = true; clearInterval(timer); };
  }, [identities, observe]);
  return tasks;
}

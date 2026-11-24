import { deviceSnapshot, pairedDevices } from '../devices/state';
import { deviceTasks } from '../devices/tasks';
import { homepageRemoteReads } from './homepage';
import { useEffect, useMemo, useState } from 'react';
import { trackedActivity, loadReads, rememberActivityRead, markActivitiesRead } from './activityBubbles';
import { tasks as taskRecords } from './tasks';
import { createStore } from './store';
import { activityApprovals } from './activity';
import { taskExecutions } from './taskExecution';
import { pendingSessions } from './taskInteractions';
import { executionStatus } from './taskExecutionModel';
import { activityReadMatches, homepageTaskGroup, localTaskDay, previewHomepageTask, projectDeviceTasks, remoteTaskReadKey, type HomepageTask, type TrackedActivity } from './activityModel';
import { useAppNow } from './appEnvironment';
import { taskCardActivity, taskStatusEvidence } from './taskProjection';
import { api } from '../api';
import type { AgentConversation, AgentConversationPage } from '../types';

const emptyHistory: AgentConversation[] = [];

function useRecentConversations(enabled: boolean) {
  const [rows, setRows] = useState(emptyHistory);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false, reading = false;
    const read = async () => {
      if (document.hidden || reading) return;
      reading = true;
      try {
        const result = await api<AgentConversationPage>("agents/conversations", "POST", { limit: 40, sort: 'updated', includeSubagents: true });
        if (!stopped) setRows(result.data);
      } catch { /* Keep the last native page through Core handoff. */ }
      finally { reading = false; }
    };
    void read();
    const timer = setInterval(read, 30000);
    document.addEventListener('visibilitychange', read);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [enabled]);
  return enabled ? rows : emptyHistory;
}

export function mergeHomepageConversations(
  combined: Record<string, Map<string, TrackedActivity>>,
  updates: Map<string, string | null | undefined>,
  history: readonly AgentConversation[],
) {
  for (const row of history) {
    const agent = row.agent ?? 'codex';
    const sessions = combined[agent] ??= new Map();
    const previous = sessions.get(row.id);
    const key = JSON.stringify([agent, row.id]);
    if (row.updatedAt) updates.set(key, row.updatedAt);
    const parentSessionId = previous?.parentSessionId ?? row.parentSessionId;
    const relationKind = previous?.relationKind ?? row.relationKind;
    const fallbackHeadline = previous?.fallbackHeadline || row.preview;
    const sameTurn = !row.turnId || row.turnId === previous?.turnId;
    if (previous?.observed) {
      const projectName = previous.projectName ?? (row.project && row.project === previous.project ? row.projectName : undefined);
      const turnCount = previous.turnCount ?? row.turnCount ?? undefined;
      const caller = sameTurn ? row.dispatchSummary?.caller : undefined;
      const dispatchSummary = caller && !previous.dispatchSummary?.caller
        ? { ...row.dispatchSummary, ...previous.dispatchSummary, caller } : previous.dispatchSummary;
      if (projectName !== previous.projectName || turnCount !== previous.turnCount || parentSessionId !== previous.parentSessionId
        || relationKind !== previous.relationKind || fallbackHeadline !== previous.fallbackHeadline || dispatchSummary !== previous.dispatchSummary) {
        sessions.set(row.id, { ...previous, projectName, turnCount, parentSessionId, relationKind, fallbackHeadline, dispatchSummary });
      }
      continue;
    }
    sessions.set(row.id, {
      ...previous, parentSessionId, relationKind, fallbackHeadline, id: row.id, source: row.source === 'native' ? 'transcript' : row.source, conversation: true,
      title: row.title || previous?.title, turnCount: row.turnCount ?? previous?.turnCount, status: row.status ?? (sameTurn ? previous?.status : undefined),
      project: row.project ?? previous?.project,
      projectName: row.projectName ?? (!row.project || row.project === previous?.project ? previous?.projectName : undefined),
      dispatchSummary: sameTurn ? { ...previous?.dispatchSummary, ...row.dispatchSummary } : row.dispatchSummary ?? undefined,
      nativeSessionId: row.nativeSessionId ?? previous?.nativeSessionId,
      turnId: row.turnId || previous?.turnId, open: row.open ?? previous?.open,
      turnStartedAt: row.turnStartedAt ?? (sameTurn ? previous?.turnStartedAt : undefined),
      turnEndedAt: row.turnEndedAt ?? (sameTurn ? previous?.turnEndedAt : undefined),
      turnDurationMs: row.turnDurationMs ?? (sameTurn ? previous?.turnDurationMs : undefined),
      endedAt: sameTurn ? previous?.endedAt : undefined,
      origin: sameTurn ? previous?.origin : undefined,
      startedAt: row.createdAt ?? previous?.startedAt, orderAt: Date.parse(row.createdAt ?? '') || previous?.orderAt || 0,
      observed: false, timeline: true, phase: 'idle', phaseSince: null, headline: previous?.headline ?? '',
    });
  }
}

const recentlyOpened = createStore<{ agent: string; session: TrackedActivity }[]>([]);
export function markHomepageTaskRead(task: HomepageTask) {
  if (task.group !== 'unread') return;
  if (task.deviceId) {
    homepageRemoteReads.set(old => [...old.filter(key => key !== remoteTaskReadKey(task)), remoteTaskReadKey(task)].slice(-1000));
    return;
  }
  const readAt = Date.now();
  rememberActivityRead(task.agent, task.session, readAt);
  // Keep the summary available as soon as the completed activity bubble is dismissed.
  recentlyOpened.set(old => [{ agent: task.agent, session: { ...task.session, observed: false, readAt } },
    ...old.filter(row => row.agent !== task.agent || row.session.id !== task.session.id)].slice(0, 30));
  markActivitiesRead([{ agent: task.agent, id: task.session.id }]);
}
export function useHomepageTasks(showHistory: boolean) {
  const tracked = trackedActivity.use(), executions = taskExecutions.use(), submissions = activityApprovals.use();
  const history = useRecentConversations(showHistory);
  const today = localTaskDay(useAppNow(showHistory ? 60000 : null));
  const records = taskRecords.use().records, opened = recentlyOpened.use();
  const devices = deviceSnapshot.use(), remote = deviceTasks.use(), remoteReads = homepageRemoteReads.use();
  const tasks = useMemo(() => {
    const combined = Object.fromEntries(Object.entries(tracked).map(([agent, sessions]) => [agent, new Map<string, TrackedActivity>(sessions.map(session => [session.id, session]))]));
    const updates = new Map<string, string | null | undefined>();
    for (const record of records) {
      const agent = record.agent ?? 'codex', id = record.threadId ?? record.taskId ?? record.open?.taskId ?? record.task.threadId;
      if (!id) continue;
      const key = JSON.stringify([agent, id]);
      if (updates.has(key)) continue;
      updates.set(key, record.updatedAt || record.createdAt);
      const project = record.runtime?.project ?? record.task.project ?? record.task.directory;
      const spec = { model: record.task.model ?? record.requested?.model, effort: record.task.effort ?? record.requested?.effort,
        serviceTier: record.requested?.serviceTier };
      const existing = combined[agent]?.get(id);
      if (existing) {
        combined[agent].set(id, { ...existing, origin: existing.origin ?? record.origin ?? record.task.origin,
          project: existing.project ?? project,
          dispatchSummary: existing.turnId && existing.turnId === record.turnId ? { ...spec, ...existing.dispatchSummary } : existing.dispatchSummary });
        continue;
      }
      if (updates.size > 100) continue;
      const execution = executions[key];
      const status = executionStatus(execution, record.turnId) ?? record.runtime?.status ?? record.runtime?.runtimeStatus ?? 'unknown';
      const timing = execution?.turnTimings?.[record.turnId ?? execution.turnId ?? ''];
      const session = { id, source: 'arc-task' as const, title: record.runtime?.title ?? record.task.title ?? record.task.prompt,
        headline: '', fallbackHeadline: record.task.prompt, phase: 'idle' as const, phaseSince: null, timeline: true, observed: false, orderAt: Date.parse(record.createdAt), project, dispatchSummary: spec,
        turnId: record.turnId, startedAt: record.createdAt, status, origin: record.origin ?? record.task.origin, open: record.open,
        ...(timing?.endedAt ? { endedAt: Date.parse(timing.endedAt) } : {}) };
      (combined[agent] ??= new Map()).set(id, session);
    }
    mergeHomepageConversations(combined, updates, history);
    for (const { agent, session } of opened) {
      const sessions = combined[agent] ??= new Map();
      if (!sessions.has(session.id)) sessions.set(session.id, session);
    }
    const observed = new Set(Object.entries(tracked).flatMap(([agent, sessions]) => sessions.map(session => JSON.stringify([agent, session.id]))));
    const readRows = loadReads();
    const reads = new Map(readRows.map(row => [JSON.stringify([row.agent, row.id]), row]));
    const projected = Object.entries(combined).flatMap(([agent, sessions]) => [...sessions.values()].map<HomepageTask>(session => {
      const key = JSON.stringify([agent, session.id]);
      const execution = executions[key];
      const pending = pendingSessions(agent, session, execution?.interactions ?? [], submissions);
      const status = taskStatusEvidence(executionStatus(execution, session.turnId), session.status);
      const timing = execution?.turnTimings?.[session.turnId ?? execution.turnId ?? ''];
      const read = reads.get(key);
      const current = { ...session, status, readAt: session.readAt ?? (read && activityReadMatches(read, session) ? read.readAt : undefined), interaction: pending[0]?.interaction };
      const summary = session.turnId ? execution?.turnDispatchSummaries?.[session.turnId] : execution?.dispatchSummary;
      if (summary) current.dispatchSummary = { ...session.dispatchSummary, ...summary };
      const task: HomepageTask = { key, agent, session: current, updatedAt: updates.get(key),
        group: homepageTaskGroup(current, pending.length > 0, status, observed.has(key)),
        sourceIds: session.origin?.sourceId || session.dispatchSummary?.controlSource?.id ? [session.origin?.sourceId ?? session.dispatchSummary!.controlSource!.id!] : [],
        controllerDeviceId: session.origin?.deviceId ?? session.dispatchSummary?.controlSource?.deviceId, upstreamSourceId: session.origin?.peerOrigin?.sourceId,
        activity: { steps: [], snapshot: [] },
        startedAt: timing?.startedAt ?? session.turnStartedAt, endedAt: timing?.endedAt ?? session.turnEndedAt };
      if ((previewHomepageTask(task, showHistory ? today : undefined) || current.relationKind === 'subagent') && execution) task.activity = taskCardActivity(execution.entries);
      return task;
    }));
    projected.push(...pairedDevices(devices).flatMap(device => projectDeviceTasks(device, remote[device.id] ?? {}, remoteReads)));
    return projected;
  }, [tracked, executions, submissions, history, records, opened, devices, remote, remoteReads, showHistory, today]);
  return tasks;
}

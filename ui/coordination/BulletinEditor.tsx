import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { Button, Checkbox, Dialog, Field, Input, Notice, SingleChoice } from '../components/ui';
import { trackedActivity } from '../state/activityBubbles';
import { boardObservation, ownerResult, refreshBoardAfterMutation } from './state';
import type { BoardPage, BoardRecord, Conflict } from './model';
export type EditAction = 'notice_post' | 'notice_update' | 'notice_close' | 'blocker_open' | 'blocker_clear';
export interface ResourceOption { key: string; label: string }
export default function BulletinEditor({ action, record, options, onClose, onSaved }: { action: EditAction; record?: BoardRecord; options: ResourceOption[]; onClose: () => void; onSaved: (record: BoardRecord) => void }) {
  const prefix = useId(), form = useRef<HTMLFormElement>(null);
  const [current, setCurrent] = useState(record), [loading, setLoading] = useState(!!record), [loadError, setLoadError] = useState('');
  const [summary, setSummary] = useState(record?.intent ?? record?.summary ?? ''), [resources, setResources] = useState(record?.resources ?? []);
  const [duration, setDuration] = useState(String(record?.expectedDurationSeconds ?? 1800)), [threads, setThreads] = useState(record?.threadLinks?.map(link => link.threadId) ?? []);
  const [cause, setCause] = useState(''), [evidence, setEvidence] = useState(''), [reason, setReason] = useState(''), [commit, setCommit] = useState(''), [project, setProject] = useState(''), [next, setNext] = useState('inspect');
  const [closeReason, setCloseReason] = useState('owner-closed'), [recovery, setRecovery] = useState('non-code');
  const [error, setError] = useState(''), [invalid, setInvalid] = useState(''), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const request = useRef<{ digest: string; id: string } | undefined>(undefined);
  const activity = trackedActivity.use(), board = boardObservation.use();
  const tasks = Object.values(activity).flat().filter(session => ['local-cli', 'local-ui'].includes(session.origin?.ingressId ?? ''));
  const notice = action.startsWith('notice_'), editing = action === 'notice_post' || action === 'notice_update' || action === 'blocker_open';
  const resourceOptions = [...new Map([...options, ...(current?.resources ?? []).map(key => ({ key, label: key }))].map(r => [r.key, r])).values()];
  useEffect(() => {
    if (!record) return;
    let cancelled = false; setLoading(true); setLoadError('');
    void api<BoardPage>('coordination/board', 'POST', { id: record.id, view: 'full' }).then(ownerResult).then(page => {
      const full = [...page.notices, ...page.blockers].find(row => row.id === record.id);
      if (!full) throw new Error('COORDINATION_NOT_FOUND');
      if (!cancelled) { setCurrent(full); if (!reload) { setSummary(full.intent ?? full.summary ?? ''); setResources(full.resources); setThreads(full.threadLinks?.map(link => link.threadId) ?? []); setDuration(String(full.expectedDurationSeconds ?? 1800)); } }
    }).catch(error => { if (!cancelled) setLoadError(String(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [record?.id, reload]);
  function fail(field: string) { setInvalid(field); setError(t('center.required')); requestAnimationFrame(() => form.current?.querySelector<HTMLElement>(`[id="${prefix}-${field}"]`)?.focus()); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || loading || loadError) return;
    setError(''); setInvalid('');
    if (editing && (!summary.trim() || /[\r\n]/.test(summary))) return fail('summary');
    if (editing && !resources.length) return fail('resources');
    if (notice && editing && (!Number.isInteger(Number(duration)) || Number(duration) < 1 || Number(duration) > 604800)) return fail('duration');
    if (action === 'blocker_open' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(cause)) return fail('cause');
    const ids = [...new Set(evidence.split(/[\s,]+/).filter(Boolean))];
    if ((action === 'blocker_clear' && !ids.length) || ids.length > 16 || ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))) return fail('evidence');
    if (action === 'blocker_clear' && recovery === 'non-code' && (!reason.trim() || /[\r\n]/.test(reason))) return fail('reason');
    if (action === 'blocker_clear' && recovery === 'code' && !project) return fail('project');
    if (action === 'blocker_clear' && recovery === 'code' && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(commit)) return fail('commit');
    const body: Record<string, unknown> = current ? { id: current.id } : {};
    if (action === 'notice_update' || action === 'blocker_clear') body.expectedRevision = current?.revision;
    if (editing) { body.resources = resources; body[notice ? 'intent' : 'summary'] = summary.trim(); }
    if (notice && editing) {
      body.expectedDurationSeconds = Number(duration);
      if (action === 'notice_post' || JSON.stringify(threads) !== JSON.stringify(current?.threadLinks?.map(link => link.threadId) ?? [])) body.threadIds = threads;
    }
    if (action === 'notice_close') body.reason = closeReason;
    if (action === 'blocker_open') { body.causeCode = cause; body.evidenceIds = ids; }
    if (action === 'blocker_clear') { body.evidenceIds = ids; body.suggestedNextStep = next; if (recovery === 'code') body.fixingCommit = { projectId: project, oid: commit }; else body.reason = reason.trim(); }
    const digest = JSON.stringify(body);
    if (request.current?.digest !== digest) request.current = { digest, id: crypto.randomUUID() };
    setBusy(true);
    try {
      const result = ownerResult(await api<{ notice?: BoardRecord; blocker?: BoardRecord }>(`coordination/${action}`, 'POST', { ...body, requestId: request.current.id }));
      await refreshBoardAfterMutation(); onSaved((result.notice ?? result.blocker)!); onClose();
    } catch (error) {
      setError(String(error));
      if (String(error).includes('REVISION_CONFLICT')) setInvalid('revision');
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>('[role="alert"]')?.focus());
    } finally { setBusy(false); }
  }
  const input = (field: string, value: string, change: (value: string) => void, props: Record<string, unknown> = {}) => <Field id={`${prefix}-${field}`} label={t(`center.${field}`)} error={invalid === field ? t('center.required') : undefined}><Input id={`${prefix}-${field}`} value={value} onChange={e => change(e.target.value)} aria-invalid={invalid === field || undefined} aria-describedby={invalid === field ? `${prefix}-${field}-error` : undefined} {...props} /></Field>;
  const conflicts: Conflict[] = (board.page?.conflicts ?? []).filter(conflict => conflict.noticeId !== current?.id && resources.includes(conflict.resource));
  return <Dialog centered busy={busy} title={t(`center.${action}`)} onClose={onClose} width={520}>
    <form ref={form} onSubmit={event => void submit(event)} className="center-editor" noValidate>
      {loading && <p role="status">{t('loading')}</p>}
      {loadError && <Notice tone="danger" action={<Button onClick={() => setReload(value => value + 1)}>{t('retry')}</Button>}>{loadError}</Notice>}
      {error && <div role="alert" tabIndex={-1}><Notice tone="danger">{error}</Notice></div>}
      {invalid === 'revision' && <Button onClick={() => { setReload(value => value + 1); setInvalid(''); }}>{t('center.refreshDraft')}</Button>}
      <fieldset disabled={loading || !!loadError || busy}>
        {editing && <>
          {input('summary', summary, setSummary, { maxLength: 240 })}
          <Field id={`${prefix}-resources`} label={t('center.resources')} error={invalid === 'resources' ? t('center.required') : undefined}>
            <div id={`${prefix}-resources`} tabIndex={-1} className="center-options" aria-describedby={invalid === 'resources' ? `${prefix}-resources-error` : undefined}>{resourceOptions.map(option => <Checkbox key={option.key} children={option.label} checked={resources.includes(option.key)} onChange={checked => setResources(old => checked ? [...old, option.key].slice(0,16) : old.filter(key => key !== option.key))} />)}</div>
          </Field>
          {conflicts.map(conflict => <Notice key={`${conflict.noticeId}:${conflict.resource}`}>{t('center.conflict', { resource: conflict.resource, id: conflict.noticeId })}</Notice>)}
          {board.page?.conflictCoverage !== 'observed' && <p>{t('center.conflictsUnknown')}</p>}
          {notice ? <>
            {input('duration', duration, setDuration, { type: 'number', min: 1, max: 604800 })}
            {(tasks.length > 0 || threads.length > 0) && <Field label={t('center.tasks')}><div className="center-options">{[...new Set([...threads, ...tasks.map(task => task.id)])].map(id => <Checkbox key={id} children={tasks.find(task => task.id === id)?.title ?? id} checked={threads.includes(id)} onChange={checked => setThreads(old => checked ? [...old, id].slice(0,16) : old.filter(key => key !== id))} />)}</div></Field>}
          </> : <>{input('cause', cause, setCause, { maxLength: 128 })}{input('evidence', evidence, setEvidence)}</>}
        </>}
        {action === 'notice_close' && <><SingleChoice label={t('center.reason')} value={closeReason} onChange={setCloseReason} options={['owner-closed','completed','cancelled'].map(value => ({ value, label: t(`center.${value}`) }))} /><p>{t('center.closeConsequence')}</p></>}
        {action === 'blocker_clear' && <>
          {input('evidence', evidence, setEvidence)}
          <SingleChoice label={t('center.recovery')} value={recovery} onChange={setRecovery} options={['non-code', 'code'].map(value => ({ value, label: t(`center.${value}`) }))} />
          {recovery === 'code' ? <><Field id={`${prefix}-project`} label={t('center.project')} error={invalid === 'project' ? t('center.required') : undefined}><div id={`${prefix}-project`} tabIndex={-1} aria-invalid={invalid === 'project' || undefined} aria-describedby={invalid === 'project' ? `${prefix}-project-error` : undefined}><SingleChoice label={t('center.project')} value={project || 'choose-project'} onChange={value => setProject(value === 'choose-project' ? '' : value)} options={[{ value: 'choose-project', label: t('center.chooseProject') }, ...options.filter(r => r.key.startsWith('project:')).map(r => ({ value: r.key.slice(8,-5), label: r.label }))]} /></div></Field>{input('commit', commit, setCommit)}</> : input('reason', reason, setReason, { maxLength: 240 })}
          <SingleChoice label={t('center.next')} value={next} onChange={setNext} options={['inspect', 'consider-resume', 'ask-user'].map(value => ({ value, label: t(`center.${value}`) }))} />
          <p>{t('center.clearConsequence')}</p>
        </>}
      </fieldset>
      <div className="center-actions"><Button onClick={onClose} disabled={busy}>{t('cancel')}</Button><Button type="submit" variant="primary" busy={busy} disabled={loading || !!loadError}>{t('save')}</Button></div>
    </form>
  </Dialog>;
}

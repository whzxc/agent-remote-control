import { useState, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, CircleHelp, FileText, GitCompareArrows, Globe, History, ListChecks, MessageCircle, MoreHorizontal, ShieldQuestion, Terminal, Timer, Wifi } from 'lucide-react';
import { Button, Icon, IconButton, Tile, Tooltip } from './index';
import { Card } from './card';
import { taskPhaseIcons } from './NodeCapsule';
import type { HomepageTask } from '../../state/activityModel';
import { t } from '../../i18n';
import './TaskCard.css';

export function recordedDuration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export type TaskOrigin = { label: string; graphic: ReactNode };
export function TaskCard({ task, origins, density, now, path, freshness, onOpen, onRead, onMove }: {
  task: HomepageTask; origins: TaskOrigin[]; density: 'wide' | 'standard' | 'compact'; now: number;
  path?: string; freshness?: string; onOpen?: () => void; onRead: () => void; onMove?: (by: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const offline = task.group === 'unconfirmed', needsMe = task.group === 'needs-me', unread = task.group === 'unread';
  const title = task.session.title || task.session.headline || task.session.id;
  const details = density !== 'compact' || expanded;
  const elapsed = task.startedAt && !offline ? Date.parse(task.endedAt ?? '') || task.session.endedAt || (task.group === 'running' || needsMe ? now : NaN) : NaN;
  const duration = elapsed - Date.parse(task.startedAt ?? '');
  const { steps, plan, change } = task.activity;
  const phase = steps.at(-1)?.kind ?? (task.session.phase === 'command' ? 'command' : task.session.phase === 'thinking' ? 'thinking' : undefined);
  const stateLabel = offline ? 'unconfirmed' : needsMe ? task.session.interaction?.kind === 'question' ? 'needsInput' : 'approvalRequired' : task.group === 'running' ? phase ?? 'running' : task.session.status === 'failed' ? 'failed' : ['cancelled', 'interrupted'].includes(task.session.status ?? '') ? 'interrupted' : 'completed';
  const seconds = Math.floor(Math.max(0, duration) / 1000);
  const elapsedLabel = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const openLabel = `${t('homepage.openDetail')}: ${title}`;
  return <article aria-label={title} className="task-feed-card" data-group={task.group}>
    <Card padded variant="reply" className="task-feed-card-shell">
      <header><Tile icon={offline ? CircleHelp : needsMe ? task.session.interaction?.kind === 'question' ? CircleHelp : ShieldQuestion : unread ? Check : taskPhaseIcons[phase ?? 'running']} form="phase" tone={needsMe ? 'warning' : unread ? 'success' : offline ? 'neutral' : phase === 'reading' || phase === 'editing' ? 'file' : phase === 'thinking' ? 'thinking' : 'command'} />
        <div className="task-card-heading">{onOpen ? <button className="task-card-title" aria-label={openLabel} onClick={onOpen}
          aria-keyshortcuts={onMove ? 'ArrowUp ArrowDown' : undefined} onKeyDown={event => {
            if (onMove && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); onMove(event.key === 'ArrowUp' ? -1 : 1); }
          }}>{title}</button> : <span className="task-card-title">{title}</span>}
          <div className="task-card-state"><span>{t(`homepage.${stateLabel}`)}</span>{Number.isFinite(duration) && <span><Icon icon={Timer} size={12} />{elapsedLabel}</span>}</div>
        </div>
        {(onOpen || onMove) && <DropdownMenu.Root><DropdownMenu.Trigger asChild><IconButton compact icon={MoreHorizontal} label={`${t('homepage.more')}: ${title}`} /></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="task-card-menu" sideOffset={4}>
            {onMove && <><DropdownMenu.Item onSelect={() => onMove(-1)}><Icon icon={ArrowUp} />{t('homepage.moveUp')}</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => onMove(1)}><Icon icon={ArrowDown} />{t('homepage.moveDown')}</DropdownMenu.Item></>}
            {onOpen && <DropdownMenu.Item onSelect={onOpen}><Icon icon={ArrowUpRight} />{t('homepage.openDetail')}</DropdownMenu.Item>}
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>}
      </header>
      <div className="task-card-origin-row"><span className="task-card-origins" role="img" aria-label={origins.map(origin => origin.label).join(' → ')}>
        {origins.map((origin, index) => <span key={`${index}:${origin.label}`}>{index > 0 && <Icon icon={ChevronRight} size={10} />}<Tooltip text={origin.label}><span className="task-card-origin">{origin.graphic}</span></Tooltip></span>)}
      </span>{offline ? <span className="task-card-meta">{freshness}</span> : path && <span className="task-card-meta"><Icon icon={path.startsWith('LAN') ? Wifi : Globe} size={12} />{path}</span>}</div>
      {!offline && <p className="task-card-activity" data-compact={!details || undefined} title={task.session.headline}>{task.session.headline || task.session.fallbackHeadline}</p>}
      {details && !offline && <>
        {steps.length > 0 && <ol className="task-card-steps" aria-label={t('homepage.recentSteps')}>{steps.slice(-(density === 'wide' ? 5 : expanded ? 4 : 3)).map((step, index) => <li key={index} data-status={step.status}>
          <Icon icon={taskPhaseIcons[step.kind]} size={14} /><span title={step.text}>{step.text}</span><code>{step.durationMs === undefined ? '' : recordedDuration(step.durationMs)}</code>
        </li>)}</ol>}
        {plan && <div className="task-card-plan"><div><Icon icon={ListChecks} size={14} /><span>{t('homepage.plan')} {plan.completed}/{plan.total}</span><span title={plan.current}>{plan.current}</span></div>
          <div role="progressbar" aria-label={t('homepage.plan')} aria-valuenow={plan.completed} aria-valuemin={0} aria-valuemax={plan.total}><span style={{ width: `${plan.completed / plan.total * 100}%` }} /></div>
        </div>}
      </>}
      {change && <div className="task-card-change" data-compact={!details || undefined}><div><Icon icon={change.kind === 'command' ? Terminal : change.kind === 'diff' ? GitCompareArrows : FileText} size={14} />
        <code title={change.summary}>{change.summary}</code>{change.added !== undefined && <span className="task-added">+{change.added}</span>}{change.removed !== undefined && <span className="task-removed">−{change.removed}</span>}</div>
        {details && change.output && <p title={change.output}>{change.output}</p>}
      </div>}
      {task.partial && <span className="task-card-meta"><Icon icon={History} size={12} />{t('homepage.partial')}</span>}
      <footer>{needsMe && onOpen && <Button variant="primary" onClick={onOpen}><Icon icon={task.session.interaction?.kind === 'question' ? MessageCircle : ShieldQuestion} />{t(task.session.interaction?.kind === 'question' ? 'homepage.answer' : 'homepage.approve')}</Button>}
        {density === 'compact' && !offline && <Button variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t(expanded ? 'homepage.hideActivity' : 'homepage.activity')}<Icon icon={expanded ? ChevronUp : ChevronDown} size={14} /></Button>}
        {onOpen && <Button onClick={onOpen}><Icon icon={ArrowUpRight} />{t('homepage.openDetail')}</Button>}
        {unread && <IconButton className="task-card-read" compact icon={Check} label={`${t('homepage.markRead')}: ${title}`} onClick={onRead} />}
      </footer>
    </Card>
  </article>;
}

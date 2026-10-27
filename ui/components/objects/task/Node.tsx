import { useRef } from 'react';
import { Check, MoveHorizontal } from 'lucide-react';
import { t } from '../../../i18n';
import type { TrackedActivity, BubbleDensity } from '../../../state/activityModel';
import { Button, Icon, IconButton, SingleChoice } from '../../ui';
import { SourceBadge } from '../../activity';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { bubbleWidth } from '../../../subscriptions/displayPreferences';
import { ActivityBubbleContent } from './Content';

export function TaskNode({ agent, session, now, onMove, onRead, density = "standard", blocking = false, selected, disabled, onOpen }: { agent: string; session: TrackedActivity; now: number; density?: BubbleDensity; onMove?: (by: number) => void; onRead: () => void; onOpen: () => void; blocking?: boolean; selected?: boolean; disabled?: boolean }) {
  const width = bubbleWidth.use();
  const completed = session.endedAt !== undefined, unread = completed && session.readAt === undefined;
  const press = useRef<{ id: number; x: number; y: number; moved: boolean } | undefined>(undefined);
  const cancelled = useRef(false);
  const move = (event: React.PointerEvent) => {
    const start = press.current;
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) start.moved = true;
  };
  const hint = t("timeline.open");
  return <Popover><PopoverAnchor asChild><div className="activity-bubble-shell group/context relative"><Button variant="surface" type="button" className={`activity-bubble ${session.interaction ? "needs-attention" : ""} ${completed ? "completed" : ""}`}
      disabled={disabled} aria-current={selected ? "true" : undefined}
      data-update-blocking={blocking || undefined}
      data-density={density} data-external={session.source === "transcript" || undefined}
      data-timeline-anchor
      data-unread={unread || undefined}
      aria-keyshortcuts={onMove ? "ArrowUp ArrowDown" : undefined} aria-description={onMove ? t("reorderNodeHint") : undefined}
      onKeyDown={event => { if (onMove && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault(); onMove(event.key === "ArrowUp" ? -1 : 1);
      } }}
      data-activity-session={JSON.stringify([agent, session.id])}
      aria-label={`${session.title || t("timeline.title")}${unread ? ` · ${t("activity.unread")}` : ""} · ${hint}`} onClick={() => {
        onOpen();
      }}>
      <ActivityBubbleContent agent={agent} session={session} now={now} density={density} showSourceBadge={!unread} />
      {blocking && <span className="update-blocking-tag">{t("updates.waitingReply")}</span>}
    </Button>
    <span className="absolute right-0 top-0 z-10 -translate-y-1/2 translate-x-1/2 rounded-full border bg-card shadow-sm opacity-0 group-hover/context:opacity-100 group-focus-within/context:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100" data-topology-control onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <PopoverTrigger asChild><IconButton icon={MoveHorizontal} label={t('context.bubbleWidth')} /></PopoverTrigger>
    </span>
    {unread && <Button variant="ghost" className="activity-mark-read" disabled={disabled} data-topology-control aria-label={t("activity.markRead")} title={t("activity.markRead")}
      onPointerDown={event => {
        event.stopPropagation();
        if (!event.isPrimary || event.button !== 0) return;
        cancelled.current = false;
        press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { event.stopPropagation(); move(event); }}
      onPointerUp={event => {
        event.stopPropagation(); move(event);
        if (press.current?.id !== event.pointerId) return;
        cancelled.current = press.current.moved;
        press.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={event => { event.stopPropagation(); press.current = undefined; cancelled.current = true; }}
      onLostPointerCapture={event => { event.stopPropagation(); if (press.current) { press.current = undefined; cancelled.current = true; } }}
      onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        if (event.detail !== 0 && cancelled.current) { event.preventDefault(); return; }
        onRead();
      }}><Icon icon={Check} />{session.dispatchSummary?.controlSource && <SourceBadge source={session.dispatchSummary.controlSource} />}</Button>}
  </div></PopoverAnchor>
    <PopoverContent side="right" align="start" className="w-fit p-2" aria-label={t('context.bubbleWidth')} onEscapeKeyDown={event => event.stopPropagation()}>
      <SingleChoice compact label={t('context.bubbleWidth')} value={width} options={(['narrow', 'medium', 'wide'] as const).map(value => ({ value, label: t(`context.${value}`) }))} onChange={value => { if (value === 'narrow' || value === 'medium' || value === 'wide') bubbleWidth.set(value); }} />
    </PopoverContent></Popover>;
}

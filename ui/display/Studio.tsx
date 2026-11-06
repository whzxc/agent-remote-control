import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { Expand, Minimize, Monitor, Moon, Sun, Sunrise } from 'lucide-react';
import { Button, Icon, IconButton, SingleChoice } from '../components/ui';
import { BoardHeader } from '../components/ui/board-header';
import { locale, t } from '../i18n';
import { isDesktop } from '../platform';
import { notify } from '../state/connector';
import { panelLayers } from '../state/panels';
import { appEnvironment, appNow } from '../state/appEnvironment';
import { nextClockTick, parseStudioPhase, studioToneAt, studioActivitySummary } from './model';
import { openCenter } from '../coordination/state';
import { trackedActivity } from '../state/activityBubbles';
import { taskExecutions } from '../state/taskExecution';
import { activityApprovals, agentActivity } from '../state/activity';
import { studioEnabled, studioPhase, studioTone } from './state';
import { useStudioMotion } from './useStudioMotion';
import './studio.css';

function useMinuteClock(enabled: boolean) {
  const [now, setNow] = useState(appNow);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const value = appNow(); setNow(value);
      const sample = appEnvironment.get();
      const speed = sample?.active && sample.clock.source === 'override' ? sample.clock.value.speed : 1;
      if (document.visibilityState !== 'hidden' && speed > 0) timer = setTimeout(update, Math.max(16, nextClockTick(value) / speed));
    };
    const stop = appEnvironment.subscribe(update);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('pageshow', update);
    update();
    return () => { clearTimeout(timer); stop(); document.removeEventListener('visibilitychange', update); window.removeEventListener('focus', update); window.removeEventListener('pageshow', update); };
  }, [enabled]);
  return now;
}

function HomepageBoardHeader({ now }: { now: number }) {
  const activity = trackedActivity.use(), executions = taskExecutions.use(), submissions = activityApprovals.use();
  const { snapshot, error } = agentActivity.use();
  const language = locale.use(), date = new Date(now);
  const { running, needsYou } = studioActivitySummary(activity, executions, submissions);
  const summary = error ? t('studio.activityUnavailable') : !snapshot ? t('loading') : [
    running > 0 ? t('studio.running', { count: running }) : '',
    needsYou > 0 ? t('studio.pending', { count: needsYou }) : '',
  ].filter(Boolean).join(' · ');
  const day = new Intl.DateTimeFormat(language, { month: 'long', day: 'numeric' }).format(date);
  const weekday = new Intl.DateTimeFormat(language, { weekday: 'short' }).format(date);
  const time = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return <BoardHeader date={`${day} · ${weekday}`} time={time} dateTime={date.toISOString()}
    clockLabel={t('studio.clock')} activityLabel={t('studio.activity')} title={t('center.title')}
    openLabel={t('center.open')} summary={summary} onOpen={() => openCenter()} />;
}

export function HomepageDisplay({ headerVisible }: { headerVisible: boolean }) {
  const enabled = studioEnabled.use(), phase = studioPhase.use();
  const motion = useStudioMotion(enabled && headerVisible);
  const now = useMinuteClock(headerVisible || enabled && motion.visible), tone = studioToneAt(now, phase);
  useLayoutEffect(() => { studioTone.set(enabled ? tone : null); }, [enabled, tone]);
  useLayoutEffect(() => () => studioTone.set(null), []);
  return <>
    {enabled && <div className="studio-backdrop" data-phase={tone} data-motion={motion.state} aria-hidden="true">
      <div className="studio-image studio-day" /><div className="studio-image studio-night" />
      <div className="studio-atmosphere" />
      <div className="studio-motion"><div className="studio-window-light" /><div className="studio-leaf-shadows" /><div className="studio-lamp-light" /><div className="studio-window-glints" /></div>
    </div>}
    {headerVisible && <HomepageBoardHeader now={now} />}
  </>;
}

export function StudioLighting() {
  const phase = studioPhase.use();
  return <SingleChoice label={t('studio.light')} value={phase} onChange={value => studioPhase.set(parseStudioPhase(value))}
    options={[{ value: 'auto', label: t('studio.auto'), icon: Sunrise }, { value: 'day', label: t('studio.day'), icon: Sun }, { value: 'night', label: t('studio.night'), icon: Moon }]} />;
}

export function StudioControls({ available }: { available: boolean }) {
  const enabled = studioEnabled.use();
  const [open, setOpen] = useState(false), [fullscreen, setFullscreen] = useState(false), [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), wasFullscreen = useRef(false), pendingFullscreen = useRef(false);
  const restoreFocus = () => {
    if (trigger.current?.getClientRects().length && !panelLayers.get().length && !document.querySelector('[role="dialog"]')) trigger.current.focus();
  };
  useEffect(() => { if (!available) setOpen(false); }, [available]);
  useEffect(() => {
    let disposed = false, unlisten: (() => void) | undefined;
    const accept = (value: boolean) => {
      if (disposed) return;
      setFullscreen(value);
      if (!value && wasFullscreen.current) restoreFocus();
      wasFullscreen.current = value;
    };
    const read = () => {
      if (isDesktop) void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().isFullscreen()).then(accept).catch(() => {});
      else accept(!!document.fullscreenElement);
    };
    read();
    if (isDesktop) void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const stop = await getCurrentWindow().onResized(read);
      if (disposed) stop(); else unlisten = stop;
      read();
    }).catch(() => {});
    else document.addEventListener('fullscreenchange', read);
    return () => { disposed = true; unlisten?.(); document.removeEventListener('fullscreenchange', read); };
  }, []);
  async function changeFullscreen(value: boolean) {
    if (pendingFullscreen.current) return;
    pendingFullscreen.current = true; setBusy(true);
    try {
      if (isDesktop) {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow(); await window.setFullscreen(value);
        const actual = await window.isFullscreen(); setFullscreen(actual); wasFullscreen.current = actual;
        if (!value && !actual) restoreFocus();
      } else if (value) await document.documentElement.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
    } catch { notify(t('studio.fullscreenFailed'), true); }
    finally { pendingFullscreen.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (!isDesktop || !fullscreen || !available || open) return;
    let escapeTimer: ReturnType<typeof setTimeout>;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Task queues and overlays also handle Escape on window. Let the event finish first.
      clearTimeout(escapeTimer);
      escapeTimer = setTimeout(() => {
        if (event.defaultPrevented || panelLayers.get().length || document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]')) return;
        void changeFullscreen(false);
      }, 0);
    };
    window.addEventListener('keydown', escape);
    return () => { clearTimeout(escapeTimer); window.removeEventListener('keydown', escape); };
  }, [fullscreen, available, open]);
  if (!enabled) return null;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><IconButton ref={trigger} icon={Monitor} size={20} label={t('studio.settings')} data-hover-target="studio" /></Popover.Trigger>
    <Popover.Portal><Popover.Content className="studio-settings" side="top" align="start" sideOffset={12} collisionPadding={16}
      aria-label={t('studio.settings')} onEscapeKeyDown={event => event.stopPropagation()}>
      <StudioLighting />
      <Button busy={busy} onClick={() => { void changeFullscreen(!fullscreen); setOpen(false); }}>
        <Icon icon={fullscreen ? Minimize : Expand} />{t(fullscreen ? 'studio.exitFullscreen' : 'studio.fullscreen')}
      </Button>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

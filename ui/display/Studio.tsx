import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Popover } from 'radix-ui';
import { Expand, Minimize, Monitor, Moon, Sun, Sunrise } from 'lucide-react';
import { Button, Icon, IconButton, SingleChoice, Switch } from '../components/ui';
import { locale, t } from '../i18n';
import { isDesktop } from '../platform';
import { notify } from '../state/connector';
import { panelLayers } from '../state/panels';
import { appEnvironment, appNow } from '../state/appEnvironment';
import { nextClockTick, parseStudioPhase, studioToneAt } from './model';
import { studioEnabled, studioPhase, studioTone } from './state';
import './studio.css';

function useStudioClock(enabled: boolean) {
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

export function StudioBackground({ clockVisible }: { clockVisible: boolean }) {
  const enabled = studioEnabled.use(), phase = studioPhase.use(), language = locale.use();
  const now = useStudioClock(enabled), tone = studioToneAt(now, phase);
  useLayoutEffect(() => { studioTone.set(enabled ? tone : null); }, [enabled, tone]);
  useLayoutEffect(() => () => studioTone.set(null), []);
  if (!enabled) return null;
  const date = new Date(now);
  return <>
    <div className="studio-backdrop" data-phase={tone} aria-hidden="true">
      <div className="studio-image studio-day" /><div className="studio-image studio-night" />
      <div className="studio-atmosphere" />
    </div>
    {clockVisible && <time className="studio-clock" data-studio-clock dateTime={date.toISOString()} title={t('studio.clock')}>
      {new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)}
    </time>}
  </>;
}

export function StudioControls({ available }: { available: boolean }) {
  const enabled = studioEnabled.use(), phase = studioPhase.use();
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
        const window = getCurrentWindow(); await window.setFullscreen(value); setFullscreen(await window.isFullscreen());
        wasFullscreen.current = value;
        if (!value) restoreFocus();
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
  return <div className="studio-controls" hidden={!available} data-active={enabled || open || undefined}>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild><IconButton ref={trigger} icon={Monitor} label={t('studio.settings')} /></Popover.Trigger>
      <Popover.Portal><Popover.Content className="studio-settings" side="top" align="end" sideOffset={12} collisionPadding={16}
        aria-label={t('studio.settings')} onEscapeKeyDown={event => event.stopPropagation()}>
        <div className="studio-setting-row"><span>{t('studio.enabled')}</span><Switch checked={enabled} onChange={studioEnabled.set} label={t('studio.enabled')} /></div>
        {enabled && <SingleChoice label={t('studio.light')} value={phase} onChange={value => studioPhase.set(parseStudioPhase(value))}
          options={[{ value: 'auto', label: t('studio.auto'), icon: Sunrise }, { value: 'day', label: t('studio.day'), icon: Sun }, { value: 'night', label: t('studio.night'), icon: Moon }]} />}
        <Button busy={busy} onClick={() => { void changeFullscreen(!fullscreen); setOpen(false); }}>
          <Icon icon={fullscreen ? Minimize : Expand} />{t(fullscreen ? 'studio.exitFullscreen' : 'studio.fullscreen')}
        </Button>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
  </div>;
}

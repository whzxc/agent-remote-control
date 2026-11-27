import { useEffect, useState } from 'react';
import { HomepageBarView } from './HomepageBar';
import { homepageMode, selectHomepageMode } from '../state/homepage';
import { locale, t } from '../i18n';
import { appEnvironment, appNow } from '../state/appEnvironment';
import { nextClockTick, studioActivitySummary } from './model';
import { openCenter } from '../coordination/state';
import { trackedActivity } from '../state/activityBubbles';
import { taskExecutions } from '../state/taskExecution';
import { activityApprovals, agentActivity } from '../state/activity';

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

function HomepageBar({ now }: { now: number }) {
  const activity = trackedActivity.use(), executions = taskExecutions.use(), submissions = activityApprovals.use();
  const { snapshot, error } = agentActivity.use();
  const mode = homepageMode.use();
  const language = locale.use(), date = new Date(now);
  const { running, needsYou } = studioActivitySummary(activity, executions, submissions);
  const summary = error ? t('studio.activityUnavailable') : !snapshot ? t('loading') : [
    running > 0 ? t('studio.running', { count: running }) : '',
    needsYou > 0 ? t('studio.pending', { count: needsYou }) : '',
  ].filter(Boolean).join(' · ');
  const day = new Intl.DateTimeFormat(language, { month: 'long', day: 'numeric' }).format(date);
  const weekday = new Intl.DateTimeFormat(language, { weekday: 'short' }).format(date);
  const time = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  return <HomepageBarView dateTime={date.toISOString()} time={time} day={day} weekday={weekday}
    summary={summary} mode={mode} onOpenBoard={() => openCenter()}
    onModeChange={value => selectHomepageMode(value as 'topology' | 'tasks')} />;
}

export function HomepageDisplay({ headerVisible }: { headerVisible: boolean }) {
  const now = useMinuteClock(headerVisible);
  return headerVisible ? <HomepageBar now={now} /> : null;
}

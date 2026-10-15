// Burn-rate rules adapted from OpenUsage Support/Pace.swift and WidgetData.meterState (MIT).
import type {ProviderSnapshot, QuotaWindow} from './types';
import {quotaDisplay, resetDisplay} from './displayPreferences';
import {compactReset, preciseTime, usageColors} from './presentation';
import {t} from '../i18n';
import { quotaTiming } from './quotaTiming';
export function quotaPace(w:QuotaWindow,p:ProviderSnapshot,now:number) {
  if(p.state!=='ready'||p.error||!Number.isFinite(w.usedPercent))return;
  const used=w.usedPercent;
  if(used>=100||w.exhausted||p.accountBlocked||p.blockedPoolIds.includes(w.poolId))return {color:usageColors.exhausted,label:t('usagePaceReached'),tooltip:t('usagePaceReached'),flame:true};
  const timing=quotaTiming(w,p,now);
  if(!timing)return;
  const {length,reset,elapsed,projected,warning}=timing;
  if(projected>90&&used<5)return;
  const spare=Math.round(100-projected), danger=projected>100||(projected>90&&spare<1);
  const eta=(100-used)*elapsed/used;
  const label=danger ? eta>0&&eta<reset-now ? t(resetDisplay.get()==='time'?'usagePaceLimitAt':'usagePaceLimit',{time:resetDisplay.get()==='time'?preciseTime(new Date(now+eta).toISOString()):compactReset(new Date(now+eta).toISOString(),now)}) : t('usagePaceAtLimit') : projected>90 ? t('usagePaceSpare',{percent:spare}) : '';
  const tooltip=projected>100?t('usagePaceOver',{percent:Math.round(projected-100)}):projected>90?t('usagePaceUsed',{percent:Math.round(projected)}):t('usagePaceLeft',{percent:spare});
  return {color:warning?usageColors.warning:projected>90?usageColors.caution:usageColors.good,label,tooltip,flame:warning,tick:(quotaDisplay.get()==='remaining'?1-elapsed/length:elapsed/length)*100};
}

import { t } from "../i18n";
import { quotaTiming } from './quotaTiming';
import openaiIcon from '../assets/agents/openai.svg';
import { locale } from '../i18n';
import { type QuotaWindow,type ProviderSnapshot } from './types';
const icons=import.meta.glob('../assets/brand-reserve/agents/*/*.svg',{eager:true,query:'?url',import:'default'}) as Record<string,string>;
export const brandIcon=(id:string)=>{const agent=id==='gemini'?'antigravity':id;return agent==='codex'?openaiIcon:icons[`../assets/brand-reserve/agents/${agent}/mono.svg`]||icons[`../assets/brand-reserve/agents/${agent}/color.svg`];};
export { usageColors } from '../colors';
import { usageColors } from '../colors';
export function readingStatus(w:QuotaWindow|undefined,p:ProviderSnapshot,now=Date.now()){
 // Old quota numbers are displayable as stale, but cannot colour the surface.
 const valid=p.state==='ready'&&!p.error;
 const blocked=valid&&(p.accountBlocked||!!w&&(w.exhausted||p.blockedPoolIds.includes(w.poolId)));
 const used=valid&&w&&Number.isFinite(w.usedPercent)?w.usedPercent:undefined;
 const exhausted=blocked||used!==undefined&&used>=100;
 const warning=used!==undefined&&!!w&&quotaTiming(w,p,now)?.warning===true;
 return {alert:!!exhausted||warning,rank:exhausted?4:used===undefined?0:warning?3:used>=50?2:1,color:exhausted?usageColors.exhausted:used===undefined?usageColors.unknown:warning?usageColors.warning:used>=50?usageColors.caution:usageColors.good};
}
export function quotaColor(w:QuotaWindow|undefined,p:ProviderSnapshot,now=Date.now()){return readingStatus(w,p,now).color;}
export function surfaceStatus(rows:ProviderSnapshot[],now=Date.now()){return rows.map(p=>readingStatus(p.windows.find(w=>w.id===p.displayWindowId),p,now)).reduce((a,b)=>b.rank>a.rank?b:a,{alert:false,rank:0,color:usageColors.unknown});}
export function duration(minutes:number,showMinutes=true){const total=Math.max(0,Math.floor(minutes)),d=Math.floor(total/1440),h=Math.floor(total%1440/60),min=total%60;return [d?`${d}${t('durationDays')}`:'',h?`${h}${t('durationHours')}`:'',showMinutes&&min?`${min}${t('durationMinutes')}`:''].filter(Boolean).join(' ')||`0${t(showMinutes?'durationMinutes':'durationHours')}`;}
export function resetText(value:string|undefined,now:number,showMinutes=false){if(!value)return '—';const minutes=Math.ceil((Date.parse(value)-now)/60000);return Number.isFinite(minutes)?duration(Math.max(0,minutes),showMinutes):'—';}
export const preciseTime=(value?:string)=>value?new Date(value).toLocaleString(locale.get()):'';
export const errorLabels:Record<string,string>={'credentials-missing':'usageCredentialsMissing','authentication-failed':'usageAuthenticationFailed','request-forbidden':'usageRequestForbidden','request-failed':'usageRequestFailed','credential-access-denied':'usageCredentialDenied','no-subscription':'usageNoSubscription','no-limits-reported':'usageNoLimits','rate-limited':'usageRateLimited','network-error':'usageNetworkError','invalid-response':'usageInvalidResponse','unsupported-platform':'usageUnsupported'};

export function compactReset(value: string | undefined, now: number) {
  const minutes = Math.max(0, Math.ceil((Date.parse(value || "") - now) / 60000));
  if (!Number.isFinite(minutes)) return "—";
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

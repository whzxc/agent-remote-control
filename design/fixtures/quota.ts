import type { QuotaWindow, QuotaReading } from '../components/quota';

export const agentQuotas = [
  { label: "5 小时额度", value: 27, mode: "剩余", reset: "2 小时后重置", detail: "≈ 1h 7m", projected: 0, elapsed: 0.6, tone: "warning" },
  { label: "周额度", value: 32, mode: "剩余", reset: "3 天后重置", detail: "≈ 1d 21h", projected: 0, elapsed: 4 / 7, tone: "success" },
] as const satisfies readonly QuotaWindow[];

export const quotaSpecimens = [
  { name: "healthy", ...agentQuotas[1] },
  { name: "warning", ...agentQuotas[0] },
  { name: "exhausted", label: "5 小时额度", value: 0, mode: "剩余", reset: "35 分钟后重置", detail: "已用尽", tone: "danger" },
] as const satisfies readonly (QuotaWindow & { name: string })[];

export const antigravityQuotaOverview = {
  name: "Antigravity",
  observed: "1分钟前",
  windows: [
    {
      label: "Gemini · 5h 限额", value: 15, mode: "已用", reset: "2 小时 54 分钟后重置",
      projected: 36, detail: "预计重置时已用 36%", tone: "success",
    },
    { label: "Claude/GPT · 5h 限额", value: 0, mode: "已用", reset: "5 小时后重置", tone: "success" },
    { label: "Gemini · 周限额", value: 4, mode: "已用", reset: "6 天 22 小时后重置", tone: "success" },
    { label: "Claude/GPT · 周限额", value: 0, mode: "已用", reset: "6 天 11 小时后重置", tone: "success" },
  ] satisfies readonly QuotaReading[],
};

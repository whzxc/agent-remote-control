import type { QuotaWindow } from "../modules/quota";

export const agentQuotas = [
  { label: "5 小时额度", value: 27, mode: "剩余", reset: "2 小时后重置", detail: "≈ 1h 7m", elapsed: 0.6, tone: "warning" },
  { label: "周额度", value: 32, mode: "剩余", reset: "3 天后重置", detail: "≈ 1d 21h", elapsed: 4 / 7, tone: "success" },
] as const satisfies readonly QuotaWindow[];

export const quotaSpecimens = [
  { name: "healthy", ...agentQuotas[1] },
  { name: "warning", ...agentQuotas[0] },
  { name: "exhausted", label: "5 小时额度", value: 0, mode: "剩余", reset: "35 分钟后重置", detail: "已用尽", tone: "danger" },
] as const satisfies readonly (QuotaWindow & { name: string })[];

export const overviewProvider = { name: "ChatGPT", observed: "2 分钟前" };

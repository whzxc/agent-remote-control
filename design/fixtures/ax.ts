import type { AXEntry } from "../modules/ax";

export const axTabs = [
  { value: "current", label: "当前" },
  { value: "activity", label: "活动" },
  { value: "ax", label: "AX" },
];
export const axFilters = [
  { value: "open", label: "未结 5" },
  { value: "closed", label: "已关闭 12" },
];
export const axOpenEntries: AXEntry[] = [
  { id: "AX-112", title: "任务已完成，推送回执仍显示中断", status: "open", meta: "可绕过 · 3 次出现 · Claude · 10分钟前" },
  { id: "AX-111", title: "已关闭记录缺少处理理由和验证依据", status: "open", meta: "可绕过 · 1 次出现 · Codex · 1小时前" },
  { id: "AX-110", title: "恢复任务后，详情仍显示上一轮内容", status: "open", meta: "可绕过 · 2 次出现 · Claude · 2小时前" },
  { id: "AX-109", title: "调度策略未展示可用的额度余额", status: "triaged", meta: "可绕过 · 1 次出现 · 本机 · 昨天" },
  { id: "AX-107", title: "本地技能缺少 AX 反馈入口", status: "triaged", meta: "可绕过 · 1 次出现 · 本机 · 昨天" },
];
export const axClosedEntries: AXEntry[] = [
  { id: "AX-108", title: "任务回执到达后，公示牌仍保留旧状态", status: "fixed", meta: "3 次出现 · Claude · 今天 11:06 关闭" },
  { id: "AX-106", title: "历史记录翻页后重复显示同一条事件", status: "fixed", meta: "2 次出现 · Codex · 昨天 关闭" },
  { id: "AX-105", title: "已结束的通知仍显示为等待发送", status: "fixed", meta: "1 次出现 · 本机 · 11月3日 关闭" },
  { id: "AX-104", title: "关闭面板时同时结束原生会话", status: "wontfix", meta: "1 次出现 · Claude · 11月2日 关闭" },
];
export const axDetail = {
  entry: axClosedEntries[0],
  facts: [
    { label: "现象", text: axClosedEntries[0].title },
    { label: "预期", text: "收到同一轮任务的完成回执后，公示牌同步显示最终状态。" },
  ],
  resolution: "已统一回执与公示牌使用的轮次标识，并补充完成状态同步的回归验证。",
  commit: "a1b2c3d",
  evidence: [
    { icon: "receipt-text", label: "回执", value: "fixture-receipt-07", status: "已完成" },
    { icon: "message-square", label: "任务", value: "fixture-thread-12", status: "已完成" },
  ],
  history: [
    { time: "11月5日 10:42", text: "Claude · 报告问题", icon: "circle-dot" },
    { time: "11月5日 11:06", text: "本机 · 记录修复", icon: "check" },
  ],
};
export const axForms = ["open", "closed", "detail"] as const;

export const axStatusLabels = { open: "待处理", triaged: "已分诊", fixed: "已修复", wontfix: "不处理" };
export const axCopy = {
  region: "公示牌",
  refresh: "刷新",
  back: "AX 清单",
  copyId: "复制记录标识",
  workaround: "可绕过",
  lastSeen: "3 次出现 · Claude · 最后出现于 11月5日 10:58",
  result: "处理结果",
  fixingCommit: "修复提交",
  copyCommit: "复制修复提交",
  evidence: "关联证据",
  history: "处理记录",
  status: "AX 状态",
  search: "搜索编号或问题",
  shown: "已显示 4 / 12 项",
  updated: "更新于 14:32",
  more: "加载更多",
  openBoard: "查看公示牌",
  closedFilter: "已关闭 12",
  detailNote: "Full-content detail may exceed the panel scroll viewport. Entries are synthetic owner metadata.",
  note: "Entries are synthetic owner metadata.",
};

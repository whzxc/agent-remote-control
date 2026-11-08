import { Frame, Icon } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { SingleChoice } from "../components/single-choice";
import { SearchInput } from "../components/search";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Tile } from "../components/tile";

const tabs = [
  { value: "current", label: "当前" },
  { value: "activity", label: "活动" },
  { value: "ax", label: "AX" },
];
const filters = [
  { value: "open", label: "未结 5" },
  { value: "closed", label: "已关闭 12" },
];
type Status = "open" | "triaged" | "fixed" | "wontfix";
type Entry = { id: string; title: string; status: Status; meta: string };
const statuses = {
  open: { label: "待处理", icon: "circle-dot", tone: "text-warning bg-warning/10" },
  triaged: { label: "已分诊", icon: "list-checks", tone: "text-phase-command bg-phase-command/10" },
  fixed: { label: "已修复", icon: "check", tone: "text-success bg-success/10" },
  wontfix: { label: "不处理", icon: "minus", tone: "text-text-secondary bg-surface-sunken" },
};
const openEntries: Entry[] = [
  { id: "AX-112", title: "任务已完成，推送回执仍显示中断", status: "open", meta: "可绕过 · 3 次出现 · Claude · 10分钟前" },
  { id: "AX-111", title: "已关闭记录缺少处理理由和验证依据", status: "open", meta: "可绕过 · 1 次出现 · Codex · 1小时前" },
  { id: "AX-110", title: "恢复任务后，详情仍显示上一轮内容", status: "open", meta: "可绕过 · 2 次出现 · Claude · 2小时前" },
  { id: "AX-109", title: "调度策略未展示可用的额度余额", status: "triaged", meta: "可绕过 · 1 次出现 · 本机 · 昨天" },
  { id: "AX-107", title: "本地技能缺少 AX 反馈入口", status: "triaged", meta: "可绕过 · 1 次出现 · 本机 · 昨天" },
];
const closedEntries: Entry[] = [
  { id: "AX-108", title: "任务回执到达后，公示牌仍保留旧状态", status: "fixed", meta: "3 次出现 · Claude · 今天 11:06 关闭" },
  { id: "AX-106", title: "历史记录翻页后重复显示同一条事件", status: "fixed", meta: "2 次出现 · Codex · 昨天 关闭" },
  { id: "AX-105", title: "已结束的通知仍显示为等待发送", status: "fixed", meta: "1 次出现 · 本机 · 11月3日 关闭" },
  { id: "AX-104", title: "关闭面板时同时结束原生会话", status: "wontfix", meta: "1 次出现 · Claude · 11月2日 关闭" },
];
const detail = {
  entry: closedEntries[0],
  facts: [
    { label: "现象", text: closedEntries[0].title },
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
const forms = ["open", "closed", "detail"] as const;

function StatusBadge({ status }: { status: Status }) {
  const item = statuses[status];
  return <span class={`inline-flex shrink-0 items-center gap-[5px] rounded-field px-2 py-1 text-meta leading-4 font-medium ${item.tone}`}>
    <Icon name={item.icon} size={13} />{item.label}
  </span>;
}

function EntryRow({ entry }: { entry: Entry }) {
  return <Card padded class="gap-0">
    <button class="flex w-full items-center gap-3 text-left">
      <Tile form="phase" icon="lightbulb" tone="neutral" />
      <span class="flex min-w-0 flex-1 flex-col gap-[6px]">
        <span class="flex items-baseline gap-3">
          <span class="shrink-0 font-mono text-meta leading-5 text-text-tertiary">{entry.id}</span>
          <strong class="text-small leading-5 font-semibold">{entry.title}</strong>
        </span>
        <span class="text-meta leading-4 text-text-secondary">{entry.meta}</span>
      </span>
      <StatusBadge status={entry.status} />
      <Icon name="chevron-right" size={16} class="shrink-0 text-text-tertiary" />
    </button>
  </Card>;
}

function EntryDetail() {
  return <div class="mt-6 flex flex-col gap-6">
    <div class="flex items-center justify-between">
      <Button variant="ghost" icon="arrow-left">AX 清单</Button>
      <IconButton icon="copy" label="复制记录标识" />
    </div>
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3">
        <span class="font-mono text-meta text-text-secondary">{detail.entry.id}</span>
        <StatusBadge status={detail.entry.status} />
        <span class="text-meta text-text-secondary">可绕过</span>
      </div>
      <h3 class="text-title leading-6 font-semibold">{detail.entry.title}</h3>
      <p class="text-meta leading-4 text-text-secondary">3 次出现 · Claude · 最后出现于 11月5日 10:58</p>
    </div>
    <div class="grid grid-cols-2 gap-8">
      {detail.facts.map(fact => <section class="flex flex-col gap-2">
        <h4 class="text-meta leading-4 font-semibold text-text-secondary">{fact.label}</h4>
        <p class="text-small leading-5">{fact.text}</p>
      </section>)}
    </div>
    <Card padded class="gap-3">
      <h4 class="text-small leading-4 font-semibold">处理结果</h4>
      <p class="text-small leading-5">{detail.resolution}</p>
      <div class="flex items-center gap-2 text-meta leading-4 text-text-secondary">
        <Icon name="git-commit-horizontal" size={14} />
        <span>修复提交</span><code class="font-mono text-text">{detail.commit}</code>
        <IconButton icon="copy" label="复制修复提交" compact />
      </div>
    </Card>
    <section class="flex flex-col gap-3">
      <h4 class="text-meta leading-4 font-semibold text-text-secondary">关联证据</h4>
      <div class="flex flex-col gap-3">
        {detail.evidence.map(item => <div class="flex items-center gap-3 text-small leading-5">
          <Icon name={item.icon} size={15} class="text-text-secondary" />
          <span>{item.label}</span><code class="font-mono text-meta text-text-secondary">{item.value}</code>
          <span class="ml-auto text-meta text-text-secondary">{item.status}</span>
        </div>)}
      </div>
    </section>
    <section class="flex flex-col gap-3 border-t border-border pt-5">
      <h4 class="text-meta leading-4 font-semibold text-text-secondary">处理记录</h4>
      {detail.history.map(item => <div class="flex items-center gap-3 text-meta leading-4">
        <Icon name={item.icon} size={14} class="text-text-tertiary" />
        <span class="text-text-secondary">{item.time}</span><span>{item.text}</span>
      </div>)}
    </section>
  </div>;
}

function AXBoard({ form }: { form: typeof forms[number] }) {
  const closed = form === "closed";
  return <PanelShell width={820} height={form === "detail" ? undefined : 680} class="px-6 pt-[21px] pb-6">
    <PanelHeader title="公示牌" actions={<IconButton icon="refresh-cw" label="刷新" />}>
      <div class="ml-2"><SingleChoice value="ax" options={tabs} label="公示牌" tabs /></div>
    </PanelHeader>
    {form === "detail" ? <EntryDetail /> : <>
      <div class="mt-[29px] flex items-center justify-between gap-6">
        <SingleChoice value={closed ? "closed" : "open"} options={filters} label="AX 状态" class="auto-cols-auto!" />
        <div class="w-[240px]"><SearchInput placeholder="搜索编号或问题" /></div>
      </div>
      <div class="mt-6 flex flex-col gap-2">
        {(closed ? closedEntries : openEntries).map(entry => <EntryRow entry={entry} />)}
      </div>
      <div class="mt-auto flex items-center justify-between pt-6">
        <span class="text-meta leading-4 text-text-tertiary">{closed ? "已显示 4 / 12 项" : "更新于 14:32"}</span>
        {closed && <Button variant="ghost" icon="chevron-down">加载更多</Button>}
      </div>
    </>}
  </PanelShell>;
}

export default () => forms.map(form => <Frame name={form} fixture="coordination-ax-light"
  capture={{ region: "公示牌", viewport: "1280x1000", clicks: ["查看公示牌", "AX", ...(form === "open" ? [] : ["已关闭 12"]), ...(form === "detail" ? [closedEntries[0].title] : [])] }}
  note={form === "detail" ? "Full-content detail may exceed the panel scroll viewport. Entries are synthetic owner metadata." : "Entries are synthetic owner metadata."}>
  <AXBoard form={form} />
</Frame>);

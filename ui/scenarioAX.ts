import type { AXEntry, AXPage } from './coordination/axModel';
const at = '2026-11-05T06:32:00.000Z';
const before = (minutes: number) => new Date(Date.parse(at) - minutes * 60000).toISOString();
const source = (sourceId: string | null) => sourceId ? { type: 'source', sourceId } : { type: 'local-authority' };
const open = [
  [
    "AX-112",
    "任务已完成，推送回执仍显示中断",
    "open",
    3,
    10,
    "fixture-source"
  ],
  [
    "AX-111",
    "已关闭记录缺少处理理由和验证依据",
    "open",
    1,
    60,
    "fixture-codex"
  ],
  [
    "AX-110",
    "恢复任务后，详情仍显示上一轮内容",
    "open",
    2,
    120,
    "fixture-source"
  ],
  [
    "AX-109",
    "调度策略未展示可用的额度余额",
    "triaged",
    1,
    1440,
    null
  ],
  [
    "AX-107",
    "本地技能缺少 AX 反馈入口",
    "triaged",
    1,
    1441,
    null
  ]
] as const;
const closed = [
  [
    "AX-108",
    "任务回执到达后，公示牌仍保留旧状态",
    "fix",
    3,
    206,
    "fixture-source"
  ],
  [
    "AX-106",
    "历史记录翻页后重复显示同一条事件",
    "fix",
    2,
    1440,
    "fixture-codex"
  ],
  [
    "AX-105",
    "已结束的通知仍显示为等待发送",
    "fix",
    1,
    2880,
    null
  ],
  [
    "AX-104",
    "关闭面板时同时结束原生会话",
    "wontfix",
    1,
    4320,
    "fixture-source"
  ]
] as const;
export const axFixtureEntries: AXEntry[] = [
  ...open.map(([id, symptom, status, occurrenceCount, minutes, owner]) => ({
    id, symptom, status, occurrenceCount, revision: 1, kind: 'friction', severity: 'workaround', expected: '同步原生任务的最终状态。',
    resources: [], source: source(owner), firstSeenAt: before(minutes), lastSeenAt: before(minutes), evidence: [],
    history: [{ action: 'reported', at: before(minutes), actor: source(owner), revision: 1 }],
  })),
  ...closed.map(([id, symptom, resolution, occurrenceCount, minutes, owner]) => ({
    id, symptom, resolution, occurrenceCount, status: 'closed', revision: 2, kind: 'friction', severity: 'workaround', resources: [], source: source(owner),
    firstSeenAt: before(minutes + 24), lastSeenAt: before(minutes + 8),
    expected: '收到同一轮任务的完成回执后，公示牌同步显示最终状态。',
    evidence: [{ kind: 'receipt', id: 'fixture-receipt-07', state: 'completed' }, { kind: 'thread', id: 'fixture-thread-12', state: 'completed' }],
    history: [
      { action: 'reported', at: before(minutes + 24), actor: source(owner), revision: 1 },
      { action: resolution, at: before(minutes), actor: source(null), revision: 2, detail: { reason: '已统一回执与公示牌使用的轮次标识，并补充完成状态同步的回归验证。', ...(resolution === 'fix' ? { commit: 'a1b2c3d' } : {}) } },
    ],
  })),
  ...Array.from({ length: 8 }, (_, index) => ({ id: `AX-0${index}`, symptom: `Archived fixture issue ${index}`, status: index === 0 ? 'merged' : 'closed',
    resolution: index === 0 ? 'merged' : 'fix', mergedInto: index === 0 ? 'AX-108' : null, revision: 1, kind: 'friction', expected: 'Keep native state consistent.',
    severity: 'cosmetic', occurrenceCount: 1, resources: [], source: source(null), firstSeenAt: before(10000 + index), lastSeenAt: before(10000 + index), history: [] })),
];
export function axScenario(unavailable: boolean) {
  let fail = unavailable;
  return (path: string, method: string, body?: unknown): AXPage | undefined => {
    if (path !== 'coordination/ax_list') return undefined;
    if (method !== 'POST') throw new Error('SCENARIO_ACTION_UNAVAILABLE');
    if (fail) { fail = false; throw new Error('SCENARIO_AX_UNAVAILABLE'); }
    const args = (body ?? {}) as { id?: string; cursor?: string };
    const rows = args.id ? axFixtureEntries.filter(row => row.id === args.id) : axFixtureEntries;
    const offset = Number(args.cursor ?? 0), entries = rows.slice(offset, offset + 3);
    return { entries, nextCursor: offset + entries.length < rows.length ? String(offset + entries.length) : null, observedAt: at };
  };
}

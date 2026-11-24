import type { OriginStep, TaskPreviewLine } from '../components/task-card';

export const listOrigins: Record<'codex' | 'claudeToCodex' | 'antigravityToCodex' | 'antigravity', OriginStep[]> = {
  codex: [{ label: 'Codex', brand: 'codex' }],
  claudeToCodex: [{ label: 'Claude', brand: 'claude' }, { label: 'Codex', brand: 'codex' }],
  antigravityToCodex: [{ label: 'Antigravity', brand: 'antigravity' }, { label: 'Codex', brand: 'codex' }],
  antigravity: [{ label: 'Antigravity', brand: 'antigravity' }],
};

export type ChildState = 'needs-input' | 'running' | 'complete';
export type Child = { name: string; assignment: string; latest: string; state: ChildState; elapsed?: string };
export type ListExample = {
  title: string; time: string; turns: number; viaClaude?: boolean; originKey?: keyof typeof listOrigins; model: string; effort?: string; tier?: string; project: string;
  status: ChildState; excerpt?: string; previewLines?: TaskPreviewLine[]; preview: 'reply' | 'activity' | 'loading' | 'error' | 'empty';
  children?: Child[];
};

export const stateCopy = { 'needs-input': '等待输入', complete: '已完成' };
export const taskListClock = { title: '公示牌', date: '11月17日 · 周二', time: '11:35' };
export const examples: ListExample[] = [
  { title: '审阅队列测试覆盖范围', time: '04:18', turns: 2, viaClaude: true, model: 'gpt-6.2-astra', tier: 'ultrafast', project: 'queue', status: 'running',
    preview: 'activity', excerpt: '已汇总读取和调度用例，正在核对重试边界。',
    previewLines: [
      { kind: 'tool', text: '运行 4 条命令 · 编辑 2 个文件 · npm test' },
      { kind: 'agent', text: '已汇总读取和调度用例，正在核对重试边界。' },
    ],
    children: [
      { name: 'Curie', assignment: '核对重试上限', latest: '需要确认超时后允许的重试次数。', state: 'needs-input', elapsed: '01:12' },
      { name: 'Newton', assignment: '检查并发调度', latest: '正在比对同优先级任务的出队顺序。', state: 'running', elapsed: '00:54' },
      { name: 'Russell', assignment: '整理回归用例', latest: '已归类 12 个用例，剩余 3 个。', state: 'running', elapsed: '01:40' },
      { name: 'Poincare', assignment: '审阅读取路径', latest: '已有用例覆盖空队列和重复读取。', state: 'complete', elapsed: '00:38' },
    ] },
  { title: '定位构建耗时增长', time: '01:26', turns: 1, originKey: 'antigravityToCodex', model: 'gpt-6.2-sol', tier: 'ultrafast', project: 'build', status: 'running',
    preview: 'activity', excerpt: '正在对比最近两次构建的编译和链接耗时。',
    previewLines: [
      { kind: 'tool', text: '运行 3 条命令 · cargo check --timings' },
      { kind: 'thinking', text: '正在对比最近两次构建的编译和链接耗时。' },
    ] },
  { title: '验证安装后的升级流程', time: '03:10', turns: 3, originKey: 'antigravity', model: 'gemini-4-neon', effort: 'XHigh', project: 'desktop', status: 'complete',
    preview: 'reply', excerpt: '安装和升级均已通过。重启后保留了已有配置，也能继续打开之前的会话。',
    previewLines: [
      { kind: 'tool', text: '运行 6 条命令 · 编辑 3 个文件 · git diff --check' },
      { kind: 'agent', text: '安装和升级均已通过。重启后保留了已有配置，也能继续打开之前的会话。' },
    ] },
  { title: '检查配置读取顺序', time: '02:05', turns: 1, model: 'gpt-6.2-sol', project: 'desktop', status: 'complete',
    preview: 'reply', excerpt: '项目配置会覆盖默认值。',
    previewLines: [
      { kind: 'tool', text: '读取 2 个文件 · config/defaults.toml' },
      { kind: 'agent', text: '项目配置会覆盖默认值。' },
    ] },
  { title: '核对历史记录索引', time: '00:43', turns: 2, model: 'gpt-6.1-terra', project: 'storage', status: 'complete', preview: 'error' },
  { title: '检查新会话的初始状态', time: '00:08', turns: 1, model: 'gpt-6.2-sol', project: 'desktop', status: 'complete', preview: 'empty' },
];

export const dayGridExample = {
  today: [
    { ...examples[2], title: '回归检查桌面端升级流程', excerpt: '已完成安装和升级验收。重启后保留了已有配置与登录状态，也可以从任务列表继续打开升级前的会话。接下来会复核安装包在其他设备上的表现。' },
    { ...examples[2], title: '整理任务反馈和修复进度', time: '02:04', project: 'tasks', excerpt: '已把反馈按影响范围分组，并逐项核对修复状态。高频问题均有明确的验证结果，剩余几项已补充能稳定复现的操作步骤，并记录在对应任务里。' },
    { ...examples[2], title: '验证新版本安装产物', time: '01:40', project: 'release', excerpt: '安装包签名检查和启动验证均已通过。桌面端可以正常打开原有任务，配置和记录也已逐项核对。验收记录及对应安装包已保留在本次运行目录。' },
    { ...examples[2], title: '核对命令行能力覆盖', time: '01:08', project: 'cli', excerpt: '已核对开发版和安装版的命令入口，并用实际任务验证打开、切换和读取操作。需要补充的参数说明已经按命令分组，整理到各自的命令参考中。' },
  ],
  yesterday: [
    { ...examples[0], status: 'complete' as const, children: examples[0].children?.map(child => ({ ...child, state: 'complete' as const })) },
    ...[
      ['汇总版本验收结果', '03:56', 'release'],
      ['核对历史记录索引', '00:43', 'storage'],
      ['整理任务面板文案', '01:09', 'desktop'],
      ['定位构建耗时增长', '01:26', 'build'],
      ['校验模型切换状态', '02:10', 'agents'],
      ['检查配置读取顺序', '02:05', 'desktop'],
      ['验证连接状态恢复', '03:04', 'relay'],
      ['核对回归用例清单', '01:32', 'test'],
      ['整理发布说明', '00:52', 'release'],
      ['检查新会话的初始状态', '00:08', 'desktop'],
    ].map(([title, time, project], index) => ({ ...examples[2], title, time, project, viaClaude: index % 3 === 0 })),
  ],
};

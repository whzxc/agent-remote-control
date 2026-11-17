import type { OriginStep } from '../components/task-card';

export const listOrigins: Record<'codex' | 'claudeToCodex', OriginStep[]> = {
  codex: [{ label: 'Codex', brand: 'codex' }],
  claudeToCodex: [{ label: 'Claude', brand: 'claude' }, { label: 'Codex', brand: 'codex' }],
};

export type ChildState = 'needs-input' | 'running' | 'complete';
export type Child = { name: string; assignment: string; latest: string; state: ChildState };
export type ListExample = {
  title: string; time: string; turns: number; viaClaude?: boolean; model: string; tier?: string; project: string;
  status: ChildState; excerpt?: string; preview: 'reply' | 'activity' | 'loading' | 'error' | 'empty';
  children?: Child[];
};

export const stateCopy = { 'needs-input': '等待输入', complete: '已完成' };
export const taskListClock = { title: '公示牌', date: '11月17日 · 周二', time: '11:35' };
export const examples: ListExample[] = [
  { title: '审阅队列测试覆盖范围', time: '04:18', turns: 2, viaClaude: true, model: 'gpt-6.2-astra', tier: 'ultrafast', project: 'queue', status: 'running',
    preview: 'activity', excerpt: '已汇总读取和调度用例，正在核对重试边界。', children: [
      { name: 'Curie', assignment: '核对重试上限', latest: '需要确认超时后允许的重试次数。', state: 'needs-input' },
      { name: 'Newton', assignment: '检查并发调度', latest: '正在比对同优先级任务的出队顺序。', state: 'running' },
      { name: 'Russell', assignment: '整理回归用例', latest: '已归类 12 个用例，剩余 3 个。', state: 'running' },
      { name: 'Poincare', assignment: '审阅读取路径', latest: '已有用例覆盖空队列和重复读取。', state: 'complete' },
    ] },
  { title: '定位构建耗时增长', time: '01:26', turns: 1, viaClaude: true, model: 'gpt-6.1-terra', project: 'build', status: 'running',
    preview: 'activity', excerpt: '正在对比最近两次构建的编译和链接耗时。' },
  { title: '验证安装后的升级流程', time: '03:10', turns: 3, model: 'gpt-6.2-sol', project: 'desktop', status: 'complete',
    preview: 'reply', excerpt: '安装和升级均已通过。重启后保留了已有配置，也能继续打开之前的会话。' },
  { title: '检查配置读取顺序', time: '02:05', turns: 1, model: 'gpt-6.2-sol', project: 'desktop', status: 'complete',
    preview: 'reply', excerpt: '项目配置会覆盖默认值。' },
  { title: '核对历史记录索引', time: '00:43', turns: 2, model: 'gpt-6.1-terra', project: 'storage', status: 'complete', preview: 'error' },
  { title: '检查新会话的初始状态', time: '00:08', turns: 1, model: 'gpt-6.2-sol', project: 'desktop', status: 'complete', preview: 'empty' },
];

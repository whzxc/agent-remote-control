export type ActivityPriority = 'attention' | 'running' | 'unread';
type SectionId = ActivityPriority | 'today' | 'yesterday' | 'earlier';
export interface ActivitySection<T> { id: string; date?: number; entries: T[] }

// Agent conversations and source dispatches share ordering, while each owner
// supplies its own runtime and read-state facts.
export function activitySections<T>(entries: readonly T[], now: number,
  timestamp: (entry: T) => number, priority: (entry: T) => ActivityPriority | undefined): ActivitySection<T>[] {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const yesterday = new Date(midnight); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(midnight); week.setDate(week.getDate() - (week.getDay() + 6) % 7);
  const groups = Object.fromEntries(['attention', 'running', 'unread', 'today', 'yesterday', 'earlier']
    .map(id => [id, { id, entries: [] as T[] }])) as Record<SectionId, ActivitySection<T>>;
  const dates = new Map<number, ActivitySection<T>>();
  for (const entry of entries) {
    const state = priority(entry), time = timestamp(entry);
    let group = state ? groups[state] : time >= midnight.getTime() ? groups.today
      : time >= yesterday.getTime() ? groups.yesterday : groups.earlier;
    if (group === groups.earlier && time >= week.getTime()) {
      const date = new Date(time); date.setHours(0, 0, 0, 0);
      const key = date.getTime();
      group = dates.get(key) ?? { id: `date:${key}`, date: key, entries: [] };
      dates.set(key, group);
    }
    group.entries.push(entry);
  }
  return [groups.attention, groups.running, groups.unread, groups.today, groups.yesterday,
    ...[...dates.values()].sort((a, b) => b.date! - a.date!), groups.earlier];
}

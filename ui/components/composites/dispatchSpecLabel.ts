import type { CatalogModel, DispatchCatalog } from '../../state/dispatchCatalog';
import type { DispatchSummary } from '../../types';

/** Match native identities exactly and retain recorded values when labels are absent. */
export function modelLabel(model: string, models: CatalogModel[] = []): string {
  const row = models.find(row => row.model === model);
  const label = row?.displayName || row?.name;
  // Upstream catalog labels may already carry a provider after the separator.
  return label?.split(/\s+·\s+/, 1)[0].trim() || model;
}

const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function effortLabel(value: string, translate: (key: string) => string) {
  return effortOrder.includes(value) ? translate(`dispatchSpec.effort.${value}`) : value;
}

export function orderedReasoningLevels(values: string[]) {
  const levels = [...new Set(values.filter(Boolean))];
  return levels.every(level => effortOrder.includes(level))
    ? levels.sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b))
    : levels;
}

function catalogModel(model: string | undefined, catalog: DispatchCatalog | undefined) {
  return Array.isArray(catalog?.models) ? catalog.models.find(row => row.model === model) : undefined;
}

function reasoningOptions(model: string | undefined, catalog: DispatchCatalog | undefined) {
  const options = catalogModel(model, catalog)?.options
    ?? (model && [catalog?.currentModel, catalog?.optionsForModel].includes(model) ? catalog?.options : undefined);
  return options?.filter(option => option.category === 'thought_level' || ['reasoning_effort', 'reasoningEffort', 'thinkingLevel', 'effort', 'thought_level'].includes(option.id))
    .flatMap(option => option.values ?? []) ?? [];
}

export function reasoningLevels(model: string | undefined, catalog: DispatchCatalog | undefined) {
  const efforts = catalogModel(model, catalog)?.efforts;
  return orderedReasoningLevels(efforts?.length ? efforts
    : reasoningOptions(model, catalog).map(option => typeof option === 'string' ? option : option.value));
}

export function effortPosition(levels: string[], value?: string) {
  const index = value ? levels.indexOf(value) : -1;
  return index >= 0 ? { count: levels.length, index } : undefined;
}

/** Native catalogs supply names, never replacements for recorded configuration. */
export function dispatchSpecParts(summary: DispatchSummary | undefined, catalog: DispatchCatalog | undefined, translate: (key: string) => string) {
  const model = summary?.model, effort = summary?.effort?.trim(), tier = summary?.serviceTier?.trim();
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const option = reasoningOptions(model, catalog).find(option => typeof option !== 'string' && option.value === effort);
  return {
    model: model ? modelLabel(model, models) : undefined,
    effort: typeof option === 'object' && option.name || (effort ? effortLabel(effort, translate) : undefined),
    tier: tier && tier !== 'default' ? (tier === 'fast' || tier === 'priority' ? translate('activity.fast') : tier) : undefined,
  };
}

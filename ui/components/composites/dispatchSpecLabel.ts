import type { CatalogModel, DispatchCatalog } from '../../state/dispatchCatalog';
import type { DispatchSummary } from '../../types';

/** Match native identities exactly and retain recorded values when labels are absent. */
export function modelLabel(model: string, models: CatalogModel[] = []): string {
  const row = models.find(row => row.model === model);
  const label = row?.displayName || row?.name;
  if (!label) return model;
  const ambiguous = models.some(other => other.model !== model && (other.displayName || other.name) === label && other.provider?.name !== row?.provider?.name);
  return ambiguous && row?.provider?.name ? `${label} · ${row.provider.name}` : label;
}

const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Native catalogs supply names, never replacements for recorded configuration. */
export function dispatchSpecParts(summary: DispatchSummary | undefined, catalog: DispatchCatalog | undefined, translate: (key: string) => string) {
  const model = summary?.model, effort = summary?.effort?.trim(), tier = summary?.serviceTier?.trim();
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const resolved = models.find(row => row.model === model);
  const options = resolved?.options ?? (model && [catalog?.currentModel, catalog?.optionsForModel].includes(model) ? catalog?.options : undefined);
  const option = options?.filter(option => option.category === 'thought_level' || ['reasoning_effort', 'reasoningEffort', 'thinkingLevel', 'effort', 'thought_level'].includes(option.id))
    .flatMap(option => option.values ?? []).find(option => typeof option !== 'string' && option.value === effort);
  return {
    model: model ? modelLabel(model, models) : undefined,
    effort: typeof option === 'object' && option.name || (effort && efforts.has(effort) ? translate(`dispatchSpec.effort.${effort}`) : effort),
    tier: tier && tier !== 'default' ? (tier === 'fast' || tier === 'priority' ? translate('activity.fast') : tier) : undefined,
  };
}

export function dispatchSpecLabel(summary: DispatchSummary | undefined, catalog: DispatchCatalog | undefined, translate: (key: string) => string): string {
  return Object.values(dispatchSpecParts(summary, catalog, translate)).filter(Boolean).join(' · ');
}

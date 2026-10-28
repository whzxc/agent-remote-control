import { t } from '../i18n';
import { controlSourcePlatform, sourcePlatforms } from '../controlSources';
import { connector } from '../state/connector';
import { navigation } from '../state/navigation';
import { isLocalSource, isPendingSource } from '../sourcePresentation';
import { Empty, Notice, SingleChoice } from './ui';
import ConnectorCard from './objects/ConnectorCard';
import SourceIcon from './SourceIcon';

export function PlatformConnectors({ platform }: { platform: string }) {
  const { sources, status, sourcesLoaded, error } = connector.use();
  const entries = sources.filter(source => !isLocalSource(source) && source.state !== 'revoked' && !isPendingSource(source, status?.ingresses ?? []) && controlSourcePlatform(source.product).id === platform);
  return <div className="flex min-w-0 flex-col gap-4">{error && <Notice>{error}</Notice>}{!sourcesLoaded ? <p role="status">{t('loading')}</p> : entries.length ? entries.map(source => <ConnectorCard key={source.id} source={source} />) : <Empty>{t('platforms.empty')}</Empty>}</div>;
}
export default function PlatformsPage() {
  const nav = navigation.use();
  const platform = sourcePlatforms.find(item => item.id === nav.platformId) ?? sourcePlatforms[0];
  return <div className="grid min-h-0 flex-1 grid-cols-3 gap-4">
    <nav className="min-h-0 overflow-y-auto" aria-label={t('platforms.title')}><SingleChoice navigation label={t('platforms.title')} value={platform.id} onChange={platformId => navigation.set(old => ({ ...old, platformId }))}
      options={sourcePlatforms.map(item => ({ value: item.id, label: item.id === 'custom' ? t('platforms.other') : item.displayName, graphic: <SourceIcon platform={item.id} /> }))} /></nav>
    <section className="col-span-2 min-h-0 overflow-y-auto" aria-label={platform.id === 'custom' ? t('platforms.other') : platform.displayName}><PlatformConnectors platform={platform.id} /></section>
  </div>;
}

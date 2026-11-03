import { readOnlyBrowser } from "../browserMode";
import PetPicker from '../pets/PetPicker';
import { Plus } from 'lucide-react';
import { t } from '../i18n';
import { controlSourcePlatform, controlSources, sourcePlatforms } from '../controlSources';
import { connector } from '../state/connector';
import { navigation } from '../state/navigation';
import { openOnboarding } from '../state/onboarding';
import { isLocalSource, isPendingSource } from '../sourcePresentation';
import { Button, Empty, Icon, Menu, Notice, SingleChoice } from './ui';
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
  const products = controlSources.filter(source => source.platform === platform.id && (source.curated || source.id === 'grok-bot' || source.id === 'custom'));
  const addButton = <Button disabled={readOnlyBrowser} data-platform-add onClick={products.length === 1 ? () => openOnboarding('connection', { source: products[0].id }) : undefined}><Icon icon={Plus} />{t('addControlSource')}</Button>;
  return <div className="grid min-h-0 flex-1 grid-cols-3 gap-4">
    <nav className="min-h-0 overflow-y-auto" aria-label={t('platforms.title')}><SingleChoice navigation label={t('platforms.title')} value={platform.id} onChange={platformId => navigation.set(old => ({ ...old, platformId }))}
      options={sourcePlatforms.map(item => ({ value: item.id, label: item.id === 'custom' ? t('platforms.other') : item.displayName, graphic: <SourceIcon platform={item.id} /> }))} /></nav>
    <section className="col-span-2 min-h-0 overflow-y-auto" aria-label={platform.id === 'custom' ? t('platforms.other') : platform.displayName}><header className="mb-4 flex items-center justify-between gap-3"><h2>{platform.id === 'custom' ? t('platforms.other') : platform.displayName}</h2><div className="flex items-center gap-2"><PetPicker scope={`platform:${platform.id}`} name={platform.displayName} />{products.length === 1 ? addButton : <Menu trigger={addButton} label={t('addControlSource')} items={products.map(product => ({ label: t('setup.addProduct', { name: product.displayName }), action: () => openOnboarding('connection', { source: product.id }) }))} />}</div></header><PlatformConnectors platform={platform.id} /></section>
  </div>;
}

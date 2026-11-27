import type { ReactNode } from 'react';
import { t } from '../i18n';
import { controlSourcePlatform } from '../controlSources';
import SourcePanelHeader from './composites/SourcePanelHeader';
import { PlatformConnectors } from './PlatformsPage';
import SourceIcon from './SourceIcon';
export default function SourcePlatformView({ platform, widthControl }: { platform: string; widthControl?: ReactNode; onBusy?: (busy: boolean) => void }) {
  const { id, displayName } = controlSourcePlatform(platform);
  return <>
    <SourcePanelHeader title={id === 'custom' ? t('platforms.other') : displayName} brand={<SourceIcon platform={platform} />}
      actions={widthControl} />
    <div className="side-panel-scroll source-panel-content"><PlatformConnectors platform={id} /></div>
  </>;
}

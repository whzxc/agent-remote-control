import type { ReactNode } from 'react';
import { useI18n } from '../i18n/react';
import { controlSourcePlatform } from '../controlSources';
import SourcePanelHeader from './composites/SourcePanelHeader';
import { PlatformConnectors } from './PlatformsPage';
import SourceIcon from './SourceIcon';

export default function SourcePlatformView({ platform, widthControl }: {
  platform: string; widthControl?: ReactNode; onBusy?: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const { id, displayName } = controlSourcePlatform(platform);
  return (
    <>
      <SourcePanelHeader
        title={id === 'custom' ? t('platforms.other') : displayName}
        brand={<SourceIcon platform={platform} />}
        actions={widthControl}
      />
      <div className="side-panel-scroll source-panel-content flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <PlatformConnectors platform={id} />
      </div>
    </>
  );
}

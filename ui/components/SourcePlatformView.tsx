import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { controlSourcePlatform } from '../controlSources';
import { DialogClose, IconButton } from './ui';
import { PlatformConnectors } from './PlatformsPage';
import SourceIcon from './SourceIcon';
export default function SourcePlatformView({ platform, widthControl }: { platform: string; widthControl?: ReactNode; onBusy?: (busy: boolean) => void }) {
  return <><header className="dialog-header source-account-header"><div className="source-account-brand"><SourceIcon platform={platform} /></div><div className="source-account-heading"><h2>{controlSourcePlatform(platform).id === 'custom' ? t('platforms.other') : controlSourcePlatform(platform).displayName}</h2></div><div className="actions">{widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose></div></header><div className="side-panel-scroll source-panel-content"><PlatformConnectors platform={controlSourcePlatform(platform).id} /></div></>;
}

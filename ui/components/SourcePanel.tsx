import type { ReactNode } from 'react';
import { controlSourcePlatform } from '../controlSources';
import { isLocalSource } from '../sourcePresentation';
import { navigation } from '../state/navigation';
import { selectSourcePlatform } from '../state/overviewPanels';
import type { ControlSource } from '../state/types';
import { Button } from './ui';
import SourcePanelHeader from './composites/SourcePanelHeader';
import SourceDispatches from './SourceDispatches';
import SourceIcon from './SourceIcon';
export default function SourcePanel({ source, widthControl }: { source: ControlSource; widthControl?: ReactNode }) {
  if (isLocalSource(source)) return null;
  const platform = controlSourcePlatform(source.product);
  const label = source.label;
  return <>
    <SourcePanelHeader title={label}
      brand={<Button variant="link" aria-label={platform.displayName} onClick={() => { selectSourcePlatform(platform.id); navigation.set(old => ({ ...old, page: 'overview', remoteSourceId: undefined })); }}><SourceIcon platform={platform.id} /></Button>}
      actions={widthControl} />
    <div className="agent-view-scroll"><SourceDispatches sourceId={source.id} /></div>
  </>;
}

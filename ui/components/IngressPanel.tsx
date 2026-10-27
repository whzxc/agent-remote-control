import { ContextSettings } from './composites/ContextSettings';
import { t } from '../i18n';
import { sourceProductName } from '../controlSources';
import { ingressPanel, selectSourcePanel } from '../state/overviewPanels';
import type { SurfaceRect } from '../motion/surface';
import SourcePanel from './SourcePanel';
import { Dialog } from './ui';

export default function IngressPanel({ onPanelFrame, width, expanded, onToggleWidth, dockRect }: {
  onPanelFrame?: (rect: SurfaceRect | null) => void; width?: number; dockRect?: SurfaceRect; expanded: boolean; onToggleWidth: () => void;
}) {
  const selected = ingressPanel.use()!;
  return <Dialog width={width} dockRect={dockRect} dock="left" expanded={expanded} headerless title={sourceProductName(selected.product)}
    onBack={selected.accountId ? () => selectSourcePanel(selected.product, { platformOnly: true }) : undefined}
    originKey={`${selected.product}:${selected.client?.id ?? ""}`} closeRequested={selected.closing}
    onCloseStart={() => ingressPanel.set(old => old ? { ...old, closing: true } : old)}
    onClose={() => { if (ingressPanel.get()?.closing) ingressPanel.set(undefined); }}
    returnFocus={`[data-source-node="${CSS.escape(selected.client?.id ?? `platform:${selected.product}`)}"] button`} onPanelFrame={onPanelFrame}>
    <div className="flex h-full min-h-0 w-full flex-col">
      <SourcePanel product={selected.product} accountId={selected.accountId} widthControl={!dockRect && <ContextSettings label={t('context.panelWidth')} value={expanded ? 'wide' : 'normal'} options={[{ value: 'normal', label: t('context.normal') }, { value: 'wide', label: t('context.wide') }]} onChange={value => { if ((value === 'wide') !== expanded) onToggleWidth(); }} />} />
    </div>
  </Dialog>;
}

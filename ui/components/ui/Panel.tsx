import type { layerTrigger } from "../../state/layers";
import type { ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { t } from '../../i18n';
import { IconButton } from './index';
import type { LayerSide, LayerRect } from './layerFrame';
import { LayerShell, DialogActions, type DialogProps } from './Dialog';
export { usePanelState, LayerHeader as PanelHeader } from './Dialog';

export type PanelProps = Omit<DialogProps, 'size'> & {
  size: 'm' | 'l' | 'xl'; side?: LayerSide; entryTrigger?: ReturnType<typeof layerTrigger>; labelledBy?: string; onPanelFrame?: (rect: LayerRect | null) => void; role?: 'dialog' | 'region'; expanded?: boolean; onToggleWidth?: () => void;
  viewKey?: string; headerNavigation?: ReactNode; onEscapeKeyDown?: (event: KeyboardEvent) => void;
};
/** Shared nonmodal shell for center workspaces and mirrored node slots. */
export default function Panel({ onToggleWidth, expanded, actions, ...props }: PanelProps) {
  return <LayerShell {...props} kind="panel" closeLabel={props.role === "region" ? t("backToHome") : undefined} expanded={expanded} actions={<>{actions}{onToggleWidth &&
    <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? 'restorePanelWidth' : 'expandPanelWidth')}
      aria-pressed={!!expanded} onClick={onToggleWidth} />}</>} />;
}
export function PanelFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <DialogActions className={`panel-footer-content ${className ?? ""}`}>{children}</DialogActions>;
}

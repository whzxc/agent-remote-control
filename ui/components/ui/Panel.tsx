import type { ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { t } from '../../i18n';
import { IconButton } from './index';
import { LayerShell, DialogActions, type DialogProps } from './Dialog';
export { usePanelState } from './Dialog';

export type PanelProps = Omit<DialogProps, 'size'> & {
  size: 'l' | 'xl'; role?: 'dialog' | 'region'; expanded?: boolean; onToggleWidth?: () => void;
  viewKey?: string; headerNavigation?: ReactNode; onEscapeKeyDown?: (event: KeyboardEvent) => void;
};
/** Nonmodal center workspace; node docks retain ElasticPanel until their migration. */
export default function Panel({ onToggleWidth, expanded, actions, ...props }: PanelProps) {
  return <LayerShell {...props} kind="panel" closeLabel={props.role === "region" ? t("backToHome") : undefined} expanded={expanded} actions={<>{actions}{onToggleWidth &&
    <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? 'restorePanelWidth' : 'expandPanelWidth')}
      aria-pressed={!!expanded} onClick={onToggleWidth} />}</>} />;
}
export function PanelFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <DialogActions className={`panel-footer-content ${className ?? ""}`}>{children}</DialogActions>;
}

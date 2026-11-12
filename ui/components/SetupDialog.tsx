import type { ReactNode } from "react";
import { t } from "../i18n";
import { Dialog } from "./ui";

export type SetupStep = { label: string; value?: string };
export default function SetupDialog({ layerId, title, steps, active, done, stacked, parentTitle, busy, dirty, onCancel, onClose, footer, children, initialFocus, returnFocus, context, actionLayout = "split" }: {
  layerId?: string;
  title: string; steps: SetupStep[]; active: number; done?: boolean; stacked?: boolean; parentTitle?: string;
  context?: ReactNode; actionLayout?: "split" | "end";
  dirty?: boolean; onCancel?: () => void | boolean | Promise<void | boolean>;
  busy?: boolean; onClose: () => void | Promise<void>; footer?: ReactNode; children: ReactNode; initialFocus?: string; returnFocus?: string;
}) {
  return <Dialog layerId={layerId} title={title} busy={busy} dirty={dirty} onCancel={onCancel} onClose={onClose} initialFocus={initialFocus} returnFocus={returnFocus ?? ".hub-source"}
    headerDetail={(stacked || context) && <p className={stacked ? "setup-return" : "setup-context"}>{stacked ? t("setup.returns", { name: parentTitle ?? t("addControlSource") }) : context}</p>}
    stepBar={<ol className="setup-steps" aria-label={title} data-done={done || undefined}>{steps.map((step, index) => <li key={index}
      data-complete={index < active || done || undefined} aria-current={index === active && !done ? "step" : undefined}>
      <span>{step.label}{index < active && step.value ? ` · ${step.value}` : ""}</span>
    </li>)}</ol>} footer={footer && <div className="setup-actions" data-layout={actionLayout}>{footer}</div>}>{children}</Dialog>;
}

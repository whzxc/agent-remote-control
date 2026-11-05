import type { ReactNode } from "react";
import { t } from "../i18n";
import { Dialog } from "./ui";

export type SetupStep = { label: string; value?: string };
export default function SetupDialog({ title, steps, active, done, stacked, parentTitle, busy, onClose, footer, children, initialFocus, returnFocus, context, actionLayout = "split" }: {
  title: string; steps: SetupStep[]; active: number; done?: boolean; stacked?: boolean; parentTitle?: string;
  context?: ReactNode; actionLayout?: "split" | "end";
  busy?: boolean; onClose: () => void | Promise<void>; footer?: ReactNode; children: ReactNode; initialFocus?: string; returnFocus?: string;
}) {
  return <Dialog centered width={680} title={title} busy={busy} onClose={onClose} initialFocus={initialFocus} returnFocus={returnFocus ?? ".hub-source"}
    headerDetail={(stacked || context) && <p className={stacked ? "setup-return" : "setup-context"}>{stacked ? t("setup.returns", { name: parentTitle ?? t("addControlSource") }) : context}</p>}
    stepBar={<ol className="setup-steps" aria-label={title} data-done={done || undefined}>{steps.map((step, index) => <li key={index}
      data-complete={index < active || done || undefined} aria-current={index === active && !done ? "step" : undefined}>
      <span>{step.label}{index < active && step.value ? ` · ${step.value}` : ""}</span>
    </li>)}</ol>} footer={footer && <div className="setup-actions" data-layout={actionLayout}>{footer}</div>}>{children}</Dialog>;
}

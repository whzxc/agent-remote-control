import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "./index";

/** The navigation instance of setup-choice/row; it does not select a radio value. */
export function SetupAction({ icon, label, description, badge, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: LucideIcon; label: string; description?: string; badge?: string;
}) {
  return <button type="button" {...props} className="setup-choice-action" data-description={!!description || undefined}>
    <Icon icon={icon} /><span><strong>{label}</strong>{description && <small>{description}</small>}</span>{badge && <span className="setup-choice-badge">{badge}</span>}
  </button>;
}

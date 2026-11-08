import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { Button, Icon, Tile } from "./index";

/** The navigation instance of setup-choice/setup-choice-row; it does not select a radio value. */
export function SetupAction({ icon, label, description, badge, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: LucideIcon; label: string; description?: string; badge?: string;
}) {
  return <button type="button" {...props} className="setup-choice-action" data-description={!!description || undefined}>
    <Icon icon={icon} /><span><strong>{label}</strong>{description && <small>{description}</small>}</span>{badge && <span className="setup-choice-badge">{badge}</span>}
  </button>;
}

/** The welcome action composes the approved card and tinted tile forms. */
export function WelcomeChoice({ icon, title, description, meta, tone, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> & {
  icon: LucideIcon; title: string; description: string; meta: string; tone: "command" | "accent";
}) {
  return <button type="button" {...props} className="welcome-choice" data-tone={tone}>
    <Tile icon={icon} /><strong>{title}</strong><span>{description}</span><small>{meta}</small>
  </button>;
}

export function WelcomeStatusAction(props: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <Button {...props} variant="link" className="welcome-status-link" />;
}

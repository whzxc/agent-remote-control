import './WelcomeChoice.css';
import type { ButtonHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { Button, Icon } from "../ui/index";
export function WelcomeChoice({ icon, title, description, meta, tone, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> & {
  icon: LucideIcon; title: string; description: string; meta: string; tone: "command" | "accent";
}) {
  return <button type="button" {...props} className="welcome-choice" data-tone={tone}>
    <span className="tile" aria-hidden="true"><Icon icon={icon} size={18} /></span><strong>{title}</strong><span>{description}</span><small>{meta}</small>
  </button>;
}

export function WelcomeStatusAction(props: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <Button {...props} variant="link" className="welcome-status-link" />;
}

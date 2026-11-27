import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Alert } from "../kit/alert";
import { Button } from "../kit/button";
import { cn } from "../kit/utils";

export interface WelcomeChoiceCardProps {
  icon: LucideIcon;
  tone: "command" | "accent";
  title: string;
  description: string;
  meta: string;
  onClick?: () => void;
  className?: string;
}

export function WelcomeChoiceCard({
  icon: IconComponent,
  tone,
  title,
  description,
  meta,
  onClick,
  className,
}: WelcomeChoiceCardProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 cursor-pointer flex-col items-start rounded-kit-card border border-border bg-surface p-4 text-left text-foreground outline-none hover:border-border-strong hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-tile",
          tone === "command"
            ? "bg-phase-command/12 text-phase-command"
            : "bg-accent/12 text-accent",
        )}
      >
        <IconComponent size={18} strokeWidth={1.75} absoluteStrokeWidth />
      </span>
      <strong className="mt-3.5 text-body leading-5 font-semibold text-foreground">
        {title}
      </strong>
      <span className="mt-1.5 text-small leading-4 text-text-secondary">
        {description}
      </span>
      <small className="mt-4 text-meta leading-4 text-text-tertiary tabular-nums">
        {meta}
      </small>
    </button>
  );
}

export interface WelcomeStatusBarProps {
  ready: boolean;
  statusContent: ReactNode;
  inviteLabel: string;
  onInvite?: () => void;
  className?: string;
}

export function WelcomeStatusBar({
  ready,
  statusContent,
  inviteLabel,
  onInvite,
  className,
}: WelcomeStatusBarProps): ReactElement {
  return (
    <footer
      className={cn(
        "flex w-full flex-wrap items-center justify-between gap-3",
        className,
      )}
    >
      <div className="inline-flex min-w-0 items-center gap-2 text-small font-medium text-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            ready ? "bg-success" : "bg-warning",
          )}
        />
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {statusContent}
        </span>
      </div>
      <Button variant="ghost" onClick={onInvite}>
        {inviteLabel}
      </Button>
    </footer>
  );
}

export interface WelcomeViewProps {
  mark: ReactNode;
  title: string;
  titleId?: string;
  error?: string;
  choices: readonly (WelcomeChoiceCardProps & { id: string })[];
  status: WelcomeStatusBarProps;
  className?: string;
}

export function WelcomeView({
  mark,
  title,
  titleId,
  error,
  choices,
  status,
  className,
}: WelcomeViewProps): ReactElement {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-7 text-foreground",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="flex size-16 items-center justify-center">{mark}</span>
        <h1
          id={titleId}
          className="m-0! text-title leading-6 font-semibold text-foreground"
        >
          {title}
        </h1>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid w-full grid-cols-2 gap-4 max-[540px]:grid-cols-1">
        {choices.map(({ id, ...choice }) => (
          <WelcomeChoiceCard key={id} {...choice} />
        ))}
      </div>
      <WelcomeStatusBar {...status} className="pt-1" />
    </div>
  );
}

import type { ReactNode } from "react";
import { Frame, Icon } from "adg";
import { Button as KitButton, cn } from "@/components/kit";
import { buttonForms } from "../fixtures/buttons";

export type ButtonProps = {
  variant?:
    "primary" | "secondary" | "ghost" | "link" | "danger" | "danger-outline";
  busy?: boolean;
  presentation?: "record-link";
  anchor?: string;
  disabled?: boolean;
  icon?: string;
  children?: ReactNode;
  className?: string;
};

export function Button({
  variant = "secondary",
  presentation,
  busy = false,
  anchor,
  disabled,
  icon,
  children,
  className: extra = "",
}: ButtonProps) {
  return (
    <KitButton
      variant={variant}
      busy={busy}
      disabled={disabled}
      data-adg-id={anchor}
      className={cn(
        presentation === "record-link" && "text-accent! text-meta!",
        extra,
      )}
    >
      {!busy && icon && (
        <Icon name={icon} className="size-(--control-icon-size)" />
      )}
      {children}
    </KitButton>
  );
}

export default () =>
  buttonForms.map(({ name, text, ...props }) => (
    <Frame key={name} name={name}>
      <Button {...props}>{text}</Button>
    </Frame>
  ));

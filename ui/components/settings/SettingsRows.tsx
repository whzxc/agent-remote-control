import {
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { Card } from "../kit/card";
import { cn } from "../kit/utils";

/** Vertical stack for grouped settings sections. */
export function SettingsStack({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className={cn(
        "settings-stack flex! min-w-0 flex-col! gap-5!",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Section header + crisp 1px-bordered card with hairline row dividers. */
export function SettingsSection({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <section
      data-slot="settings-section"
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {title && (
        <h2 className="m-0 text-meta font-semibold leading-4 text-text-secondary">
          {title}
        </h2>
      )}
      <Card className="gap-0 divide-y divide-border overflow-hidden p-0">
        {children}
      </Card>
    </section>
  );
}

/** Structured settings row preserving `.setting` / `.setting-copy` / `.setting-control` hooks. */
export function Setting({
  title,
  description,
  children,
  width,
  toggle = false,
  htmlFor,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  width?: number | "auto";
  toggle?: boolean;
  htmlFor?: string;
  className?: string;
}): ReactElement {
  const generatedId = useId();
  const descriptionId = description ? `${generatedId}-description` : undefined;
  const controlId = htmlFor ?? (toggle ? generatedId : undefined);
  const control =
    toggle && isValidElement(children)
      ? cloneElement(
          children as ReactElement<{
            id?: string;
            "aria-describedby"?: string;
          }>,
          {
            id: (children.props as { id?: string }).id ?? controlId,
            "aria-describedby":
              (children.props as { "aria-describedby"?: string })[
                "aria-describedby"
              ] ?? descriptionId,
          },
        )
      : children;

  return (
    <div
      className={cn(
        "setting flex min-w-0 items-center justify-between gap-4! px-4!",
        description ? "min-h-13! py-3!" : "min-h-11! py-2!",
        className,
      )}
    >
      <div className="setting-copy flex min-w-0 flex-1 flex-col gap-0.5">
        <label
          htmlFor={controlId}
          className="block text-small! font-medium! leading-5! text-foreground"
        >
          {title}
        </label>
        {description && (
          <p
            id={descriptionId}
            className="m-0! whitespace-pre-line text-meta! leading-4! text-text-secondary"
          >
            {description}
          </p>
        )}
      </div>
      <div
        className={cn(
          "setting-control flex min-w-0 items-center justify-end",
          toggle ? "flex-none!" : "flex-initial! max-w-[60%]!",
        )}
        style={
          !toggle && width !== undefined && width !== "auto"
            ? { width }
            : undefined
        }
      >
        {control}
      </div>
    </div>
  );
}

/** Content-sized single-line row inside a card. */
export function SettingLine({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactElement {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div
      data-slot="setting-line"
      className={cn(
        "flex min-w-0 items-center justify-between gap-4 px-4",
        description ? "min-h-13 py-3" : "min-h-11 py-2.5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label
          htmlFor={id}
          className="text-small font-medium leading-5 text-foreground"
        >
          {title}
        </label>
        {description && (
          <p
            id={descriptionId}
            className="m-0 text-meta leading-4 text-text-secondary"
          >
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {isValidElement(children)
          ? cloneElement(
              children as ReactElement<{
                id?: string;
                "aria-describedby"?: string;
              }>,
              {
                id: (children.props as { id?: string }).id ?? id,
                "aria-describedby":
                  (children.props as { "aria-describedby"?: string })[
                    "aria-describedby"
                  ] ?? descriptionId,
              },
            )
          : children}
      </div>
    </div>
  );
}

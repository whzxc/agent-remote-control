import { useCopyState } from "./useCopyState";
import { Sensitive, useSensitiveText } from "../Sensitive";
import { maskSensitive } from "../../privacyMask";
import {
  createContext,
  isValidElement,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  LoaderCircle,
  Search,
  type LucideIcon,
} from "lucide-react";
import { t } from "../../i18n";
import { Alert as KitAlert } from "../kit/alert";
import { Button as KitButton } from "../kit/button";
import { CheckboxPrimitive } from "../kit/checkbox";
import { Empty as KitEmpty } from "../kit/empty";
import { Field as KitField } from "../kit/field";
import { InputPrimitive } from "../kit/input";
import { MenuPrimitive } from "../kit/menu";
import { consumeOutsidePointerGesture } from "../kit/outside-pointer";
import { RadioGroupPrimitive, RadioPrimitive } from "../kit/radio-group";
import { SelectPrimitive } from "../kit/select";
import { Loading as KitLoading } from "../kit/spinner";
import { SwitchPrimitive } from "../kit/switch";
import {
  TooltipPrimitive,
  TooltipProvider as KitTooltipProvider,
} from "../kit/tooltip";
import { cn } from "../kit/utils";
import { HoverScope } from "./HoverScope";
import ChoiceTrigger from "./ChoiceTrigger";

export { HoverScope };
export { SetupAction } from "./SetupChoice";
export { LoadingIndicator } from "./Feedback";

export type IconSize = 10 | 11 | 12 | 13 | 14 | 16 | 18 | 20 | 24 | 26 | 28 | 32;

export function Icon({
  icon: Component,
  size = 16,
  className = "",
}: {
  icon: LucideIcon;
  size?: IconSize;
  className?: string;
}) {
  return (
    <Component
      size={size}
      strokeWidth={1.75}
      absoluteStrokeWidth
      aria-hidden="true"
      className={`icon ${className}`}
    />
  );
}

/** Bundled brand artwork with no control or quota decoration. */
export function BrandMark({
  markup,
  size = 40,
}: {
  markup?: string;
  size?: number;
}) {
  return (
    <span
      className="brand-mark"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {markup ? (
        <span dangerouslySetInnerHTML={{ __html: markup }} />
      ) : (
        <Icon icon={Bot} size={20} />
      )}
    </span>
  );
}

export function Button({
  variant = "secondary",
  presentation,
  busy = false,
  children,
  className = "",
  disabled,
  title,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?:
    | "primary"
    | "secondary"
    | "ghost"
    | "link"
    | "danger"
    | "danger-outline";
  busy?: boolean;
  presentation?: "record-link";
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip text={title}>
      <KitButton
        type="button"
        {...props}
        variant={variant}
        busy={busy}
        disabled={disabled || busy}
        data-presentation={presentation}
        aria-busy={busy || props["aria-busy"]}
        className={cn("button", variant, busy && "pending", className)}
      >
        {children}
      </KitButton>
    </Tooltip>
  );
}

export function IconButton({
  icon,
  label,
  busy = false,
  size = 16,
  compact = false,
  filled = false,
  className = "",
  ...props
}: Omit<Parameters<typeof Button>[0], "children" | "title"> & {
  icon: LucideIcon;
  label: string;
  size?: IconSize;
  compact?: boolean;
  filled?: boolean;
}) {
  return (
    <Button
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      aria-label={label}
      className={cn(
        "icon-button",
        compact && "compact",
        filled && "filled",
        className,
      )}
    >
      <Icon
        icon={busy ? LoaderCircle : icon}
        size={size}
        className={busy ? "spin" : ""}
      />
    </Button>
  );
}

export function Input({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <InputPrimitive {...props} className={cn("input", className)} />;
}

/** A rounded search field with a leading icon. The placeholder doubles as the accessible name. */
export function SearchInput({
  className = "",
  placeholder,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { placeholder: string }) {
  return (
    <label className={cn("search", className)}>
      <Icon icon={Search} size={14} />
      <InputPrimitive
        type="search"
        {...props}
        placeholder={placeholder}
        aria-label={props["aria-label"] ?? placeholder}
        className="input"
      />
    </label>
  );
}

export function Field({
  id,
  label,
  error,
  help,
  helpPlacement = "end",
  compact = false,
  children,
}: {
  id?: string;
  label: ReactNode;
  error?: string;
  help?: ReactNode;
  helpPlacement?: "end" | "label";
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <KitField
      id={id}
      label={label}
      error={error}
      help={help}
      helpPlacement={helpPlacement}
      compact={compact}
      className="field"
    >
      {children}
    </KitField>
  );
}

/** A tinted message. With `title`, the children become detail lines under it. */
export function Notice({
  children,
  title,
  tone = "danger",
  action,
  actionBelow = false,
  layout,
  compact = false,
  elevated = false,
}: {
  children: ReactNode;
  title?: ReactNode;
  layout?: "inline" | "stacked";
  tone?: "danger" | "warning" | "success";
  action?: ReactNode;
  actionBelow?: boolean;
  compact?: boolean;
  elevated?: boolean;
}) {
  const protect = useSensitiveText();
  const body = typeof children === "string" ? protect(children) : children;
  return (
    <KitAlert
      tone={tone}
      title={title}
      action={action}
      actionBelow={actionBelow}
      layout={layout}
      compact={compact}
      elevated={elevated}
      className={cn(
        "notice",
        layout && `notice-${layout}`,
        tone,
        actionBelow && "notice-action-below",
      )}
    >
      {body}
    </KitAlert>
  );
}

export function Empty({
  children,
  action,
  icon,
  inset = true,
}: {
  children: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  inset?: boolean;
}) {
  return (
    <KitEmpty
      icon={icon}
      action={action}
      inset={inset}
      className={cn("empty", !inset && "empty-flush")}
    >
      {children}
    </KitEmpty>
  );
}

export function Loading({ label = t("loading") }: { label?: string }) {
  return <KitLoading label={label} className="loading" />;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
  "aria-describedby": describedBy,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
}) {
  const state = checked ? "checked" : "unchecked";
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={(next) => onChange(next)}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      data-state={state}
      className="switch"
    >
      <SwitchPrimitive.Thumb data-state={state} className="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean | "indeterminate";
  onChange: (value: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const labelId = useId();
  const indeterminate = checked === "indeterminate";
  const state = indeterminate
    ? "indeterminate"
    : checked
      ? "checked"
      : "unchecked";
  return (
    <div className="checkbox-label">
      <CheckboxPrimitive.Root
        id={id}
        aria-labelledby={labelId}
        checked={checked === true}
        indeterminate={indeterminate}
        onCheckedChange={(next) => onChange(next)}
        disabled={disabled}
        data-state={state}
        className="checkbox"
      >
        <CheckboxPrimitive.Indicator>
          {indeterminate ? "−" : <Icon icon={Check} />}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label
        id={labelId}
        htmlFor={id}
        className="min-w-0 cursor-pointer wrap-anywhere"
      >
        {children}
      </label>
    </div>
  );
}

export type Choice = {
  value: string;
  label: string;
  icon?: LucideIcon;
  graphic?: ReactNode;
  color?: string;
  description?: string;
  warning?: string;
  disabled?: boolean;
};

export function SingleChoice({
  value,
  onChange,
  options,
  label,
  disabled,
  swatches = false,
  fill = false,
  iconOnly = false,
  compact = false,
  cards = false,
  optionCards = false,
  dropdown = false,
  menuLabel,
  position = "popper",
  side = "bottom",
  navigation = false,
  tabs = false,
  tiles = false,
  form,
  secondaryFrom,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly Choice[];
  label: string;
  disabled?: boolean;
  swatches?: boolean;
  fill?: boolean;
  iconOnly?: boolean;
  compact?: boolean;
  cards?: boolean;
  optionCards?: boolean;
  dropdown?: boolean;
  menuLabel?: string;
  position?: "popper" | "item-aligned";
  side?: "bottom" | "right";
  navigation?: boolean;
  tabs?: boolean;
  tiles?: boolean;
  form?: "setup-row" | "setup-product" | "equal-pills" | "content-pills";
  secondaryFrom?: number;
}) {
  cards ||= form === "setup-row";
  tiles ||= form === "setup-product";
  const container = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [fits, setFits] = useState(false);
  const [contentWidth, setContentWidth] = useState<number>();
  const selectedOption = options.find((option) => option.value === value);

  useLayoutEffect(() => {
    const check = () => {
      setContentWidth(measure.current?.scrollWidth);
      setFits(
        !!container.current &&
          !!measure.current &&
          measure.current.scrollWidth <= container.current.clientWidth,
      );
    };
    check();
    const observer = new ResizeObserver(check);
    if (container.current) observer.observe(container.current);
    if (measure.current) observer.observe(measure.current);
    return () => observer.disconnect();
  }, [options, iconOnly, swatches, tabs, form, value]);

  return (
    <div
      ref={container}
      data-form={form}
      data-secondary-from={secondaryFrom}
      style={
        compact
          ? { width: dropdown ? "max-content" : contentWidth }
          : undefined
      }
      className={`choice ${fill ? "choice-fill" : ""} ${swatches ? "choice-swatches" : ""} ${cards ? "choice-cards" : ""} ${optionCards ? "choice-option-cards" : ""} ${dropdown ? "choice-dropdown" : ""} ${navigation ? "choice-navigation" : ""} ${tabs ? "choice-tabs" : ""} ${tiles ? "choice-tiles" : ""}`}
    >
      {(swatches || tabs || options.length <= 5) && (
        <div
          className={`choice-measure ${iconOnly ? "choice-icon-only" : ""} ${swatches ? "choice-measure-swatches" : ""}`}
          aria-hidden="true"
        >
          <div ref={measure}>
            {options.map((option) => (
              <span
                key={option.value}
                data-selected={option.value === value || undefined}
              >
                {!swatches && (
                  <>
                    {option.graphic}
                    {option.icon && <Icon icon={option.icon} />}
                    {!iconOnly && option.label}
                  </>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
      {!dropdown &&
      (tiles ||
        navigation ||
        cards ||
        optionCards ||
        ((swatches || tabs || options.length <= 5) && fits)) ? (
        <RadioGroupPrimitive
          value={value}
          onValueChange={(next) => {
            if (typeof next === "string") onChange(next);
          }}
          disabled={disabled}
          aria-label={label}
          aria-orientation={
            cards || optionCards || navigation ? "vertical" : "horizontal"
          }
          className={`choice-radio ${tiles || navigation || cards || optionCards || swatches || tabs ? "" : "choice-pills"} ${iconOnly ? "choice-icon-only" : ""}`}
          style={
            tiles || navigation || cards || optionCards || swatches
              ? undefined
              : { width: fill ? "100%" : contentWidth }
          }
        >
          {options.map((option, index) => (
            <RadioPrimitive.Root
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              nativeButton
              render={<button type="button" value={option.value} />}
              className="choice-option"
              data-state={option.value === value ? "checked" : "unchecked"}
              data-secondary={
                (secondaryFrom !== undefined && index >= secondaryFrom) ||
                undefined
              }
              data-description={!!option.description || undefined}
              data-hover-target={navigation ? option.value : undefined}
              aria-label={option.label}
              title={
                iconOnly
                  ? option.label
                  : option.disabled
                    ? option.description
                    : undefined
              }
              style={
                option.color
                  ? ({ "--swatch": option.color } as CSSProperties)
                  : undefined
              }
            >
              {swatches ? (
                <span className="choice-swatch" aria-hidden="true" />
              ) : (
                <>
                  {option.graphic}
                  {option.icon && <Icon icon={option.icon} />}
                  {!iconOnly && (
                    <span data-label={tabs ? option.label : undefined}>
                      {option.label}
                      {(cards ||
                        optionCards ||
                        navigation ||
                        form === "setup-product") && (
                        <>
                          {option.description && (
                            <small>{option.description}</small>
                          )}
                          {option.warning && (
                            <small className="choice-warning">
                              {option.warning}
                            </small>
                          )}
                        </>
                      )}
                    </span>
                  )}
                </>
              )}
            </RadioPrimitive.Root>
          ))}
        </RadioGroupPrimitive>
      ) : menuLabel ? (
        <MenuPrimitive.Root
          open={open}
          onOpenChange={(next, details) => {
            if (!next && details.reason === "outside-press") {
              consumeOutsidePointerGesture(details.event);
            }
            setOpen(next);
          }}
        >
          <MenuPrimitive.Trigger
            onKeyDown={(event) => {
              if (!open && !disabled && event.key === "Enter") {
                event.preventDefault();
                setOpen(true);
              }
            }}
            render={
              <ChoiceTrigger
                aria-label={label}
                disabled={disabled}
                side={side}
              >
                {selectedOption?.label}
              </ChoiceTrigger>
            }
          />
          <MenuPrimitive.Portal>
            <MenuPrimitive.Positioner
              side={side}
              align="start"
              sideOffset={6}
              collisionPadding={12}
              className="z-[65] pointer-events-auto"
            >
              <MenuPrimitive.Popup
                className="select-content choice-labelled-menu"
                aria-label={menuLabel}
                style={{
                  maxHeight: "var(--available-height)",
                  overflowY: "auto",
                }}
              >
                <MenuPrimitive.Group>
                  <MenuPrimitive.GroupLabel className="choice-menu-label">
                    {menuLabel}
                  </MenuPrimitive.GroupLabel>
                  <MenuPrimitive.RadioGroup
                    value={value}
                    onValueChange={(next) => {
                      if (typeof next === "string") onChange(next);
                    }}
                  >
                    <HoverScope tracking="highlighted">
                      {options.map((option) => (
                        <MenuPrimitive.RadioItem
                          key={option.value}
                          value={option.value}
                          disabled={option.disabled}
                          closeOnClick
                          className="select-item"
                          data-state={
                            option.value === value ? "checked" : "unchecked"
                          }
                          data-hover-target={option.value}
                        >
                          <span>{option.label}</span>
                          <MenuPrimitive.RadioItemIndicator>
                            <Icon icon={Check} />
                          </MenuPrimitive.RadioItemIndicator>
                        </MenuPrimitive.RadioItem>
                      ))}
                    </HoverScope>
                  </MenuPrimitive.RadioGroup>
                </MenuPrimitive.Group>
              </MenuPrimitive.Popup>
            </MenuPrimitive.Positioner>
          </MenuPrimitive.Portal>
        </MenuPrimitive.Root>
      ) : (
        <SelectPrimitive.Root
          open={open}
          onOpenChange={(next, details) => {
            if (!next && details.reason === "outside-press") {
              consumeOutsidePointerGesture(details.event);
            }
            setOpen(next);
          }}
          value={value}
          onValueChange={(next) => {
            if (typeof next === "string") onChange(next);
          }}
          disabled={disabled}
        >
          <SelectPrimitive.Trigger
            className="select-trigger"
            aria-label={label}
            onKeyDown={(event) => {
              if (!open && !disabled && event.key === "Enter") {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            <SelectPrimitive.Value>
              {selectedOption?.label ?? value}
            </SelectPrimitive.Value>
            <SelectPrimitive.Icon>
              <Icon icon={side === "right" ? ChevronRight : ChevronDown} />
            </SelectPrimitive.Icon>
          </SelectPrimitive.Trigger>
          <SelectPrimitive.Portal>
            <SelectPrimitive.Positioner
              alignItemWithTrigger={position === "item-aligned"}
              side={side}
              align="start"
              sideOffset={6}
              collisionPadding={12}
              className="z-[65] pointer-events-auto"
            >
              <SelectPrimitive.Popup
                className="select-content"
                style={{
                  minWidth: "var(--anchor-width)",
                  maxHeight: "var(--available-height)",
                }}
              >
                <SelectPrimitive.ScrollUpArrow className="select-scroll">
                  <Icon icon={ChevronUp} />
                </SelectPrimitive.ScrollUpArrow>
                <SelectPrimitive.List>
                  <HoverScope tracking="highlighted">
                    {options.map((option) => (
                      <SelectPrimitive.Item
                        key={option.value}
                        value={option.value}
                        disabled={option.disabled}
                        className="select-item"
                        data-state={
                          option.value === value ? "checked" : "unchecked"
                        }
                        data-hover-target={option.value}
                      >
                        <SelectPrimitive.ItemText>
                          {option.label}
                        </SelectPrimitive.ItemText>
                        <SelectPrimitive.ItemIndicator>
                          <Icon icon={Check} />
                        </SelectPrimitive.ItemIndicator>
                      </SelectPrimitive.Item>
                    ))}
                  </HoverScope>
                </SelectPrimitive.List>
                <SelectPrimitive.ScrollDownArrow className="select-scroll">
                  <Icon icon={ChevronDown} />
                </SelectPrimitive.ScrollDownArrow>
              </SelectPrimitive.Popup>
            </SelectPrimitive.Positioner>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
      )}
    </div>
  );
}

export { DialogClose } from "./Dialog";
export { default as Dialog, DialogActions } from "./Dialog";

const TooltipContext = createContext(false);

export function Tooltip({
  text,
  children,
  side = "top",
  hoverOnly = false,
}: {
  text: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  hoverOnly?: boolean;
}) {
  const provided = useContext(TooltipContext);
  const protect = useSensitiveText();
  const [open, setOpen] = useState(false);
  const pointerHover = useRef(false);
  const dismiss = () => {
    pointerHover.current = false;
    setOpen(false);
  };
  if (!text) {
    return isValidElement(children) ? children : <>{children}</>;
  }
  const triggerNode = isValidElement(children) ? (
    (children as ReactElement<Record<string, unknown>>)
  ) : (
    <span>{children}</span>
  );
  const content = (
    <TooltipPrimitive.Root
      open={open}
      onOpenChange={(next, details) => {
        if (hoverOnly && next && (!pointerHover.current || details.reason !== "trigger-hover")) {
          return;
        }
        setOpen(next);
      }}
      disableHoverablePopup={hoverOnly}
    >
      <TooltipPrimitive.Trigger
        render={triggerNode}
        onPointerMoveCapture={
          hoverOnly
            ? (event) => {
                // A restored focus or a surface disappearing under a stationary
                // pointer is not a new hover. Require actual mouse movement.
                if (
                  event.pointerType === "mouse" &&
                  event.buttons === 0 &&
                  (event.movementX !== 0 || event.movementY !== 0)
                )
                  pointerHover.current = true;
              }
            : undefined
        }
        onPointerLeave={hoverOnly ? dismiss : undefined}
        onPointerDownCapture={hoverOnly ? dismiss : undefined}
        onClickCapture={hoverOnly ? dismiss : undefined}
        onBlur={hoverOnly ? dismiss : undefined}
      />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner
          side={side}
          sideOffset={6}
          collisionPadding={10}
          className="z-70 pointer-events-auto"
        >
          <TooltipPrimitive.Popup
            role="tooltip"
            className="tooltip"
            data-state={open ? "open" : "closed"}
          >
            {typeof text === "string" ? protect(text) : text}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
  return provided ? content : <TooltipProvider>{content}</TooltipProvider>;
}

export function TooltipProvider({
  delayDuration,
  delay,
  ...props
}: ComponentProps<typeof KitTooltipProvider> & { delayDuration?: number }) {
  return (
    <TooltipContext.Provider value={true}>
      <KitTooltipProvider delay={delay ?? delayDuration} {...props} />
    </TooltipContext.Provider>
  );
}

export function Menu({
  trigger,
  items,
  label,
}: {
  trigger: ReactNode;
  label: string;
  items: {
    label: string;
    action: () => void;
    disabled?: boolean;
    danger?: boolean;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const triggerNode = isValidElement(trigger) ? (
    (trigger as ReactElement<Record<string, unknown>>)
  ) : (
    <span>{trigger}</span>
  );
  return (
    <MenuPrimitive.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "outside-press") {
          consumeOutsidePointerGesture(details.event);
        }
        setOpen(next);
      }}
    >
      <MenuPrimitive.Trigger render={triggerNode} />
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          sideOffset={6}
          collisionPadding={12}
          className="z-[65] pointer-events-auto"
        >
          <MenuPrimitive.Popup className="menu" aria-label={label}>
            <HoverScope tracking="highlighted">
              {items.map((item, index) => (
                <MenuPrimitive.Item
                  key={index}
                  data-hover-target={item.danger ? undefined : String(index)}
                  className={`menu-item ${item.danger ? "danger" : ""}`}
                  disabled={item.disabled}
                  onClick={item.action}
                >
                  {item.label}
                </MenuPrimitive.Item>
              ))}
            </HoverScope>
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

export function CopyField({
  value,
  label,
  password = false,
  loading = false,
  placeholder = "",
}: {
  value: string;
  label: string;
  password?: boolean;
  loading?: boolean;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  const { copied, error, copy } = useCopyState();
  return (
    <div>
      <div className="copy-field">
        <div
          className="copy-value"
          role="textbox"
          aria-readonly="true"
          aria-label={label}
          aria-busy={loading}
          tabIndex={0}
          onCopy={(event) => {
            event.preventDefault();
            event.clipboardData.setData("text/plain", value);
          }}
        >
          {value ? (
            <Sensitive>
              {password && !visible ? maskSensitive(value, true) : value}
            </Sensitive>
          ) : (
            placeholder
          )}
        </div>
        {loading ? (
          <Icon icon={LoaderCircle} className="spin" />
        ) : (
          <>
            {password && (
              <IconButton
                icon={visible ? EyeOff : Eye}
                label={t(visible ? "hideSecret" : "showSecret")}
                onClick={() => setVisible(!visible)}
              />
            )}
            <IconButton
              icon={copied ? Check : Copy}
              label={t(copied ? "copied" : "copy")}
              disabled={!value}
              onClick={() => {
                void copy(value);
              }}
            />
          </>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {copied && (
        <span className="sr-only" role="status">
          {t("copied")}
        </span>
      )}
    </div>
  );
}

import "./TaskControls.css";
import "./SetupChoice.css";
import "./CopyField.css";

export { default as Panel } from "./Panel";

export { default as ConfirmDialog } from "./ConfirmDialog";

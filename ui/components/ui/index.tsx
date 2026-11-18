import { useCopyState } from "./useCopyState";
import { TransientLayer } from "./TransientLayer";
import { Sensitive, useSensitiveText } from "../Sensitive";
import { maskSensitive } from "../../privacyMask";
import { createContext, useContext, type ComponentProps, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode, type CSSProperties, type Ref } from "react";
import { Select as S, RadioGroup, Switch as Sw, Checkbox as C, Tooltip as T, DropdownMenu as M } from "radix-ui";
import { Bot, Check, ChevronDown, ChevronRight, ChevronUp, CircleAlert, LoaderCircle, Copy, Eye, Search, EyeOff, type LucideIcon } from "lucide-react";
import { t } from "../../i18n";
import { HoverScope } from "./HoverScope";
import ChoiceTrigger from "./ChoiceTrigger";
export { HoverScope };
export { SetupAction } from "./SetupChoice";
export { LoadingIndicator } from "./Feedback";
export type IconSize = 10 | 11 | 12 | 13 | 14 | 16 | 18 | 20 | 24 | 26 | 28 | 32;
/** A compact label. `spec` names a choice, `fact` states a property and `danger` flags a risk. */
export function Tag({ children, title, id, form = "spec", tone }: {
  children: ReactNode; title?: string; id?: string; form?: "spec" | "fact" | "danger" | "resource" | "status" | "claim" | "compact-status" | "workflow-status";
  tone?: "success" | "warning" | "danger" | "command";
}) {
  return <Tooltip text={title}><span id={id} className="tag" data-form={form} data-tone={tone}>{children}</span></Tooltip>;
}
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
/** A tinted square that carries an icon in the color of its parent's `color`. */
export function Tile({ icon, className = "", form = 'card', tone }: {
  icon: LucideIcon; className?: string; form?: 'card' | 'phase'; tone?: 'warning' | 'success' | 'neutral' | 'command' | 'file' | 'thinking' | 'danger' | 'accent';
}) {
  const colors = { danger: 'var(--danger)', accent: 'var(--accent)', warning: 'var(--warning)', success: 'var(--success)', neutral: 'var(--text-tertiary)', command: 'var(--phase-command)', file: 'var(--phase-file)', thinking: 'var(--phase-thinking)' };
  return <span className={`tile ${form === 'phase' ? 'tile-phase' : ''} ${className}`} style={tone ? { color: colors[tone] } : undefined} aria-hidden="true"><Icon icon={icon} size={form === 'phase' ? 16 : 18} /></span>;
}
/** Bundled brand artwork with no control or quota decoration. */
export function BrandMark({ markup, size = 40 }: { markup?: string; size?: number }) {
  return <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
    {markup ? <span dangerouslySetInnerHTML={{ __html: markup }} /> : <Icon icon={Bot} size={20} />}
  </span>;
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
  variant?: "primary" | "secondary" | "ghost" | "link" | "danger" | "danger-outline";
  busy?: boolean;
  presentation?: "record-link";
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip text={title}><button
      type="button"
      {...props}
      disabled={disabled || busy}
      data-presentation={presentation}
      aria-busy={busy || props["aria-busy"]}
      className={`button ${variant} ${busy ? "pending" : ""} ${className}`}
    >
      {busy && <Icon icon={LoaderCircle} className="spin" />}
      {children}
    </button></Tooltip>
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
      className={`icon-button ${compact ? "compact" : ""} ${filled ? "filled" : ""} ${className}`}
    >
      <Icon icon={busy ? LoaderCircle : icon} size={size} className={busy ? "spin" : ""} />
    </Button>
  );
}
export function Input({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={`input ${className}`} />;
}
/** A rounded search field with a leading icon. The placeholder doubles as the accessible name. */
export function SearchInput({ className = "", placeholder, ...props }: InputHTMLAttributes<HTMLInputElement> & { placeholder: string }) {
  return <label className={`search ${className}`}>
    <Icon icon={Search} size={14} />
    <input type="search" {...props} placeholder={placeholder} aria-label={props["aria-label"] ?? placeholder} className="input" />
  </label>;
}
export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`input ${className}`} />;
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
    <div className="field" data-compact={compact || undefined}>
      <div className="field-heading" data-help-placement={helpPlacement}>
        <label htmlFor={id}>{label}</label>
        {help}
      </div>
      {children}
      {error && (
        <p
          id={id ? `${id}-error` : undefined}
          className="field-error"
          role="alert"
        >
          <Icon icon={CircleAlert} size={14} />
          {error}
        </p>
      )}
    </div>
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
    <div
      className={`notice ${layout ? `notice-${layout}` : ""} ${tone} ${actionBelow ? "notice-action-below" : ""}`}
      data-compact={compact || undefined}
      data-elevated={elevated || undefined}
      role={tone === "danger" ? "alert" : "status"}
    >
      {title ? <div className="notice-copy"><strong>{title}</strong>{body}</div> : <span>{body}</span>}
      {action && (actionBelow ? <div className="notice-action">{action}</div> : action)}
    </div>
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
    <div className={`empty ${inset ? "" : "empty-flush"}`} role="status">
      {icon && <Tile icon={icon} />}
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading({ label = t("loading") }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Icon icon={LoaderCircle} className="spin" />
      {label}
    </div>
  );
}
export function Status({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "running" | "success" | "warning" | "danger";
}) {
  return (
    <span className={`status ${tone}`}>
      <span aria-hidden="true" className="status-dot" />
      {children}
    </span>
  );
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
  return (
    <Sw.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className="switch"
    >
      <Sw.Thumb className="switch-thumb" />
    </Sw.Root>
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
  return (
    <label className="checkbox-label" htmlFor={id}>
      <C.Root
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
        className="checkbox"
      >
        <C.Indicator>
          {checked === "indeterminate" ? "−" : <Icon icon={Check} />}
        </C.Indicator>
      </C.Root>
      <span>{children}</span>
    </label>
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
  const [fits, setFits] = useState(false);
  const [contentWidth, setContentWidth] = useState<number>();
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
      style={compact ? { width: dropdown ? "max-content" : contentWidth } : undefined}
      className={`choice ${fill ? "choice-fill" : ""} ${swatches ? "choice-swatches" : ""} ${cards ? "choice-cards" : ""} ${optionCards ? "choice-option-cards" : ""} ${dropdown ? "choice-dropdown" : ""} ${navigation ? "choice-navigation" : ""} ${tabs ? "choice-tabs" : ""} ${tiles ? "choice-tiles" : ""}`}
    >
      {(swatches || tabs || options.length <= 5) && (
        <div className={`choice-measure ${iconOnly ? "choice-icon-only" : ""} ${swatches ? "choice-measure-swatches" : ""}`} aria-hidden="true">
          <div ref={measure}>
            {options.map((option) => (
              <span key={option.value} data-selected={option.value === value || undefined}>
                {!swatches && <>{option.graphic}{option.icon && <Icon icon={option.icon} />}{!iconOnly && option.label}</>}
              </span>
            ))}
          </div>
        </div>
      )}
      {!dropdown && (tiles || navigation || cards || optionCards || ((swatches || tabs || options.length <= 5) && fits)) ? (
        <RadioGroup.Root
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          aria-label={label}
          orientation={cards || optionCards || navigation ? "vertical" : "horizontal"}
          className={`choice-radio ${tiles || navigation || cards || optionCards || swatches || tabs ? "" : "choice-pills"} ${iconOnly ? "choice-icon-only" : ""}`}
          style={tiles || navigation || cards || optionCards || swatches ? undefined : { width: fill ? "100%" : contentWidth }}
        >
          {options.map((option, index) => (
            <RadioGroup.Item
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              className="choice-option"
              data-secondary={secondaryFrom !== undefined && index >= secondaryFrom || undefined}
              data-description={!!option.description || undefined}
              data-hover-target={navigation ? option.value : undefined}
              aria-label={option.label}
              title={iconOnly ? option.label : option.disabled ? option.description : undefined}
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
                  {!iconOnly && <span data-label={tabs ? option.label : undefined}>{option.label}{(cards || optionCards || navigation || form === "setup-product") && <>{option.description && <small>{option.description}</small>}{option.warning && <small className="choice-warning">{option.warning}</small>}</>}</span>}
                </>
              )}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      ) : menuLabel ? (
        <M.Root>
          <M.Trigger asChild>
            <ChoiceTrigger aria-label={label} disabled={disabled} side={side}>{options.find(option => option.value === value)?.label}</ChoiceTrigger>
          </M.Trigger>
          <M.Portal>
            <TransientLayer><M.Content className="select-content choice-labelled-menu" aria-label={menuLabel}
              side={side} align="start" sideOffset={6} collisionPadding={12}
              style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)", overflowY: "auto" }}>
              <M.Label className="choice-menu-label">{menuLabel}</M.Label>
              <M.RadioGroup value={value} onValueChange={onChange}>
                <HoverScope tracking="highlighted">
                  {options.map(option => <M.RadioItem key={option.value} value={option.value} disabled={option.disabled}
                    className="select-item" data-hover-target={option.value}>
                    <span>{option.label}</span><M.ItemIndicator><Icon icon={Check} /></M.ItemIndicator>
                  </M.RadioItem>)}
                </HoverScope>
              </M.RadioGroup>
            </M.Content></TransientLayer>
          </M.Portal>
        </M.Root>
      ) : (
        <S.Root value={value} onValueChange={onChange} disabled={disabled}>
          <S.Trigger className="select-trigger" aria-label={label}>
            <S.Value />
            <S.Icon>
              <Icon icon={side === "right" ? ChevronRight : ChevronDown} />
            </S.Icon>
          </S.Trigger>
          <S.Portal>
            <TransientLayer><S.Content
              className="select-content"
              position={position}
              side={side}
              align="start"
              sideOffset={6}
              collisionPadding={12}
            >
              <S.ScrollUpButton className="select-scroll">
                <Icon icon={ChevronUp} />
              </S.ScrollUpButton>
              <S.Viewport>
                <HoverScope tracking="highlighted">
                {options.map((option) => (
                  <S.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className="select-item"
                    data-hover-target={option.value}
                  >
                    <S.ItemText>{option.label}</S.ItemText>
                    <S.ItemIndicator>
                      <Icon icon={Check} />
                    </S.ItemIndicator>
                  </S.Item>
                ))}
                </HoverScope>
              </S.Viewport>
              <S.ScrollDownButton className="select-scroll">
                <Icon icon={ChevronDown} />
              </S.ScrollDownButton>
            </S.Content></TransientLayer>
          </S.Portal>
        </S.Root>
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
  if (!text) return <>{children}</>;
  const content = (
    <T.Root
      open={hoverOnly ? open : undefined}
      onOpenChange={hoverOnly ? (next) => setOpen(next && pointerHover.current) : undefined}
      disableHoverableContent={hoverOnly}
    >
      <T.Trigger
        asChild
        onFocus={hoverOnly ? (event) => event.preventDefault() : undefined}
        onPointerMoveCapture={hoverOnly ? (event) => {
          // A restored focus or a surface disappearing under a stationary
          // pointer is not a new hover. Require actual mouse movement.
          if (event.pointerType === "mouse" && event.buttons === 0 &&
              (event.movementX !== 0 || event.movementY !== 0))
            pointerHover.current = true;
        } : undefined}
        onPointerLeave={hoverOnly ? dismiss : undefined}
        onPointerDownCapture={hoverOnly ? dismiss : undefined}
        onClickCapture={hoverOnly ? dismiss : undefined}
        onBlur={hoverOnly ? dismiss : undefined}
      >{children}</T.Trigger>
      <T.Portal>
        <TransientLayer><T.Content className="tooltip" side={side} sideOffset={6} collisionPadding={10}>
          {typeof text === "string" ? protect(text) : text}
        </T.Content></TransientLayer>
      </T.Portal>
    </T.Root>
  );
  return provided ? content : <TooltipProvider>{content}</TooltipProvider>;
}
export function TooltipProvider(props: ComponentProps<typeof T.Provider>) {
  return <TooltipContext.Provider value={true}><T.Provider {...props} /></TooltipContext.Provider>;
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
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <TransientLayer><M.Content
          className="menu"
          aria-label={label}
          sideOffset={6}
          collisionPadding={12}
        >
          <HoverScope tracking="highlighted">
          {items.map((item, index) => (
            <M.Item
              key={index}
              data-hover-target={item.danger ? undefined : String(index)}
              className={`menu-item ${item.danger ? "danger" : ""}`}
              disabled={item.disabled}
              onSelect={item.action}
            >
              {item.label}
            </M.Item>
          ))}
          </HoverScope>
        </M.Content></TransientLayer>
      </M.Portal>
    </M.Root>
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
        <div className="copy-value" role="textbox" aria-readonly="true" aria-label={label} aria-busy={loading} tabIndex={0}
          onCopy={event => { event.preventDefault(); event.clipboardData.setData('text/plain', value); }}>
          {value ? <Sensitive>{password && !visible ? maskSensitive(value, true) : value}</Sensitive> : placeholder}
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
              onClick={() => { void copy(value); }}
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

export { default as ConfirmDialog } from './ConfirmDialog';

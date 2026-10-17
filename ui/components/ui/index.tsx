import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type CSSProperties,
  type Ref,
} from "react";
import {
  Dialog as D,
  Select as S,
  RadioGroup,
  Switch as Sw,
  Checkbox as C,
  Tooltip as T,
  DropdownMenu as M,
  Progress as R,
} from "radix-ui";
import {
  X,
  Check,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Copy,
  Eye,
  EyeOff,
  type LucideIcon,
} from "lucide-react";
import { t } from "../../i18n";
import { copyText } from "../../platform";
import { HoverScope } from "./HoverScope";
export { HoverScope };
export { HoverPreviewGroup } from "./HoverPreviewGroup";
export { ErrorCallout, LoadingIndicator } from "./Feedback";
export { DataTable, Pagination } from "./DataTable";
export function Tag({ children, title }: { children: ReactNode; title?: string }) {
  return <span className="task-tag" title={title}>{children}</span>;
}
export function Icon({
  icon: Component,
  size = 16,
  className = "",
}: {
  icon: LucideIcon;
  size?: 16 | 20;
  className?: string;
}) {
  return (
    <Component
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      className={`icon ${className}`}
    />
  );
}
export function Button({
  variant = "secondary",
  busy = false,
  children,
  className = "",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || props["aria-busy"]}
      className={`button ${variant} ${className}`}
    >
      {busy && <Icon icon={LoaderCircle} className="spin" />}
      {children}
    </button>
  );
}
export function IconButton({
  icon,
  label,
  busy = false,
  size = 20,
  className = "",
  ...props
}: Omit<Parameters<typeof Button>[0], "children" | "title"> & {
  icon: LucideIcon;
  label: string;
  size?: 16 | 20;
}) {
  return (
    <Button
      variant="ghost"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      aria-label={label}
      className={`icon-button ${className}`}
    >
      <Icon icon={busy ? LoaderCircle : icon} size={size} className={busy ? "spin" : ""} />
    </Button>
  );
}
export function Input({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`input ${className}`} />;
}
export function Field({
  id,
  label,
  error,
  help,
  children,
}: {
  id?: string;
  label: ReactNode;
  error?: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-heading">
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
          {error}
        </p>
      )}
    </div>
  );
}
export function Notice({
  children,
  tone = "danger",
  action,
}: {
  children: ReactNode;
  tone?: "danger" | "warning" | "success";
  action?: ReactNode;
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <span>{children}</span>
      {action}
    </div>
  );
}
export function Empty({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty" role="status">
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
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return (
    <span className={`status ${tone}`}>
      <span aria-hidden="true" className="status-dot" />
      {children}
    </span>
  );
}
export function Group({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-group">
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  );
}
export function Row({
  title,
  description,
  children,
  controlId,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  controlId?: string;
}) {
  return (
    <div className="settings-row">
      <div className="row-copy">
        <label htmlFor={controlId}>{title}</label>
        {description && <p>{description}</p>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <Sw.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
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
  color?: string;
};
export function SingleChoice({
  value,
  onChange,
  options,
  label,
  disabled,
  swatches = false,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly Choice[];
  label: string;
  disabled?: boolean;
  swatches?: boolean;
  compact?: boolean;
}) {
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
  }, [options]);
  return (
    <div
      ref={container}
      style={compact ? { width: contentWidth } : undefined}
      className={`choice ${swatches ? "choice-swatches" : ""}`}
    >
      {!swatches && options.length <= 5 && (
        <div ref={measure} className="choice-measure" aria-hidden="true">
          {options.map((option) => (
            <span key={option.value}>
              {option.icon && <Icon icon={option.icon} />} {option.label}
            </span>
          ))}
        </div>
      )}
      {swatches || (options.length <= 5 && fits) ? (
        <RadioGroup.Root
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          aria-label={label}
          orientation="horizontal"
          className="choice-radio"
        >
          {options.map((option) => (
            <RadioGroup.Item
              key={option.value}
              value={option.value}
              className="choice-option"
              aria-label={option.label}
              style={
                option.color
                  ? ({ "--swatch": option.color } as CSSProperties)
                  : undefined
              }
            >
              {swatches ? (
                <Icon icon={Check} />
              ) : (
                <>
                  {option.icon && <Icon icon={option.icon} />}
                  <span>{option.label}</span>
                </>
              )}
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      ) : (
        <S.Root value={value} onValueChange={onChange} disabled={disabled}>
          <S.Trigger className="select-trigger" aria-label={label}>
            <S.Value />
            <S.Icon>
              <Icon icon={ChevronDown} />
            </S.Icon>
          </S.Trigger>
          <S.Portal>
            <S.Content
              className="select-content"
              position="popper"
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
            </S.Content>
          </S.Portal>
        </S.Root>
      )}
    </div>
  );
}
export function DetailDialog({ trigger, title, children }: { trigger: ReactNode; title: ReactNode; children: ReactNode }) {
  return <D.Root><D.Trigger asChild>{trigger}</D.Trigger><D.Portal>
    <D.Overlay className="detail-dialog-overlay" />
    <D.Content className="detail-dialog" aria-describedby={undefined}>
      <header><D.Title>{title}</D.Title><D.Close asChild><IconButton icon={X} label={t("close")} /></D.Close></header>
      <div className="detail-dialog-body"><div className="detail-dialog-content">{children}</div></div>
    </D.Content>
  </D.Portal></D.Root>;
}
export const DialogClose = D.Close;
export { default as Dialog } from "../ElasticPanel";
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
  const [open, setOpen] = useState(false);
  const pointerHover = useRef(false);
  const dismiss = () => {
    pointerHover.current = false;
    setOpen(false);
  };
  return (
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
        <T.Content className="tooltip" side={side} sideOffset={6} collisionPadding={10}>
          {text}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
export const TooltipProvider = T.Provider;
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
        <M.Content
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
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
export function Progress({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color?: string;
}) {
  return (
    <R.Root
      className="progress"
      value={Math.max(0, Math.min(100, value))}
      aria-label={label}
    >
      <R.Indicator
        style={{
          width: `${Math.max(0, Math.min(100, value))}%`,
          background: color,
        }}
      />
    </R.Root>
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
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div>
      <div className="copy-field">
        <Input
          aria-label={label}
          value={value}
          readOnly
          type={password && !visible ? "password" : "text"}
          placeholder={placeholder}
          aria-busy={loading}
          autoComplete="off"
        />
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
                setError("");
                void copyText(value)
                  .then(() => setCopied(true))
                  .catch(() =>
                    setError(t("copyFailedSelectAndCopyTheTextManually")),
                  );
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


import "./DetailDialog.css";

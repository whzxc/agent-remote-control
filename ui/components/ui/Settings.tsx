import { cloneElement, isValidElement, useId, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { DialogClose, IconButton, Input, Switch } from "./index";
import { X } from "lucide-react";
import { t } from "../../i18n";
import { Card } from "./card";
import Dialog from "../ElasticPanel";
import "./Settings.css";

/** Shared settings composition for the approved settings surface. */
export function SettingsSection({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return <section className="settings-section">
    {title && <h2>{title}</h2>}
    <Card className="settings-section-card">{children}</Card>
  </section>;
}
export function SettingsPair({ children }: { children: ReactNode }) {
  return <div className="settings-pair">{children}</div>;
}
export function Setting({ title, description, children, width = 300, toggle = false }: {
  title: ReactNode; description?: ReactNode; children: ReactNode; width?: number | "full"; toggle?: boolean;
}) {
  const id = useId();
  const labelled = isValidElement(children) && (children.type === Input || children.type === Switch);
  const control = labelled ? cloneElement(children as ReactElement<{ id?: string; "aria-describedby"?: string }>, {
    id, "aria-describedby": description ? `${id}-description` : undefined,
  }) : children;
  const copy = <div className="setting-copy">
    <label htmlFor={labelled ? id : undefined}>{title}</label>
    {description && <p id={`${id}-description`}>{description}</p>}
  </div>;
  return <div className={`setting ${toggle ? "setting-toggle" : "setting-field"}`}>
    {toggle && control}{copy}
    {!toggle && <div className="setting-control" style={{ width: width === "full" ? "100%" : width }}>{control}</div>}
  </div>;
}
export function SettingsDialog({ width = 720, ...props }: ComponentProps<typeof Dialog>) {
  return <Dialog {...props} width={width} className="settings-dialog">
    {props.headerless && <div className="settings-dialog-close"><DialogClose asChild><IconButton icon={X} label={t("close")} disabled={props.busy} /></DialogClose></div>}
    {props.children}
  </Dialog>;
}

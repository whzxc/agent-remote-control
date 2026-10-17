import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Icon } from "./index";
import "./Feedback.css";

export function ErrorCallout({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div role="alert" className="ui-error-callout">
    <Icon icon={AlertCircle} size={20} />
    <div className="ui-error-content">
      <p className="ui-error-message">{children}</p>
      {action && <div className="ui-error-action">{action}</div>}
    </div>
  </div>;
}

export function LoadingIndicator({ label }: { label: string }) {
  return <span className="ui-loading" role="status" aria-label={label}>
    <span className="ui-spinner" aria-hidden="true" />
  </span>;
}

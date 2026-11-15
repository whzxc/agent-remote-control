import './Controls.css';
import { Button, Icon } from '../components/ui';
import { useCopyState } from "../components/ui/useCopyState";



import { useId, type ReactNode } from "react";

import { Check, ChevronDown, ChevronUp, CircleAlert, Copy } from "lucide-react";
import { t } from "../i18n";


export function Disclosure({ expanded, controls, onToggle, children }: { expanded: boolean; controls?: string; onToggle: () => void; children: ReactNode }) {
  return <button type="button" className="tag disclosure" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
    {children}<Icon icon={expanded ? ChevronUp : ChevronDown} size={12} />
  </button>;
}

export function Prompt({ text, label, context, actionBelow = false }: { text: string; label: string; context?: string; actionBelow?: boolean }) {
  const { copied, error, copy } = useCopyState(), id = useId();
  return <div className={`prompt ${actionBelow ? "prompt-action-below" : ""}`}>
    <p id={id}>{text}</p>
    <Button aria-describedby={id} onClick={() => { void copy(text); }}>
      <Icon icon={copied ? Check : Copy} />{copied ? t("copied") : label}{context && <span className="sr-only">{context}</span>}
    </Button>
    {error && <p className="field-error" role="alert"><Icon icon={CircleAlert} size={14} />{error}</p>}
    {copied && <span className="sr-only" role="status">{t("copied")}</span>}
  </div>;
}

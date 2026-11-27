import type { ReactNode } from "react";
import { useCopyState } from "../components/ui/useCopyState";
import { McpDisclosureView, McpPromptView } from "./McpControlsView";
import "./Controls.css";

export function Disclosure({
  expanded,
  controls,
  onToggle,
  children,
}: {
  expanded: boolean;
  controls?: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <McpDisclosureView expanded={expanded} controls={controls} onToggle={onToggle}>
      {children}
    </McpDisclosureView>
  );
}

export function Prompt({
  text,
  label,
  context,
  actionBelow = false,
  layout = "inline",
  className,
}: {
  text: string;
  label: string;
  context?: string;
  actionBelow?: boolean;
  layout?: "inline" | "stacked";
  className?: string;
}) {
  const { copied, error, copy } = useCopyState();
  return (
    <McpPromptView
      text={text}
      label={label}
      context={context}
      copied={copied}
      error={error || undefined}
      onCopy={() => {
        void copy(text);
      }}
      actionBelow={actionBelow}
      layout={layout}
      className={className}
    />
  );
}

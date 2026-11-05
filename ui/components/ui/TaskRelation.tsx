import { Bot, ChevronRight, MessageCircle } from "lucide-react";
import type { AgentActivitySession } from "../../types";
import { t } from "../../i18n";
import { Button, Icon } from "./index";
import "./TaskRelation.css";

export function TaskRelation({ kind }: { kind: AgentActivitySession["relationKind"] }) {
  if (!kind) return null;
  return <span className="task-relation"><Icon icon={kind === "side-chat" ? MessageCircle : Bot} /><span>{t(`activity.relation.${kind}`)}</span><span className="task-relation-separator">·</span></span>;
}
export function TaskParentLink({ title, onClick }: { title: string; onClick: () => void }) {
  return <Button variant="ghost" className="task-parent-link" onClick={onClick}>
    <span>{t("activity.parentThread")}</span><strong>{title}</strong><Icon icon={ChevronRight} />
  </Button>;
}

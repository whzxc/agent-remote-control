import { Bot, MessageCircle } from "lucide-react";
import type { AgentActivitySession } from "../../types";
import { t } from "../../i18n";
import { Icon } from "../ui/index";
import "./TaskRelation.css";

export function TaskRelation({ kind }: { kind: AgentActivitySession["relationKind"] }) {
  if (!kind) return null;
  return <span className="task-relation"><Icon icon={kind === "side-chat" ? MessageCircle : Bot} /><span>{t(`activity.relation.${kind}`)}</span><span className="task-relation-separator">·</span></span>;
}

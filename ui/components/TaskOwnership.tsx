import { AppWindow, Monitor } from "lucide-react";
import { t } from "../i18n";
import type { TaskOwnership as Ownership } from "../types";
import { Icon } from "./ui";

export default function TaskOwnership({ ownership }: { ownership?: Ownership }) {
  const owner = ownership?.owner;
  if (ownership?.state !== "held" || owner !== "connector" && owner !== "desktop") return null;
  const label = t(`detail.owner.${owner}`);
  return <span className="task-ownership-chip" aria-label={t("detail.owner", { owner: label })}>
    <Icon icon={owner === "desktop" ? Monitor : AppWindow} /><span>{label}</span>
  </span>;
}

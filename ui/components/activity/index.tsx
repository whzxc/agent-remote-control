import { SourceMark } from "./SourceMark";
import { Terminal } from "lucide-react";
import type { DispatchSummary } from "../../types";
import { controlSource } from "../../controlSources";
import { t } from "../../i18n";
import SourceIcon from "../SourceIcon";
import { Icon } from "../ui";

export function dispatchSourceLabel(source?: DispatchSummary["controlSource"]) {
  return source?.label || (source?.kind === "local-cli" ? t("localCli") : controlSource(source?.kind ?? "")?.displayName || source?.kind || source?.id || "");
}
export function SourceBadge({ source, inline = false }: { source: NonNullable<DispatchSummary["controlSource"]>; inline?: boolean }) {
  return <SourceMark label={dispatchSourceLabel(source)} inline={inline}>
    {source.kind === "local-cli" ? <Icon icon={Terminal} /> : <SourceIcon platform={source.kind ?? ""} />}
  </SourceMark>;
}

import { AppWindow, Monitor } from "lucide-react";
import { t } from "../i18n";
import type { TaskOwnership as Ownership } from "../types";
import { Icon } from "./ui";

import { OwnershipTag } from "./timeline/TaskPresentation";

export default function TaskOwnership({ ownership }: { ownership?: Ownership }) {
  const owner = ownership?.owner;
  const handback = ownership?.handback;
  const current = ownership?.state === "held" ? ownership : undefined;
  const holder = handback?.holder ?? handback?.descendants?.find(child => child.holder)?.holder ?? current;
  const process = holder?.processes?.[0];
  const origin = holder?.origin ?? owner;
  const originKey = origin === "shared-app-server" ? "shared" : origin === "main-desktop" ? "mainDesktop" :
    origin === "ssh" ? "ssh" : origin === "desktop-profile" || origin === "desktop" ? "desktop" : "external";
  const processName = process && `${process.executable.split("/").pop()} (${process.pid})`;
  const holderLabel = [t(`detail.handback.${originKey}`), processName].filter(Boolean).join(" · ");
  let label: string;
  if (handback && ["handed-back", "running", "unconfirmed", "subtree-held", "held"].includes(handback.state)) {
    label = t(`detail.handback.${handback.state}`);
    if (holder && handback.state !== "running") label += ` · ${holderLabel}`;
    const drop = handback.ownHold;
    const evidence = drop && t("detail.handback.drop", { time: drop.observedAt, reason: drop.reason, evidence: drop.nativeStatus || drop.evidence });
    return <OwnershipTag aria-label={label} aria-description={evidence} title={evidence}><Icon icon={Monitor} /><span>{label}</span></OwnershipTag>;
  }
  if (owner === "shared-app-server" || owner === "external") {
    return <OwnershipTag aria-label={holderLabel}><Icon icon={Monitor} /><span>{holderLabel}</span></OwnershipTag>;
  }
  if (ownership?.state !== "held" || owner !== "connector" && owner !== "desktop") return null;
  label = t(`detail.owner.${owner}`);
  return <OwnershipTag aria-label={t("detail.owner", { owner: label })}>
    <Icon icon={owner === "desktop" ? Monitor : AppWindow} /><span>{label}</span>
  </OwnershipTag>;
}

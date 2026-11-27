import { useState } from "react";
import { SegmentedControl } from "../components/kit/segmented-control";
import { cn } from "../components/kit/utils";
import { useI18n } from "../i18n/react";
import { McpPromptView } from "./McpControlsView";

export const mcpProfiles = ["codex", "claude", "cursor", "gemini"] as const;
export type McpProfile = (typeof mcpProfiles)[number];

export function McpImportPromptView({
  profile: controlledProfile,
  onProfileChange,
  copied = false,
  copyError,
  onCopyText,
  actionBelow = false,
  className,
}: {
  profile?: McpProfile;
  onProfileChange?: (profile: McpProfile) => void;
  copied?: boolean;
  copyError?: string;
  onCopyText?: (text: string) => void;
  actionBelow?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const [localProfile, setLocalProfile] = useState<McpProfile>("codex");
  const activeProfile = controlledProfile ?? localProfile;
  const setProfile = (next: McpProfile) => {
    setLocalProfile(next);
    onProfileChange?.(next);
  };

  const options = mcpProfiles.map((value) => ({
    value,
    label: t(`mcp.profile.${value}`),
  }));
  const promptText = t("mcp.promptImport", {
    from: t(`mcp.profile.${activeProfile}`),
  });

  return (
    <div
      className={cn(
        "mcp-import grid w-full min-w-0 gap-3",
        actionBelow
          ? "max-w-[520px] justify-items-center gap-4"
          : "justify-items-start",
        className,
      )}
    >
      <SegmentedControl
        size="sm"
        aria-label={t("mcp.importFrom")}
        value={activeProfile}
        onValueChange={setProfile}
        options={options}
      />
      <McpPromptView
        actionBelow={actionBelow}
        layout={actionBelow ? "stacked" : "inline"}
        label={t("mcp.copyPrompt")}
        context={t("mcp.importFrom")}
        text={promptText}
        copied={copied}
        error={copyError}
        onCopy={() => onCopyText?.(promptText)}
      />
    </div>
  );
}

export function McpImportDialogView({
  copiedKey,
  copyErrorKey,
  copyError,
  onCopyPrompt,
}: {
  copiedKey?: string;
  copyErrorKey?: string;
  copyError?: string;
  onCopyPrompt?: (key: string, text: string) => void;
}) {
  const { t } = useI18n();
  const httpText = t("mcp.promptHttp");
  const stdioText = t("mcp.promptStdio");

  return (
    <div className="grid gap-5">
      <p className="m-0 text-small leading-5 text-text-secondary">
        {t("mcp.addIntro")}
      </p>
      <section className="grid gap-2" aria-label={t("mcp.addImport")}>
        <h3 className="m-0 text-small font-semibold text-foreground">
          {t("mcp.addImport")}
        </h3>
        <McpImportPromptView
          copied={copiedKey === "import"}
          copyError={copyErrorKey === "import" ? copyError : undefined}
          onCopyText={(text) => onCopyPrompt?.("import", text)}
        />
      </section>
      <section className="grid gap-2" aria-label={t("mcp.addHttp")}>
        <h3 className="m-0 text-small font-semibold text-foreground">
          {t("mcp.addHttp")}
        </h3>
        <McpPromptView
          label={t("mcp.copyPrompt")}
          context={t("mcp.addHttp")}
          text={httpText}
          copied={copiedKey === "http"}
          error={copyErrorKey === "http" ? copyError : undefined}
          onCopy={() => onCopyPrompt?.("http", httpText)}
        />
      </section>
      <section className="grid gap-2" aria-label={t("mcp.addStdio")}>
        <h3 className="m-0 text-small font-semibold text-foreground">
          {t("mcp.addStdio")}
        </h3>
        <McpPromptView
          label={t("mcp.copyPrompt")}
          context={t("mcp.addStdio")}
          text={stdioText}
          copied={copiedKey === "stdio"}
          error={copyErrorKey === "stdio" ? copyError : undefined}
          onCopy={() => onCopyPrompt?.("stdio", stdioText)}
        />
      </section>
    </div>
  );
}

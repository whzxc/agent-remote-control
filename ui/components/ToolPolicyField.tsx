import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { locale, t } from "../i18n";
import {
  identifyPolicy,
  normalizeSelection,
  presetPolicy,
  type ToolCatalog,
  type ToolMode,
  type ToolPolicy,
} from "../toolPolicy";
import { ToolPolicyView } from "./connectivity/ToolPolicyView";
import { Button } from "./kit/button";
import { DialogSubview } from "./kit/dialog";
import { Checkbox, Tooltip } from "./ui";

export default function ToolPolicyField({
  value,
  onChange,
  disabled,
}: {
  value?: ToolPolicy;
  onChange: (value: ToolPolicy) => void;
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<ToolCatalog>();
  const [mode, setMode] = useState<ToolMode>(
    value === undefined ? "common" : value === "all" ? "all" : "custom",
  );
  const [failure, setFailure] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);

  async function load() {
    setFailure(false);
    try {
      const next = await api<ToolCatalog>("tool-catalog");
      setCatalog(next);
      setMode(identifyPolicy(value, next));
    } catch {
      setFailure(true);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (catalog && !open) setMode(identifyPolicy(value, catalog));
  }, [value, catalog, disabled, open]);

  const selected =
    value === "all"
      ? (catalog?.tools.map((tool) => tool.name) ?? [])
      : (value?.allowlist ??
        (catalog
          ? (presetPolicy("common", catalog) as { allowlist: string[] })
              .allowlist
          : []));

  const options = [
    { value: "all", label: t("toolsAll") },
    { value: "common", label: t("toolsCommon") },
    { value: "readOnly", label: t("toolsReadOnly") },
    { value: "custom", label: t("toolsCustom") },
  ];

  function choose(next: string) {
    if (!catalog) return;
    setMode(next as ToolMode);
    if (next === "custom") {
      setDraft([...selected]);
      setOpen(true);
      return;
    }
    onChange(
      next === "all"
        ? "all"
        : presetPolicy(next as "common" | "readOnly", catalog),
    );
  }

  const exposed =
    catalog?.tools.filter(
      (tool) => selected.includes(tool.name) && tool.available !== false,
    ) ?? [];
  const locked = new Set(catalog?.required ?? []);
  for (const tool of catalog?.tools ?? []) {
    if (draft.includes(tool.name)) {
      for (const name of tool.requires) locked.add(name);
    }
  }

  const back = useCallback(() => setOpen(false), []);

  function toggle(names: string[], checked: boolean) {
    const next = normalizeSelection(
      checked
        ? [...draft, ...names]
        : draft.filter((name) => !names.includes(name)),
      catalog!,
    );
    setDraft(next);
    onChange({ allowlist: next });
  }

  return (
    <>
      <ToolPolicyView
        label={t("toolList")}
        value={mode}
        options={options}
        onChange={choose}
        disabled={disabled || !catalog}
        summary={t("toolSelectionCount", {
          groups: new Set(exposed.map((tool) => tool.group)).size,
          count: exposed.length,
        })}
        summaryHidden={!catalog}
        viewAllLabel={t("toolViewAll")}
        onViewAll={() => {
          setDraft([...selected]);
          setOpen(true);
        }}
        error={failure ? t("toolCatalogFailed") : undefined}
        retryLabel={t("toolCatalogRetry")}
        onRetry={() => void load()}
      />
      <DialogSubview
        open={open}
        onBack={back}
        title={`${t("toolList")} · ${options.find((option) => option.value === mode)?.label}`}
        footer={
          <Button variant="primary" onClick={back}>
            {t("done")}
          </Button>
        }
      >
        <div className="tool-groups">
          {catalog?.groups.map((group) => {
            const tools = catalog.tools.filter(
              (tool) =>
                tool.group === group.id &&
                (mode === "custom" || draft.includes(tool.name)),
            );
            if (!tools.length) return null;
            const all = tools.every((tool) => draft.includes(tool.name));
            return (
              <section key={group.id}>
                {mode === "custom" ? (
                  <Checkbox
                    checked={
                      all
                        ? true
                        : tools.some((tool) => draft.includes(tool.name))
                          ? "indeterminate"
                          : false
                    }
                    onChange={(checked) =>
                      toggle(
                        tools.map((tool) => tool.name),
                        checked,
                      )
                    }
                    disabled={disabled}
                  >
                    <strong>{group.label[locale.get()]}</strong>
                  </Checkbox>
                ) : (
                  <h3>{group.label[locale.get()]}</h3>
                )}
                <div className="tool-items">
                  {tools.map((tool) => (
                    <div key={tool.name}>
                      {mode === "custom" ? (
                        <Checkbox
                          checked={draft.includes(tool.name)}
                          onChange={(checked) => toggle([tool.name], checked)}
                          disabled={
                            disabled ||
                            (draft.includes(tool.name) && locked.has(tool.name))
                          }
                        >
                          <Tooltip text={tool.description}>
                            <span tabIndex={0} className="tool-name">
                              {tool.via} · {tool.name}
                              {tool.tier === "advanced"
                                ? ` · ${t("toolsAdvanced")}`
                                : ""}
                              {tool.available === false
                                ? ` · ${t("toolsUnavailable")}`
                                : ""}
                            </span>
                          </Tooltip>
                        </Checkbox>
                      ) : (
                        <Tooltip text={tool.description}>
                          <span tabIndex={0} className="tool-name">
                            {tool.via} · {tool.name}
                            {tool.tier === "advanced"
                              ? ` · ${t("toolsAdvanced")}`
                              : ""}
                            {tool.available === false
                              ? ` · ${t("toolsUnavailable")}`
                              : ""}
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </DialogSubview>
    </>
  );
}

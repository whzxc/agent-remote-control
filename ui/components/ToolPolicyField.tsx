import { useEffect, useState } from "react";
import { api } from "../api";
import { t, locale } from "../i18n";
import {
  identifyPolicy,
  normalizeSelection,
  presetPolicy,
  type ToolCatalog,
  type ToolMode,
  type ToolPolicy,
} from "../toolPolicy";
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  Field,
  Notice,
  SingleChoice,
  Tooltip,
} from "./ui";
export default function ToolPolicyField({
  value,
  onChange,
  disabled,
}: {
  value?: ToolPolicy;
  onChange: (value: ToolPolicy) => void;
  disabled?: boolean;
}) {
  const [catalog, setCatalog] = useState<ToolCatalog>(),
    [mode, setMode] = useState<ToolMode>(
      value === undefined ? "common" : value === "all" ? "all" : "custom",
    ),
    [failure, setFailure] = useState(false),
    [open, setOpen] = useState(false),
    [draft, setDraft] = useState<string[]>([]);
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
      : value?.allowlist ??
        (catalog
          ? (presetPolicy("common", catalog) as { allowlist: string[] }).allowlist
          : []);
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
  for (const tool of catalog?.tools ?? [])
    if (draft.includes(tool.name))
      for (const name of tool.requires) locked.add(name);
  function toggle(names: string[], checked: boolean) {
    setDraft(
      normalizeSelection(
        checked
          ? [...draft, ...names]
          : draft.filter((name) => !names.includes(name)),
        catalog!,
      ),
    );
  }
  return (
    <>
      <Field label={t("toolList")}>
        <SingleChoice
          value={mode}
          onChange={choose}
          label={t("toolList")}
          options={options}
          disabled={disabled || !catalog}
        />
        <div className="actions" style={{ visibility: catalog ? "visible" : "hidden" }} aria-hidden={!catalog}>
          <span className="muted small">
            {t("toolSelectionCount", {
              groups: new Set(exposed.map((tool) => tool.group)).size,
              count: exposed.length,
            })}
          </span>
          <Button
            variant="ghost"
            disabled={disabled || !catalog}
            onClick={() => {
              setDraft([...selected]);
              setOpen(true);
            }}
          >
            {t("toolViewAll")}
          </Button>
        </div>
        {failure && (
          <Notice
            action={
              <Button onClick={() => void load()}>
                {t("toolCatalogRetry")}
              </Button>
            }
          >
            {t("toolCatalogFailed")}
          </Notice>
        )}
      </Field>
      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          if (catalog) setMode(identifyPolicy(value, catalog));
        }}
        title={`${t("toolList")} · ${options.find((option) => option.value === mode)?.label}`}
        footer={
          <>
            <DialogClose asChild>
              <Button>{t("cancel")}</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button
                variant="primary"
                disabled={disabled}
                onClick={() => {
                  if (mode === "custom")
                    onChange({ allowlist: normalizeSelection(draft, catalog!) });
                }}
              >
                {t("done")}
              </Button>
            </DialogClose>
          </>
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
                              {tool.tier === "advanced" ? ` · ${t("toolsAdvanced")}` : ""}
                              {tool.available === false ? ` · ${t("toolsUnavailable")}` : ""}
                            </span>
                          </Tooltip>
                        </Checkbox>
                      ) : (
                        <Tooltip text={tool.description}>
                          <span tabIndex={0} className="tool-name">
                            {tool.via} · {tool.name}
                              {tool.tier === "advanced" ? ` · ${t("toolsAdvanced")}` : ""}
                              {tool.available === false ? ` · ${t("toolsUnavailable")}` : ""}
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
      </Dialog>
    </>
  );
}

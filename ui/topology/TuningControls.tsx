import { Tooltip as HoverHelp } from "../components/ui/index";
import { TransientLayer } from "../components/ui/TransientLayer";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { locale, t } from "../i18n";
import { copyText } from "../platform";
import { AccordionPrimitive } from "../components/kit/accordion";
import { PopoverPrimitive } from "../components/kit/popover";
import { Button, Field, Icon, IconButton, Input, Switch } from "../components/ui";
import { Slider } from "./Slider";
import { PARAMETERS, PARAMETER_GROUPS } from "./solve";
import { importParameters, parameterDiff } from "./parameters";
import { topologyTuningEnabled, topologyParameters, topologyValues, topologyDebug, previewParameter, saveTopologyParameters, resetTopologyParameter } from "../state/topology";
import "./TuningControls.css";

function TuningSection({ value, title, className, open, children }: {
  value: string; title: string; className: string; open: boolean; children: ReactNode;
}) {
  const state = open ? "open" : "closed";
  return (
    <AccordionPrimitive.Item value={value} className={className}>
      <AccordionPrimitive.Header className="topology-section-heading">
        <AccordionPrimitive.Trigger
          data-state={state}
          render={<Button variant="ghost" className="topology-section-trigger" />}
        >
          <span>{title}</span><Icon icon={ChevronDown} size={16} />
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Panel
        className="topology-section-content"
        data-state={state}
        style={{ "--radix-accordion-content-height": "var(--accordion-panel-height)" } as CSSProperties}
      >
        <div className="topology-section-inner">{children}</div>
      </AccordionPrimitive.Panel>
    </AccordionPrimitive.Item>
  );
}

function ParameterControl({ spec, value }: { spec: typeof PARAMETERS[number]; value: number }) {
  const lang = locale.use(), label = spec.label[lang], changed = value !== spec.default;
  const [text, setText] = useState(String(value)), [notice, setNotice] = useState("");
  useEffect(() => setText(String(value)), [value]);
  function apply() {
    const number = text.trim() ? Number(text) : NaN;
    const adjusted = previewParameter(spec.key, number);
    saveTopologyParameters(); setText(String(topologyValues.get()[spec.key]));
    setNotice(adjusted ? t("topology.adjusted", { label, min: spec.min, max: spec.max, value: topologyValues.get()[spec.key] }) : "");
  }
  return <Field compact id={`topology-${spec.key}`} label={<span>{label}{changed && <span className="topology-custom" aria-label={t("topology.custom")}> •</span>}</span>}>
    <HoverHelp text={t("topology.defaultValue", { value: spec.default })}><div className="topology-parameter">
      <Slider label={label} min={spec.min} max={spec.max} step={spec.step} value={value}
        onChange={number => { previewParameter(spec.key, number); setNotice(""); }}
        onCommit={number => { previewParameter(spec.key, number); saveTopologyParameters(); }} />
      <Input id={`topology-${spec.key}`} inputMode="decimal" data-edited={text !== String(value) || undefined} value={text} aria-label={t("topology.valueLabel", { label })}
        onChange={event => setText(event.target.value)} onBlur={apply}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape" && text !== String(value)) { setText(String(value)); event.stopPropagation(); }
        }} />
      <IconButton icon={RotateCcw} label={t("topology.resetOne", { label })} size={16} disabled={!changed}
        onClick={() => { resetTopologyParameter(spec.key); setNotice(""); }} />
    </div></HoverHelp>
    {notice && <p role="status" className="topology-tuner-hint">{notice}</p>}
  </Field>;
}

export default function TuningControls({ available }: { available: boolean }) {
  const lang = locale.use(), enabled = topologyTuningEnabled.use(), values = topologyValues.use(), debug = topologyDebug.use();
  const element = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [openSections, setOpenSections] = useState<string[]>(() => Object.keys(PARAMETER_GROUPS));
  const [message, setMessage] = useState(""), [json, setJson] = useState(""), [importError, setImportError] = useState("");
  function changeOpen(next: boolean) {
    if (!next) saveTopologyParameters();
    setOpen(next);
  }
  useEffect(() => {
    if (open && (!available || !enabled)) changeOpen(false);
  }, [available, enabled, open]);
  useEffect(() => () => saveTopologyParameters(), []);
  if (!enabled) return null;
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next) {
          if (details.reason === "escape-key") {
            if (
              details.event.target instanceof HTMLInputElement &&
              details.event.target.matches('.topology-parameter input[data-edited]')
            ) {
              details.cancel();
              return;
            }
            details.event.stopPropagation();
          }
          if (details.reason === "outside-press") {
            const active = document.activeElement;
            if (active instanceof HTMLInputElement && element.current?.contains(active)) {
              active.blur();
            }
          }
        }
        changeOpen(next);
      }}
    >
      <PopoverPrimitive.Trigger
        render={
          <IconButton icon={SlidersHorizontal} size={20} label={t("topology.tuning")} data-hover-target="topology" />
        }
      />
      <PopoverPrimitive.Portal>
        <TransientLayer onDismiss={() => changeOpen(false)}>
          <PopoverPrimitive.Positioner side="top" align="start" sideOffset={12} collisionPadding={16} className="z-60">
            <PopoverPrimitive.Popup
              ref={element}
              className="topology-tuner"
              aria-label={t("topology.tuning")}
              finalFocus={(!available || !enabled) ? false : undefined}
              style={{ "--radix-popover-content-available-height": "var(--available-height)" } as CSSProperties}
            >
              <header>
                <strong>{t("topology.tuning")}</strong>
                <PopoverPrimitive.Close render={<IconButton icon={X} label={t("close")} />} />
              </header>
              <div className="topology-tuner-body">
                <div className="topology-tuner-option"><span>{t("topology.guides")}</span><Switch label={t("topology.guides")} checked={debug.guides} onChange={guides => topologyDebug.set(old => ({ ...old, guides }))} /></div>
                <div className="topology-tuner-option"><span>{t("topology.slow")}</span><Switch label={t("topology.slow")} checked={debug.slow} onChange={slow => topologyDebug.set(old => ({ ...old, slow }))} /></div>
                {debug.guides && <p className="topology-tuner-hint">{t("topology.guideHint")}</p>}
                <div className="topology-tuner-actions">
                  <Button onClick={() => { resetTopologyParameter(); setMessage(t("topology.resetDone")); }}>{t("topology.resetAll")}</Button>
                  <Button onClick={() => { void copyText(JSON.stringify(parameterDiff(topologyValues.get()), null, 2)).then(() => setMessage(t("topology.copied")), () => setMessage(t("topology.copyFailed"))); }}>{t("topology.export")}</Button>
                </div>
                <div role="status" className="topology-tuner-status">{message}</div>
                <AccordionPrimitive.Root
                  multiple
                  value={openSections}
                  onValueChange={next => setOpenSections(next as string[])}
                >
                  <TuningSection value="import" title={t("topology.import")} className="topology-import" open={openSections.includes("import")}>
                    <form noValidate onSubmit={event => {
                      event.preventDefault(); const result = importParameters(json);
                      if (!result.ok) { setImportError(t(`topology.importError.${result.error}`)); element.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(); return; }
                      topologyParameters.set(result.document); setImportError("");
                      setMessage(result.clamped.length ? t("topology.importClamped", { labels: result.clamped.map(key => {
                        const spec = PARAMETERS.find(p => p.key === key)!;
                        return spec.label[lang];
                      }).join(", ") }) : t("topology.imported"));
                    }}>
                      <Field compact id="topology-import" label={t("topology.paste")} error={importError}>
                        <textarea id="topology-import" className="input" rows={4} value={json} spellCheck={false} aria-invalid={!!importError}
                          aria-describedby={importError ? "topology-import-error" : undefined} onChange={event => { setJson(event.target.value); setImportError(""); }} />
                      </Field>
                      <Button type="submit">{t("topology.applyImport")}</Button>
                    </form>
                  </TuningSection>
                  {Object.entries(PARAMETER_GROUPS).map(([group, label]) => (
                    <TuningSection value={group} title={label[lang]} className="topology-parameter-group" key={group} open={openSections.includes(group)}>
                      {PARAMETERS.filter(p => p.group === group).map(spec => <ParameterControl key={spec.key} spec={spec} value={values[spec.key]} />)}
                    </TuningSection>
                  ))}
                </AccordionPrimitive.Root>
              </div>
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </TransientLayer>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

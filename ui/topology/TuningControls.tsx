import { Tooltip as HoverHelp } from "../components/ui/index";
import { TransientLayer } from "../components/ui/TransientLayer";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Accordion, Popover } from "radix-ui";
import { ChevronDown, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { locale, t } from "../i18n";
import { copyText } from "../platform";
import { Button, Field, Icon, IconButton, Input, Slider, Switch, Textarea } from "../components/ui";
import { PARAMETERS, PARAMETER_GROUPS } from "./solve";
import { importParameters, parameterDiff } from "./parameters";
import { topologyTuningEnabled, topologyParameters, topologyValues, topologyDebug, previewParameter, saveTopologyParameters, resetTopologyParameter } from "../state/topology";

function TuningSection({ value, title, className, children }: { value: string; title: string; className: string; children: ReactNode }) {
  return <Accordion.Item value={value} className={className}>
    <Accordion.Header className="topology-section-heading">
      <Accordion.Trigger asChild><Button variant="ghost" className="topology-section-trigger">
        <span>{title}</span><Icon icon={ChevronDown} size={16} />
      </Button></Accordion.Trigger>
    </Accordion.Header>
    <Accordion.Content className="topology-section-content"><div className="topology-section-inner">{children}</div></Accordion.Content>
  </Accordion.Item>;
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
  return <Field id={`topology-${spec.key}`} label={<span>{label}{changed && <span className="topology-custom" aria-label={t("topology.custom")}> •</span>}</span>}>
    <HoverHelp text={t("topology.defaultValue", { value: spec.default })}><div className="topology-parameter">
      <Slider label={label} min={spec.min} max={spec.max} step={spec.step} value={value}
        onChange={number => { previewParameter(spec.key, number); setNotice(""); }}
        onCommit={number => { previewParameter(spec.key, number); saveTopologyParameters(); }} />
      <Input id={`topology-${spec.key}`} inputMode="decimal" value={text} aria-label={t("topology.valueLabel", { label })}
        onChange={event => setText(event.target.value)} onBlur={apply}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setText(String(value)); event.stopPropagation(); }
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
  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger asChild><IconButton icon={SlidersHorizontal} size={20} label={t("topology.tuning")} data-hover-target="topology" /></Popover.Trigger>
    <Popover.Portal><TransientLayer><Popover.Content ref={element} className="topology-tuner" side="top" align="start" sideOffset={12} collisionPadding={16}
      aria-label={t("topology.tuning")} onEscapeKeyDown={event => event.stopPropagation()}
      onInteractOutside={() => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && element.current?.contains(active)) active.blur();
      }}
      onCloseAutoFocus={event => { if (!available || !enabled) event.preventDefault(); }}>
      <header><strong>{t("topology.tuning")}</strong><Popover.Close asChild><IconButton icon={X} label={t("close")} /></Popover.Close></header>
      <div className="topology-tuner-body">
        <div className="topology-tuner-option"><span>{t("topology.guides")}</span><Switch label={t("topology.guides")} checked={debug.guides} onChange={guides => topologyDebug.set(old => ({ ...old, guides }))} /></div>
        <div className="topology-tuner-option"><span>{t("topology.slow")}</span><Switch label={t("topology.slow")} checked={debug.slow} onChange={slow => topologyDebug.set(old => ({ ...old, slow }))} /></div>
        {debug.guides && <p className="topology-tuner-hint">{t("topology.guideHint")}</p>}
        <div className="topology-tuner-actions">
          <Button onClick={() => { resetTopologyParameter(); setMessage(t("topology.resetDone")); }}>{t("topology.resetAll")}</Button>
          <Button onClick={() => { void copyText(JSON.stringify(parameterDiff(topologyValues.get()), null, 2)).then(() => setMessage(t("topology.copied")), () => setMessage(t("topology.copyFailed"))); }}>{t("topology.export")}</Button>
        </div>
        <div role="status" className="topology-tuner-status">{message}</div>
        <Accordion.Root type="multiple" defaultValue={Object.keys(PARAMETER_GROUPS)}>
          <TuningSection value="import" title={t("topology.import")} className="topology-import">
            <form noValidate onSubmit={event => {
              event.preventDefault(); const result = importParameters(json);
              if (!result.ok) { setImportError(t(`topology.importError.${result.error}`)); element.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus(); return; }
              topologyParameters.set(result.document); setImportError("");
              setMessage(result.clamped.length ? t("topology.importClamped", { labels: result.clamped.map(key => {
                const spec = PARAMETERS.find(p => p.key === key)!;
                return spec.label[lang];
              }).join(", ") }) : t("topology.imported"));
            }}>
              <Field id="topology-import" label={t("topology.paste")} error={importError}>
                <Textarea id="topology-import" rows={4} value={json} spellCheck={false} aria-invalid={!!importError}
                  aria-describedby={importError ? "topology-import-error" : undefined} onChange={event => { setJson(event.target.value); setImportError(""); }} />
              </Field>
              <Button type="submit">{t("topology.applyImport")}</Button>
            </form>
          </TuningSection>
          {Object.entries(PARAMETER_GROUPS).map(([group, label]) => <TuningSection value={group} title={label[lang]} className="topology-parameter-group" key={group}>
            {PARAMETERS.filter(p => p.group === group).map(spec => <ParameterControl key={spec.key} spec={spec} value={values[spec.key]} />)}
          </TuningSection>)}
        </Accordion.Root>
      </div>
    </Popover.Content></TransientLayer></Popover.Portal>
  </Popover.Root>;
}

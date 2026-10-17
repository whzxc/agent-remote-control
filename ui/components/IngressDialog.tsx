import { useState, useRef, useEffect, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { displayMessage } from "../messages";
import { openUrl } from "../platform";
import {
  controlSource,
  curatedSources,
  nextSourceName,
} from "../controlSources";
import {
  providers,
  fixedDomain,
  needsCredential,
  credentialSaved,
  secretFields,
} from "../ingressConfig";
import { validDomain } from "../formRules";
import { connectionForm, type ConnectionForm } from "../state/connectionForm";
import { connector, refreshConnector } from "../state/connector";
import type { Ingress } from "../state/types";
import type { ToolPolicy } from "../toolPolicy";
import {
  Button,
  Dialog,
  DialogClose,
  Field,
  Input,
  IconButton,
  Notice,
  SingleChoice,
} from "./ui";
import SourceIcon from "./SourceIcon";
import ToolPolicyField from "./ToolPolicyField";
export default function IngressDialog({
  ingress: initialIngress,
  focusField,
  onClose,
  onSaved,
  onRemoved,
}: {
  ingress?: Ingress;
  focusField?: string;
  onClose: () => void;
  onSaved: (ingress: Ingress) => void;
  onRemoved: () => void;
}) {
  const { status } = connector.use();
  const ingress = status?.ingresses.find(i => i.id === initialIngress?.id) ?? initialIngress;
  const dirty = useRef(new Set<string>());
  const [selected, setSelected] = useState(
    ingress
      ? controlSource(ingress.controlSource)?.curated
        ? ingress.controlSource
        : "custom"
      : "",
  );
  const [source, setSource] = useState(ingress?.controlSource || ""),
    [name, setName] = useState(ingress?.name || ""),
    [form, setForm] = useState(() => {
      const f = connectionForm(ingress?.config);
      if (ingress)
        f.connectionMode =
          ingress.transport === "openai-tunnel" ? "tunnel" : "https";
      return f;
    });
  const [auth, setAuth] = useState(
      ingress?.auth === "oauth"
        ? "oauth"
        : ingress?.auth === "bearer"
          ? "bearer"
          : "none",
    ),
    [toolPolicy, setToolPolicy] = useState<ToolPolicy | undefined>(
      ingress?.toolPolicy,
    );
  const [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!ingress) return;
    const incoming = connectionForm(ingress.config);
    incoming.connectionMode = ingress.transport === "openai-tunnel" ? "tunnel" : "https";
    setForm(old => {
      const next = { ...old };
      for (const key of Object.keys(incoming) as (keyof ConnectionForm)[]) {
        if (!dirty.current.has(key)) Object.assign(next, { [key]: incoming[key] });
      }
      return next;
    });
    if (!dirty.current.has("name")) setName(ingress.name);
    if (!dirty.current.has("source")) {
      setSource(ingress.controlSource);
      setSelected(controlSource(ingress.controlSource)?.curated ? ingress.controlSource : "custom");
    }
    if (!dirty.current.has("auth")) setAuth(ingress.auth === "oauth" ? "oauth" : ingress.auth === "bearer" ? "bearer" : "none");
    if (!dirty.current.has("toolPolicy")) setToolPolicy(ingress.toolPolicy);
    setErrors(old => Object.fromEntries(Object.entries(old).filter(([key]) => dirty.current.has(key))));
  }, [ingress]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const lastSelection = useRef("");
  useEffect(() => {
    if (selected) lastSelection.current = selected;
    else if (lastSelection.current) pickerRef.current?.querySelector<HTMLButtonElement>(`[data-source="${CSS.escape(lastSelection.current)}"]`)?.focus();
  }, [selected]);
  const formRef = useRef<HTMLFormElement>(null);
  const preset = controlSource(selected),
    provider = providers[form.httpsProvider],
    https = form.connectionMode === "https",
    allowTunnel =
      preset?.recommendedTransport === "openai-tunnel" || selected === "custom";
  function change<K extends keyof ConnectionForm>(
    key: K,
    value: ConnectionForm[K],
  ) {
    dirty.current.add(key);
    if (["connectionMode", "httpsProvider", "cloudflareMode", "ngrokMode", "pinggyMode", "localxposeMode"].includes(key)) dirty.current.add("domain");
    setForm((old) => ({
      ...old,
      [key]: value,
      ...([
        "connectionMode",
        "httpsProvider",
        "cloudflareMode",
        "ngrokMode",
        "pinggyMode",
        "localxposeMode",
      ].includes(key)
        ? { domain: "" }
        : {}),
    }));
    setErrors((old) => ({ ...old, [key]: "" }));
  }
  function choose(value: string) {
    if (value === lastSelection.current) { setSelected(value); return; }
    const preset = controlSource(value),
      f = connectionForm();
    f.connectionMode =
      preset?.recommendedTransport === "openai-tunnel" ? "tunnel" : "https";
    f.cloudflareMode = f.connectionMode === "tunnel" ? "quick" : "named";
    for (const key of [...Object.keys(f), "source", "name", "auth"]) dirty.current.add(key);
    setSelected(value);
    setSource(value === "custom" ? "" : value);
    setName(
      value === "custom"
        ? ""
        : nextSourceName(value, status?.ingresses.map((i) => i.name) || []),
    );
    setForm(f);
    setAuth(preset?.httpsAuth ?? "bearer");
    setErrors({});
  }
  function validate() {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t("fieldRequired");
    else if (new TextEncoder().encode(name).length > 120)
      next.name = t("sourceNameTooLong");
    if (selected === "custom" && !/^[a-zA-Z0-9_-]+$/.test(source))
      next.source = t("validClientId");
    if (!https) {
      if (!/^tunnel_[a-zA-Z0-9_-]+$/.test(form.tunnelId))
        next.tunnelId = t("validTunnelId");
      if (!form.apiKey.trim() && !ingress?.config.hasApiKey)
        next.apiKey = t("fieldRequired");
    } else {
      if (fixedDomain(form) && !validDomain(form.domain))
        next.domain = t("validDomain");
      const key = provider.credential;
      if (
        needsCredential(form) &&
        key &&
        !form[key].trim() &&
        !credentialSaved(ingress?.config, key)
      )
        next[key] = t("fieldRequired");
    }
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() =>
        formRef.current
          ?.querySelector<HTMLElement>("[aria-invalid=true]")
          ?.focus(),
      );
      return false;
    }
    return true;
  }
  async function save() {
    if (working || !validate()) return;
    setWorking(true);
    setError("");
    try {
      const config: Record<string, unknown> = { ...form };
      delete config.connectionMode;
      delete config.domain;
      const origin = fixedDomain(form) ? `https://${form.domain.trim()}` : "";
      config.httpsUrl = origin ? `${origin}/mcp` : "";
      config.ngrokEndpoint = form.httpsProvider === "ngrok" ? origin : "";
      if (!ingress) {
        delete config.httpsPort;
        delete config.httpsHost;
      }
      for (const { key } of secretFields) if (!config[key]) delete config[key];
      const bearer = https && auth === "bearer";
      const metadata = {
        toolPolicy,
        name: name.trim(),
        controlSource: selected === "custom" ? source : selected,
        auth: https ? auth : "openai",
        ...(bearer && ingress?.auth !== "bearer"
          ? {
              bearerToken: Array.from(
                crypto.getRandomValues(new Uint8Array(32)),
                (byte) => byte.toString(16).padStart(2, "0"),
              ).join(""),
            }
          : {}),
      };
      const saved = await api<Ingress>(
        ingress ? `ingress/${ingress.id}` : "ingress",
        ingress ? "PUT" : "POST",
        { ...metadata, transport: https ? "https" : "openai-tunnel", config },
      );
      await refreshConnector().catch(() => {});
      onSaved(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }
  async function remove() {
    if (!ingress || working) return;
    setWorking(true);
    setError("");
    try {
      await api(`ingress/${ingress.id}`, "DELETE");
      await refreshConnector();
      onRemoved();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }
  const textField = (
    key: keyof ConnectionForm,
    label: string,
    password = false,
    placeholder = "",
    help?: ReactNode,
  ) => (
    <Field
      id={`ingress-${key}`}
      label={label}
      help={help}
      error={errors[key]}
    >
      <Input
        className={key === "tunnelId" || secretFields.some(field => field.key === key) ? "mono" : undefined}
        id={`ingress-${key}`}
        aria-invalid={!!errors[key]}
        aria-describedby={errors[key] ? `ingress-${key}-error` : undefined}
        type={password ? "password" : "text"}
        autoComplete={password ? "new-password" : "off"}
        value={String(form[key])}
        onChange={(e) => change(key, e.target.value as never)}
        placeholder={placeholder}
        disabled={working}
      />
    </Field>
  );
  return (
    <Dialog
      initialFocus={focusField ? `ingress-${focusField}` : undefined}
      title={`${t(ingress ? "editControlSource" : "addControlSource")}${selected ? " · " + (preset?.displayName || t("customControlSource")) : ""}`}
      onClose={() => !ingress && selected ? setSelected("") : onClose()}
      onDismiss={onClose}
      depthOffset={!ingress && selected ? 1 : 0}
      leading={!ingress && selected ? <IconButton icon={ChevronLeft} label={t("back")} disabled={working} onClick={() => setSelected("")} /> : undefined}
      width={!selected ? 480 : undefined}
      busy={working}
      footer={
        selected && (
          <>
            {ingress && (
              <Button
                variant="danger"
                disabled={working}
                onClick={() => void remove()}
              >
                {t("remove")}
              </Button>
            )}
            <span className="spacer" />
            <DialogClose asChild>
              <Button disabled={working}>{t("cancel")}</Button>
            </DialogClose>
            <Button
              variant="primary"
              busy={working}
              onClick={() => void save()}
            >
              {t("save")}
            </Button>
          </>
        )
      }
    >
      {!selected ? (
        <div className="source-choices" ref={pickerRef}>
          {[
            ...curatedSources.map((p) => ({
              value: p.id,
              label: p.displayName,
            })),
            { value: "custom", label: t("customControlSource") },
          ].map((option) => (
            <Button
              key={option.value}
              data-source={option.value}
              variant="ghost"
              onClick={() => choose(option.value)}
            >
              <SourceIcon
                platform={option.value}
                add={option.value === "custom"}
              />
              <span>{option.label}</span>
            </Button>
          ))}
        </div>
      ) : (
        <form
          onChangeCapture={e => { const id = (e.target as HTMLElement).id; if (id.startsWith("ingress-")) dirty.current.add(id.slice(8)); }}
          className="form"
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          noValidate
        >
          {https &&
            auth === "bearer" &&
            preset &&
            !preset.supportedAuth.includes("bearer") && (
              <Notice tone="warning">{t("presetAuthMismatch")}</Notice>
            )}
          <Field
            id="ingress-name"
            label={t("sourceName")}
            help={preset?.docs[0] && <a className="form-subtitle" href={preset.docs[0]} onClick={(e) => { e.preventDefault(); void openUrl(preset.docs[0]!).catch(e => setError(String(e))); }}>{t("officialSetup")}</a>}
            error={errors.name}
          >
            <Input
              id="ingress-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setErrors((old) => ({ ...old, name: "" }));
              }}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? "ingress-name-error" : undefined}
              disabled={working}
            />
          </Field>
          {selected === "custom" && (
            <Field
              id="ingress-source"
              label={t("controlSourceId")}
              error={errors.source}
            >
              <Input
                className="mono"
                id="ingress-source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                aria-invalid={!!errors.source}
                aria-describedby={
                  errors.source ? "ingress-source-error" : undefined
                }
                disabled={working}
              />
            </Field>
          )}
          {allowTunnel && (
            <Field label={t("connectionMethod")}>
              <SingleChoice
                value={form.connectionMode}
                onChange={(value) =>
                  change(
                    "connectionMode",
                    value as ConnectionForm["connectionMode"],
                  )
                }
                label={t("connectionMethod")}
                disabled={working}
                options={[
                  { value: "tunnel", label: "OpenAI Secure Tunnel" },
                  { value: "https", label: "HTTPS MCP" },
                ]}
              />
            </Field>
          )}
          {!https ? (
            <>
              {textField(
                "tunnelId",
                "Tunnel ID",
                false,
                "tunnel_…",
<a href="https://platform.openai.com/settings/organization/tunnels" onClick={(e) => { e.preventDefault(); void openUrl(e.currentTarget.href).catch(e => setError(String(e))); }}>{t("getCredentials")}</a>,
              )}
              {textField(
                "apiKey",
                "Runtime API Key",
                true,
                ingress?.config.hasApiKey
                  ? t("savedLeaveBlankToKeep")
                  : t("pasteRuntimeKey"),
                <a href="https://platform.openai.com/settings/organization/api-keys" onClick={(e) => { e.preventDefault(); void openUrl(e.currentTarget.href).catch(e => setError(String(e))); }}>{t("getApiKey")}</a>,
              )}
            </>
          ) : (
            <>
              <Field
                label={t("connectionMethod") + (allowTunnel ? "" : " · HTTPS MCP")}
              >
                <SingleChoice
                  value={form.httpsProvider}
                  onChange={(value) =>
                    change(
                      "httpsProvider",
                      value as ConnectionForm["httpsProvider"],
                    )
                  }
                  label={t("connectionMethod")}
                  disabled={working}
                  options={Object.entries(providers).map(([value, p]) => ({
                    value,
                    label: value === "custom" ? t("customDomain") : p.label,
                  }))}
                />
              </Field>
              {provider.mode && provider.modes.length > 1 && (
                <Field label={t("domainMode")}>
                  <SingleChoice
                    value={form[provider.mode]}
                    onChange={(value) =>
                      change(provider.mode!, value as "named" | "quick")
                    }
                    label={t("domainMode")}
                    disabled={working}
                    options={provider.modes.map((value) => ({
                      value,
                      label: t(
                        value === "named" ? "fixedDomain" : "temporaryDomain",
                      ),
                    }))}
                  />
                </Field>
              )}
              {form.httpsProvider === "cloudflare" && form.cloudflareAuth === "login" && <Notice>{t("setup.cloudflare-managed")}</Notice>}
              {needsCredential(form) &&
                provider.credential &&
                textField(
                  provider.credential,
                  provider.credentialLabel,
                  true,
                  credentialSaved(ingress?.config, provider.credential)
                    ? t("savedLeaveBlankToKeep")
                    : t("pasteCredential", { provider: provider.label, credential: provider.credentialLabel }),
                  provider.help && <a href={provider.help} onClick={(e) => { e.preventDefault(); void openUrl(provider.help!).catch(e => setError(String(e))); }}>{t("getCredentials")}</a>,
                )}
              {fixedDomain(form) &&
                textField("domain", t("domain"), false, "mcp.example.com")}
              <Field label={t("authentication")}>
                <SingleChoice
                  value={auth}
                  onChange={value => { dirty.current.add("auth"); setAuth(value); }}
                  label={t("authentication")}
                  disabled={working}
                  options={[
                    { value: "none", label: t("authNone") },
                    { value: "bearer", label: "Bearer" },
                    { value: "oauth", label: "OAuth" },
                  ]}
                />
              </Field>
            </>
          )}
          <ToolPolicyField
            value={toolPolicy}
            onChange={value => { dirty.current.add("toolPolicy"); setToolPolicy(value); }}
            disabled={working}
          />
          {error && <Notice>{displayMessage(error)}</Notice>}
        </form>
      )}
    </Dialog>
  );
}

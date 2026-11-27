import { ChevronLeft } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { api } from "../api";
import { nextSourceName } from "../controlSources";
import { connectionDomain, validDomain } from "../formRules";
import { t } from "../i18n";
import {
  credentialSaved,
  fixedDomain,
  needsCredential,
  providers,
  secretFields,
} from "../ingressConfig";
import { displayMessage } from "../messages";
import { openUrl } from "../platform";
import { connectionForm, type ConnectionForm } from "../state/connectionForm";
import { connector, refreshConnector } from "../state/connector";
import type { Ingress } from "../state/types";
import type { ToolPolicy } from "../toolPolicy";
import { IngressFormView } from "./connectivity/IngressFormView";
import { Button, IconButton } from "./kit/button";
import { Field } from "./kit/field";
import { Input } from "./kit/input";
import { SensitiveInput, useSensitiveText } from "./Sensitive";
import ToolPolicyField from "./ToolPolicyField";
import { Dialog, DialogClose } from "./ui";
import { useDialogCompletion } from "./ui/Dialog";
import { PanelFooter, PanelHeader, usePanelState } from "./ui/Panel";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";

export default function IngressDialog({
  ingress: initialIngress,
  initialTransport,
  initialProvider,
  focusField,
  onClose,
  onSaved,
  onRemoved,
  embedded = false,
  onBusy,
  onDirty,
  setupFormId,
}: {
  initialTransport?: "https" | "openai-tunnel";
  initialProvider?: "custom";
  embedded?: boolean;
  onBusy?: (busy: boolean) => void;
  onDirty?: (dirty: boolean) => void;
  setupFormId?: string;
  ingress?: Ingress;
  focusField?: string;
  onClose: () => void;
  onSaved: (ingress: Ingress) => void;
  onRemoved: () => void;
}) {
  const completion = useDialogCompletion(onClose);
  const { status } = connector.use();
  const ingress =
    status?.ingresses.find((item) => item.id === initialIngress?.id) ??
    initialIngress;
  const dirty = useRef(new Set<string>());
  const [name, setName] = useState(
    ingress?.name ||
      nextSourceName(
        t(
          initialTransport === "openai-tunnel"
            ? "source.kind.openai"
            : initialProvider === "custom"
              ? "connect.customAddress"
              : "source.kind.tunnel",
        ),
        status?.ingresses.map((item) => item.name) ?? [],
      ),
  );
  const [form, setForm] = useState(() => {
    const next = connectionForm(ingress?.config);
    if (ingress) {
      next.connectionMode =
        ingress.transport === "openai-tunnel" ? "tunnel" : "https";
    }
    if (!ingress && initialTransport) {
      next.connectionMode =
        initialTransport === "openai-tunnel" ? "tunnel" : "https";
    }
    if (!ingress && setupFormId && initialTransport === "https") {
      next.httpsProvider = "cloudflare";
      next.cloudflareMode = "named";
    }
    if (!ingress && initialProvider) next.httpsProvider = initialProvider;
    return next;
  });
  const [auth, setAuth] = useState(
    ingress?.auth === "oauth"
      ? "oauth"
      : ingress?.auth === "bearer"
        ? "bearer"
        : ingress?.auth === "none"
          ? "none"
          : "oauth",
  );
  const [toolPolicy, setToolPolicy] = useState<ToolPolicy | undefined>(
    ingress?.toolPolicy,
  );
  const draft = useSubmittedDirty(
    { name, form, auth, toolPolicy },
    dirty.current.size > 0,
  );
  const protect = useSensitiveText([
    form.domain,
    form.tunnelId,
    ...secretFields.map((field) => String(form[field.key])),
  ]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!ingress) return;
    const incoming = connectionForm(ingress.config);
    incoming.connectionMode =
      ingress.transport === "openai-tunnel" ? "tunnel" : "https";
    setForm((old) => {
      const next = { ...old };
      for (const key of Object.keys(incoming) as (keyof ConnectionForm)[]) {
        if (!dirty.current.has(key)) {
          Object.assign(next, { [key]: incoming[key] });
        }
      }
      return next;
    });
    if (!dirty.current.has("name")) setName(ingress.name);
    if (!dirty.current.has("auth")) {
      setAuth(
        ingress.auth === "oauth"
          ? "oauth"
          : ingress.auth === "bearer"
            ? "bearer"
            : "none",
      );
    }
    if (!dirty.current.has("toolPolicy")) setToolPolicy(ingress.toolPolicy);
    setErrors((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => dirty.current.has(key)),
      ),
    );
  }, [ingress]);

  const formRef = useRef<HTMLFormElement>(null);
  const provider = providers[form.httpsProvider];
  const https = form.connectionMode === "https";
  const allowTunnel = !setupFormId;

  function change<K extends keyof ConnectionForm>(
    key: K,
    value: ConnectionForm[K],
  ) {
    dirty.current.add(key);
    if (
      [
        "connectionMode",
        "httpsProvider",
        "cloudflareMode",
        "ngrokMode",
        "pinggyMode",
        "localxposeMode",
      ].includes(key)
    ) {
      dirty.current.add("domain");
    }
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

  function validate() {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t("fieldRequired");
    else if (new TextEncoder().encode(name).length > 120) {
      next.name = t("sourceNameTooLong");
    }
    if (!https) {
      if (!/^tunnel_[a-zA-Z0-9_-]+$/.test(form.tunnelId)) {
        next.tunnelId = t("validTunnelId");
      }
      if (!form.apiKey.trim() && !ingress?.config.hasApiKey) {
        next.apiKey = t("fieldRequired");
      }
    } else {
      if (fixedDomain(form) && !validDomain(connectionDomain(form.domain))) {
        next.domain = t("validDomain");
      }
      const key = provider.credential;
      if (
        needsCredential(form) &&
        key &&
        !form[key].trim() &&
        !credentialSaved(ingress?.config, key)
      ) {
        next[key] = t("fieldRequired");
      }
    }
    setErrors(next);
    if (Object.keys(next).length) {
      if (formRef.current?.querySelector("details")) {
        formRef.current.querySelector("details")!.open = true;
      }
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
    draft.submit();
    setWorking(true);
    setError("");
    try {
      const config: Record<string, unknown> = { ...form };
      delete config.connectionMode;
      delete config.domain;
      const origin = fixedDomain(form)
        ? `https://${connectionDomain(form.domain)}`
        : "";
      config.httpsUrl = origin ? `${origin}/mcp` : "";
      config.ngrokEndpoint = form.httpsProvider === "ngrok" ? origin : "";
      if (!ingress) {
        delete config.httpsPort;
        delete config.httpsHost;
      }
      for (const { key } of secretFields) {
        if (!config[key]) delete config[key];
      }
      const bearer = https && auth === "bearer";
      const metadata = {
        ...(!ingress ? { toolPolicy } : {}),
        name: name.trim(),
        ...(!ingress ? { controlSource: https ? "custom" : "chatgpt" } : {}),
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
      dirty.current.clear();
      onDirty?.(false);
      onSaved(saved);
      if (!embedded && !setupFormId) await completion.finish();
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

  useEffect(() => {
    onBusy?.(working);
    return () => onBusy?.(false);
  }, [working, onBusy]);

  useEffect(() => {
    onDirty?.(draft.dirty);
  }, [draft.dirty, onDirty]);

  const credentialHelp = (url: string, label: string) =>
    setupFormId ? (
      <Button
        variant="ghost"
        size="xs"
        onClick={() => void openUrl(url).catch((e) => setError(String(e)))}
      >
        {label}
      </Button>
    ) : (
      <a
        href={url}
        className="text-meta font-medium text-accent-text hover:underline"
        onClick={(event) => {
          event.preventDefault();
          void openUrl(url).catch((e) => setError(String(e)));
        }}
      >
        {label}
      </a>
    );

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
      helpPlacement={setupFormId ? "label" : "end"}
      error={errors[key]}
    >
      <SensitiveInput
        className={
          !setupFormId &&
          (key === "tunnelId" ||
            secretFields.some((field) => field.key === key))
            ? "mono"
            : undefined
        }
        id={`ingress-${key}`}
        aria-invalid={!!errors[key]}
        aria-describedby={errors[key] ? `ingress-${key}-error` : undefined}
        type={password ? "password" : "text"}
        autoComplete={password ? "new-password" : "off"}
        value={String(form[key])}
        onChange={(event) => change(key, event.target.value as never)}
        onPaste={
          key === "domain"
            ? (event) => {
                const domain = connectionDomain(
                  event.clipboardData.getData("text"),
                );
                if (validDomain(domain)) {
                  event.preventDefault();
                  change(key, domain as never);
                }
              }
            : undefined
        }
        onBlur={
          key === "domain"
            ? () => change(key, connectionDomain(form.domain) as never)
            : undefined
        }
        placeholder={placeholder}
        disabled={working}
        required={key === "domain" || key === "tunnelId"}
      />
    </Field>
  );

  const nameField = (
    <Field
      id="ingress-name"
      label={t("setup.connectionName")}
      error={errors.name}
    >
      <Input
        id="ingress-name"
        required
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setErrors((old) => ({ ...old, name: "" }));
        }}
        aria-invalid={!!errors.name}
        aria-describedby={errors.name ? "ingress-name-error" : undefined}
        disabled={working}
      />
    </Field>
  );

  const Frame = setupFormId
    ? IngressSetupBody
    : embedded
      ? IngressEditLayer
      : Dialog;

  return (
    <Frame
      layerId={completion.layerId}
      dirty={draft.dirty}
      initialFocus={focusField ? `ingress-${focusField}` : undefined}
      title={t(ingress ? "source.editConnection" : "source.newConnection")}
      onClose={onClose}
      busy={working}
      footer={
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
          {embedded ? (
            <Button onClick={onClose}>{t("cancel")}</Button>
          ) : (
            <DialogClose asChild>
              <Button>{t("cancel")}</Button>
            </DialogClose>
          )}
          <Button
            variant="primary"
            busy={working}
            onClick={() => void save()}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <form
        onChangeCapture={(event) => {
          const id = (event.target as HTMLElement).id;
          if (id.startsWith("ingress-")) dirty.current.add(id.slice(8));
        }}
        id={setupFormId}
        className="min-w-0"
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <IngressFormView
          setupLayout={Boolean(setupFormId)}
          disabled={working}
          topNameField={nameField}
          setupNameField={nameField}
          connectionMode={
            allowTunnel
              ? {
                  label: t("connectionMethod"),
                  value: form.connectionMode,
                  onChange: (value) =>
                    change(
                      "connectionMode",
                      value as ConnectionForm["connectionMode"],
                    ),
                  options: [
                    { value: "tunnel", label: "OpenAI Secure Tunnel" },
                    { value: "https", label: "HTTPS MCP" },
                  ],
                }
              : undefined
          }
          https={https}
          tunnelFields={
            <>
              {textField(
                "tunnelId",
                "Tunnel ID",
                false,
                "tunnel_…",
                credentialHelp(
                  "https://platform.openai.com/settings/organization/tunnels",
                  t("getCredentials"),
                ),
              )}
              {textField(
                "apiKey",
                "Runtime API Key",
                true,
                ingress?.config.hasApiKey
                  ? t("savedLeaveBlankToKeep")
                  : t("pasteRuntimeKey"),
                credentialHelp(
                  "https://platform.openai.com/settings/organization/api-keys",
                  t("getApiKey"),
                ),
              )}
            </>
          }
          httpsProvider={{
            label: t("connectionMethod") + (allowTunnel ? "" : " · HTTPS MCP"),
            ariaLabel: t("connectionMethod"),
            value: form.httpsProvider,
            onChange: (value) =>
              change(
                "httpsProvider",
                value as ConnectionForm["httpsProvider"],
              ),
            options: Object.entries(providers).map(([value, entry]) => ({
              value,
              label: value === "custom" ? t("customDomain") : entry.label,
            })),
          }}
          domainMode={
            provider.mode && provider.modes.length > 1
              ? {
                  label: t("domainMode"),
                  value: form[provider.mode],
                  onChange: (value) =>
                    change(provider.mode!, value as "named" | "quick"),
                  options: provider.modes.map((value) => ({
                    value,
                    label: t(
                      value === "named" ? "fixedDomain" : "temporaryDomain",
                    ),
                  })),
                }
              : undefined
          }
          cloudflareManagedNotice={
            form.httpsProvider === "cloudflare" &&
            form.cloudflareAuth === "login"
              ? t("setup.cloudflare-managed")
              : undefined
          }
          domainField={
            fixedDomain(form)
              ? textField("domain", t("domain"), false, "mcp.example.com")
              : undefined
          }
          credentialField={
            needsCredential(form) && provider.credential
              ? textField(
                  provider.credential,
                  provider.credentialLabel,
                  true,
                  credentialSaved(ingress?.config, provider.credential)
                    ? t("savedLeaveBlankToKeep")
                    : t("pasteCredential", {
                        provider: provider.label,
                        credential: provider.credentialLabel,
                      }),
                  provider.help &&
                    credentialHelp(provider.help, t("getCredentials")),
                )
              : undefined
          }
          authentication={{
            label: t("authentication"),
            value: auth,
            onChange: (value) => {
              dirty.current.add("auth");
              setAuth(value);
            },
            options: [
              { value: "none", label: t("authNone") },
              { value: "bearer", label: "Bearer" },
              { value: "oauth", label: "OAuth" },
            ],
          }}
          toolPolicyField={
            !ingress ? (
              <ToolPolicyField
                value={toolPolicy}
                onChange={(value) => {
                  dirty.current.add("toolPolicy");
                  setToolPolicy(value);
                }}
                disabled={working}
              />
            ) : undefined
          }
          error={error ? protect(displayMessage(error)) : undefined}
        />
      </form>
    </Frame>
  );
}

function IngressEditLayer({
  title,
  children,
  footer,
  onClose,
  initialFocus,
  busy,
  dirty,
  leading,
  actions,
}: ComponentProps<typeof Dialog>) {
  usePanelState({ dirty, busy });
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const target = initialFocus
        ? root.current?.querySelector<HTMLElement>(
            `#${CSS.escape(initialFocus)}`,
          )
        : root.current?.querySelector<HTMLElement>("h2");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialFocus]);
  return (
    <section className="ingress-edit-layer side-panel-layer" ref={root}>
      <PanelHeader>
        <header
          className="dialog-header"
          data-leading={leading === null ? "false" : "true"}
        >
          {leading === undefined ? (
            <IconButton
              icon={ChevronLeft}
              label={t("back")}
              disabled={busy}
              onClick={onClose}
            />
          ) : (
            leading
          )}
          <h2 className="activity-panel-title" tabIndex={-1}>
            {title}
          </h2>
          {actions && <div className="actions">{actions}</div>}
        </header>
      </PanelHeader>
      <div className="side-panel-scroll">{children}</div>
      <PanelFooter>{footer}</PanelFooter>
    </section>
  );
}

function IngressSetupBody({ children }: ComponentProps<typeof Dialog>) {
  return <>{children}</>;
}

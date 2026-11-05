import { useEffect, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { connector } from "../state/connector";
import { onboarding, openConnectionSetup } from "../state/onboarding";
import { permissions, permissionsReady } from "../state/permissions";
import { navigation } from "../state/navigation";
import { isPendingSource } from "../sourcePresentation";
import type { Login } from "../state/types";
import AddControlSource from "./AddControlSource";
import { Button, Notice, Status, WelcomeChoice, WelcomeStatusAction } from "./ui";

export default function Onboarding({ returnFocus }: { returnFocus?: string }) {
  const flow = onboarding.use()!, { status, sources, sourcesLoaded } = connector.use(); permissions.use();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [login, setLogin] = useState("loading");
  useEffect(() => {
    if (flow.step === "welcome" && sourcesLoaded && status && sources.some(s => s.state !== "revoked" && !isPendingSource(s, status.ingresses))) onboarding.set(undefined);
  }, [flow.step, sourcesLoaded, sources, status]);
  useEffect(() => {
    if (flow.step !== "welcome") return;
    const read = () => { void api<Login>("codex/login").then(v => setLogin(v.state)).catch(() => setLogin("unavailable")); };
    read(); window.addEventListener("focus", read); return () => window.removeEventListener("focus", read);
  }, [flow.step]);
  async function signIn() {
    setBusy(true); setError("");
    try { await api("codex/login", "POST"); setLogin((await api<Login>("codex/login")).state); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  if (flow.step !== "welcome") return <AddControlSource returnFocus={returnFocus} />;
  return <section className="welcome-page" aria-labelledby="welcome-title">
    <img className="welcome-mark" src={new URL("../assets/arc/mark.svg", import.meta.url).href} alt="ARC" />
    <h1 id="welcome-title">{t("setup.welcomeTitle")}</h1>
    {error && <Notice>{error}</Notice>}
    <div className="welcome-cards">{(["local", "remote"] as const).map(group => <WelcomeChoice key={group}
      icon={group === "local" ? Monitor : Smartphone} tone={group === "local" ? "command" : "accent"}
      title={t(`setup.welcome.${group}`)} description={t(`setup.welcome.${group}Products`)} meta={t(`setup.welcome.${group}Time`)}
      onClick={() => onboarding.set({ step: "product", focusGroup: group })} />)}</div>
    <footer className="welcome-readiness"><Status tone={login === "authenticated" && permissionsReady(status?.ingresses ?? []) ? "success" : "warning"}>
      <WelcomeStatusAction busy={busy} onClick={() => login === "authenticated" ? (onboarding.set(undefined), navigation.set(old => ({ ...old, page: "settings" }))) : void signIn()}>{t(login === "authenticated" ? "connect.codexReady" : "connect.codexFix")}</WelcomeStatusAction>
      <span aria-hidden="true"> · </span>
      <WelcomeStatusAction onClick={() => { onboarding.set(undefined); navigation.set(old => ({ ...old, page: "permissions" })); }}>{t(permissionsReady(status?.ingresses ?? []) ? "connect.permissionsReady" : "connect.permissionsFix")}</WelcomeStatusAction>
    </Status>
      <Button variant="ghost" onClick={() => openConnectionSetup({ method: "join" })}>{t("setup.invite")}</Button>
    </footer>
  </section>;
}

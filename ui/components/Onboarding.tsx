import { Monitor, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { isPendingSource } from "../sourcePresentation";
import { connector } from "../state/connector";
import { navigation } from "../state/navigation";
import { onboarding, openConnectionSetup } from "../state/onboarding";
import { permissions, permissionsReady } from "../state/permissions";
import type { Login } from "../state/types";
import AddControlSource from "./AddControlSource";
import { WelcomeView } from "./connectivity/WelcomeView";
import { SetupWelcome } from "./onboarding/SetupAppearance";
import { WelcomeStatusAction } from "./onboarding/WelcomeChoice";

export default function Onboarding({ returnFocus }: { returnFocus?: string }) {
  const flow = onboarding.use()!;
  const { status, sources, sourcesLoaded } = connector.use();
  permissions.use();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [login, setLogin] = useState("loading");

  useEffect(() => {
    if (
      flow.step === "welcome" &&
      sourcesLoaded &&
      status &&
      sources.some(
        (source) =>
          source.state !== "revoked" &&
          !isPendingSource(source, status.ingresses),
      )
    ) {
      onboarding.set(undefined);
    }
  }, [flow.step, sourcesLoaded, sources, status]);

  useEffect(() => {
    if (flow.step !== "welcome") return;
    const read = () => {
      void api<Login>("codex/login")
        .then((value) => setLogin(value.state))
        .catch(() => setLogin("unavailable"));
    };
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [flow.step]);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      await api("codex/login", "POST");
      setLogin((await api<Login>("codex/login")).state);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (flow.step !== "welcome") {
    return <AddControlSource returnFocus={returnFocus} />;
  }

  const ready =
    login === "authenticated" && permissionsReady(status?.ingresses ?? []);

  return (
    <SetupWelcome aria-labelledby="welcome-title">
      <WelcomeView
        mark={
          <img
            className="size-16"
            src={new URL("../assets/arc/mark.svg", import.meta.url).href}
            alt="ARC"
          />
        }
        title={t("setup.welcomeTitle")}
        titleId="welcome-title"
        error={error || undefined}
        choices={(["local", "remote"] as const).map((group) => ({
          id: group,
          icon: group === "local" ? Monitor : Smartphone,
          tone: group === "local" ? "command" : "accent",
          title: t(`setup.welcome.${group}`),
          description: t(`setup.welcome.${group}Products`),
          meta: t(`setup.welcome.${group}Time`),
          onClick: () => onboarding.set({ step: "product", focusGroup: group }),
        }))}
        status={{
          ready,
          statusContent: (
            <>
              <WelcomeStatusAction
                busy={busy}
                onClick={() =>
                  login === "authenticated"
                    ? (onboarding.set(undefined),
                      navigation.set((old) => ({ ...old, page: "settings" })))
                    : void signIn()
                }
              >
                {t(
                  login === "authenticated"
                    ? "connect.codexReady"
                    : "connect.codexFix",
                )}
              </WelcomeStatusAction>
              <span aria-hidden="true" className="text-text-tertiary">
                ·
              </span>
              <WelcomeStatusAction
                onClick={() => {
                  onboarding.set(undefined);
                  navigation.set((old) => ({ ...old, page: "permissions" }));
                }}
              >
                {t(
                  permissionsReady(status?.ingresses ?? [])
                    ? "connect.permissionsReady"
                    : "connect.permissionsFix",
                )}
              </WelcomeStatusAction>
            </>
          ),
          inviteLabel: t("setup.invite"),
          onInvite: () => openConnectionSetup({ method: "join" }),
        }}
      />
    </SetupWelcome>
  );
}

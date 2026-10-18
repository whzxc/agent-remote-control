import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { locale, t } from "../i18n";
import { useInterval } from "../state/hooks";
import { Button, Empty, Notice } from "./ui";
type Grant = {
  id: string;
  clientName: string;
  clientId: string;
  connectedAt: number | null;
  registeredAt: number | null;
};
export default function OAuthGrants({
  ingressId,
  running,
  disabled,
  onBusy,
}: {
  ingressId: string;
  running: boolean;
  disabled?: boolean;
  onBusy: (value: boolean) => void;
}) {
  const [grants, setGrants] = useState<Grant[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      revision.current++;
    };
  }, []);
  async function refresh(afterAction = false) {
    if (busy && !afterAction) return;
    if (!running) {
      setGrants([]);
      setError("");
      return;
    }
    const version = revision.current;
    try {
      const result = await api<{ grants: Grant[] }>(
        `ingress/${ingressId}/oauth`,
      );
      if (alive.current && version === revision.current) {
        setGrants(result.grants);
        setError("");
      }
    } catch (e) {
      if (alive.current && version === revision.current) setError(String(e));
    }
  }
  useInterval(() => void refresh(), 3000, true);
  useEffect(() => {
    void refresh();
  }, [running]);
  async function action(route: string, body: object) {
    if (busy || disabled || !running) return;
    revision.current++;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await api(`ingress/${ingressId}/oauth/${route}`, "POST", body);
      await refresh(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section className="oauth-grants">
      <h3>OAuth</h3>
      {grants.map((grant) => {
        const timestamp = grant.connectedAt ?? grant.registeredAt;
        const date = timestamp == null ? null : new Date(timestamp * 1000);
        return (
          <div className="oauth-grant-row" key={grant.id}>
            <strong className="oauth-grant-name" title={grant.clientName}>{grant.clientName}</strong>
            <span className="muted small oauth-grant-time" title={t(grant.connectedAt == null ? "oauthRegisteredAt" : "oauthConnectedAt")}>
              {date ? (
                <time dateTime={date.toISOString()}>
                  {date.toLocaleString(locale.get(), { hour12: false })}
                </time>
              ) : t("oauthTimeUnknown")}
            </span>
            <Button
              disabled={busy || disabled || !running}
              onClick={() => void action("revoke", { id: grant.id })}
            >
              {t("oauthRevoke")}
            </Button>
          </div>
        );
      })}
      {!grants.length && !error && (
        <Empty>{t("oauthNoGrants")}</Empty>
      )}
      {error && <Notice>{error}</Notice>}
    </section>
  );
}

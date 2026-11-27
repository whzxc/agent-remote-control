import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { BrandMark, Button, ConfirmDialog, Dialog, Notice, Switch } from "../components/ui";
import { Card } from "../components/ui/card";
import { DialogActions, useDialogCompletion } from "../components/ui/Dialog";
import Panel from "../components/ui/Panel";
import { SettingLine } from "../components/ui/Settings";
import { useSubmittedDirty } from "../components/ui/useSubmittedDirty";
import { locale, t } from "../i18n";
import { relativeTime } from "../lib/relativeTime";
import { icons, name as agentName } from "../state/agents";
import { focusNodeTasks } from "../state/homepage";
import type { LayerRect } from "../state/layers";
import { DeviceFacts } from "./DeviceFacts";
import { DeviceDetailView } from "./DeviceFactsView";
import {
  DeviceAddressFormView,
  DeviceMemberView,
  DevicePairFormView,
  DeviceRevokeCopyView,
} from "./DeviceLinkView";
import {
  cancelDevicePair,
  connectDevice,
  deviceError,
  deviceOffer,
  devicePair,
  deviceSnapshot,
  deviceView,
  memberOutcome,
  pairedDevices,
  refreshDevices,
  setControllerSources,
  type Device,
  type Peer,
} from "./state";
import { deviceTasks } from "./tasks";

const c = (key: string, params?: Record<string, unknown>) =>
  t(`device.${key}`, params);

function formatDevicePath(device: Device) {
  const elapsed = device.lastSeen ? Date.now() - Date.parse(device.lastSeen) : NaN;
  const seen =
    elapsed >= 60000 && elapsed < 3600000
      ? c("minutesAgo", { minutes: Math.round(elapsed / 60000) })
      : relativeTime(device.lastSeen, Date.now(), locale.get(), c("now"));
  return `${device.state === "offline" ? `${c("lastPath")}: ` : ""}${c(device.path === "lan" ? "lan" : "tunnelPath")}${device.latency !== null ? ` · ${device.latency} ms` : ""} · ${c("lastSeen")} ${seen || c("none")}`;
}

function PairDialog({ close }: { close: () => void }) {
  const pair = devicePair.use();
  const snapshot = deviceSnapshot.use();
  const input = useRef<HTMLInputElement>(null);
  const waiting = pair.state === "waiting";
  const success = pair.state === "success";
  const error = !["input", "waiting", "success"].includes(pair.state);
  const dismiss = () => {
    if (devicePair.get().state === "success") {
      devicePair.set({ state: "input", input: "" });
    }
    close();
  };

  useEffect(() => {
    if (error) input.current?.focus();
  }, [pair.state, error]);

  const member =
    pair.memberId &&
    pairedDevices(snapshot).find((device) => device.id === pair.memberId);

  return (
    <Dialog
      title={c("add")}
      className="device-dialog"
      onClose={dismiss}
      dirty={pair.state === "input" && Boolean(pair.input)}
      busy={waiting}
      onCancel={waiting ? cancelDevicePair : undefined}
      returnFocus="[data-device-pair-add]"
    >
      <DevicePairFormView
        state={pair.state}
        input={pair.input}
        memberName={pair.name}
        controllerName={snapshot?.name}
        controllerFingerprint={snapshot?.deviceId}
        memberStatusLabel={
          member
            ? `${c(member.state)} · ${c(member.path === "lan" ? "lan" : "tunnelPath")}${member.latency !== null ? ` · ${member.latency} ms` : ""}`
            : undefined
        }
        errorText={pair.error}
        errorCode={pair.error?.match(/DEVICE_[A-Z_]+/)?.[0]}
        inputRef={input}
        onInputChange={(value) => devicePair.set({ state: "input", input: value })}
        onSubmit={(event) => {
          event.preventDefault();
          if (!waiting && !success) void connectDevice();
        }}
        footer={
          <DialogActions className="device-actions">
            <Button
              variant="primary"
              busy={waiting}
              type={success ? "button" : "submit"}
              onClick={success ? dismiss : undefined}
            >
              {success ? c("done") : waiting ? c("waiting") : c("pair")}
            </Button>
          </DialogActions>
        }
      />
    </Dialog>
  );
}

function AddressDialog({ device, close }: { device: Device; close: () => void }) {
  const [value, setValue] = useState(device.addressOverride || "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const completion = useDialogCompletion(close);
  const draft = useSubmittedDirty(value, value !== (device.addressOverride || ""));

  async function save(address: string | null) {
    draft.submit();
    setBusy(true);
    setError("");
    try {
      await api("device/address", "POST", { device: device.id, address });
      await refreshDevices();
      await completion.finish();
    } catch (err) {
      setError(String(err));
      requestAnimationFrame(() => input.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      layerId={completion.layerId}
      title={c("override")}
      className="device-dialog"
      onClose={close}
      busy={busy}
      dirty={draft.dirty}
    >
      <DeviceAddressFormView
        deviceName={device.name}
        value={value}
        error={error || undefined}
        inputRef={input}
        onChange={setValue}
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) {
            setError(c("overrideInvalid"));
            input.current?.focus();
            return;
          }
          void save(value.trim());
        }}
        footer={
          <DialogActions className="device-actions">
            <Button disabled={busy} onClick={() => void save(null)}>
              {c("clear")}
            </Button>
            <Button variant="primary" type="submit" busy={busy}>
              {c("save")}
            </Button>
          </DialogActions>
        }
      />
    </Dialog>
  );
}

function RevokeDialog({
  peer,
  memberSide,
  close,
}: {
  peer: Peer;
  memberSide: boolean;
  close: () => void;
}) {
  const completion = useDialogCompletion(() =>
    deviceView.set({ side: memberSide ? "member" : "controller" }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function revoke() {
    setBusy(true);
    setError("");
    try {
      await api("device/revoke", "POST", { deviceId: peer.deviceId });
      await refreshDevices();
      await completion.finish();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      layerId={completion.layerId}
      returnFocus="[data-device-add]"
      title={c(memberSide ? "revokeMemberTitle" : "revokeTitle", {
        name: peer.name,
      })}
      className="device-dialog"
      onClose={close}
      busy={busy}
      actionsClassName="device-actions"
      confirmLabel={c("revoke")}
      onConfirm={revoke}
    >
      <DeviceRevokeCopyView
        peerName={peer.name}
        memberSide={memberSide}
        error={error || undefined}
      />
    </ConfirmDialog>
  );
}

export default function DeviceNodePanel({
  onPanelFrame,
}: {
  onPanelFrame?: (rect: LayerRect | null) => void;
} = {}) {
  const snapshot = deviceSnapshot.use();
  const error = deviceError.use();
  const view = deviceView.use();
  const offer = deviceOffer.use();
  const outcome = memberOutcome.use();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const devices = pairedDevices(snapshot);
  const detail = devices.find((device) => device.id === view.detail);
  const remote = deviceTasks.use();
  const selectedAgent =
    detail &&
    remote[detail.id]?.snapshot?.availableAgents.find(
      (agent) => agent.agent === view.agent,
    );
  const upstream = snapshot?.controller?.upstreamSources?.find(
    (source) => source.sourceId === view.upstreamSource,
  );
  const controller =
    view.side === "member" && view.detail === snapshot?.controller?.deviceId;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const close = () =>
    deviceView.set((old) => ({ ...old, dialog: undefined, revoke: undefined }));

  async function act(action: "offer" | "approve" | "decline") {
    setBusy(true);
    setActionError("");
    try {
      const result = await api<{
        pairingString?: string;
        expiresInSeconds: number;
      }>(`device/${action}`, "POST");
      if (result.pairingString) {
        deviceOffer.set({
          pairingString: result.pairingString,
          expiresAt: Date.now() + result.expiresInSeconds * 1000,
        });
      }
      if (action !== "offer") {
        deviceOffer.set(undefined);
        memberOutcome.set(action === "decline" ? "declined" : undefined);
      } else {
        memberOutcome.set(undefined);
      }
      await refreshDevices();
    } catch (err) {
      setActionError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function showSources(show: boolean) {
    setBusy(true);
    setActionError("");
    try {
      await setControllerSources(show);
    } catch (err) {
      setActionError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const offerSeconds = offer
    ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1000))
    : 0;
  const nodeId = view.upstreamSource
    ? `upstream:${view.upstreamSource}`
    : `device:${view.detail}${view.agent ? `:agent:${view.agent}` : ""}`;

  return (
    <>
      {(detail || controller || view.detail === "pairing") && (
        <Panel
          size="m"
          title={
            selectedAgent
              ? `${detail!.name} · ${agentName(selectedAgent)}`
              : upstream?.sourceLabel ??
                detail?.name ??
                (controller ? snapshot?.controller?.name : c("deviceLink"))
          }
          returnFocus={
            view.detail === "pairing"
              ? ".hub-device-link"
              : `[data-node-id="${CSS.escape(nodeId)}"] [data-layer-switcher]`
          }
          className="device-node-panel"
          onPanelFrame={onPanelFrame}
          busy={busy}
          onClose={() => deviceView.set({ side: view.side })}
        >
          <div className="flex min-w-0 flex-col gap-5">
            {view.detail === "pairing" && (
              <div>
                <Button
                  data-device-pair-add
                  variant="primary"
                  onClick={() =>
                    deviceView.set((old) => ({ ...old, dialog: "pair" }))
                  }
                >
                  <Plus size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                  <span>{c("add")}</span>
                </Button>
              </div>
            )}

            {detail && remote[detail.id]?.error && (
              <Notice layout="inline">{remote[detail.id].error}</Notice>
            )}
            {(error || actionError) && (
              <Notice layout="inline">{error || actionError}</Notice>
            )}

            {selectedAgent && detail ? (
              <DeviceFacts variant="detail" className="flex flex-col gap-4">
                <DeviceFacts
                  variant="identity"
                  className="flex min-w-0 items-center gap-3"
                >
                  <BrandMark markup={icons[selectedAgent.agent]} size={28} />
                  <strong className="text-body font-semibold text-foreground">
                    {agentName(selectedAgent)}
                  </strong>
                </DeviceFacts>
                <p className="m-0 text-small text-text-secondary">
                  {selectedAgent.version}
                </p>
                <div>
                  <Button
                    onClick={() => {
                      deviceView.set({ side: "controller" });
                      focusNodeTasks({
                        id: `device:${detail.id}:agent:${selectedAgent.agent}`,
                        deviceId: detail.id,
                        agent: selectedAgent.agent,
                        label: `${detail.name} · ${agentName(selectedAgent)}`,
                      });
                    }}
                  >
                    {t("homepage.tasks")}
                  </Button>
                </div>
              </DeviceFacts>
            ) : detail ? (
              <DeviceDetailView
                device={detail}
                pathLabel={formatDevicePath(detail)}
                onEditOverride={() =>
                  deviceView.set((old) => ({ ...old, dialog: "address" }))
                }
                onRevoke={() =>
                  deviceView.set((old) => ({
                    ...old,
                    dialog: "revoke",
                    revoke: detail,
                  }))
                }
              />
            ) : (
              <DeviceMemberView
                controller={snapshot?.controller}
                pending={snapshot?.pending}
                offer={offer}
                offerSeconds={offerSeconds}
                deviceId={snapshot?.deviceId}
                outcome={outcome}
                showUpstreamSources={snapshot?.controller?.showUpstreamSources}
                showUpstreamToggle={Boolean(controller)}
                upstreamSlot={
                  <Card className="p-0">
                    <SettingLine title={t("homepage.upstreamSources")}>
                      <Switch
                        label={t("homepage.upstreamSources")}
                        checked={snapshot?.controller?.showUpstreamSources === true}
                        disabled={busy}
                        onChange={(show) => void showSources(show)}
                      />
                    </SettingLine>
                  </Card>
                }
                busy={busy}
                onOffer={() => void act("offer")}
                onApprove={() => void act("approve")}
                onDecline={() => void act("decline")}
                onRevokeController={() => {
                  if (snapshot?.controller) {
                    deviceView.set((old) => ({
                      ...old,
                      dialog: "revoke",
                      revoke: snapshot.controller!,
                    }));
                  }
                }}
                onToggleUpstreamSources={(show) => void showSources(show)}
              />
            )}
          </div>
        </Panel>
      )}
      {view.dialog === "pair" && <PairDialog close={close} />}
      {view.dialog === "address" && detail && (
        <AddressDialog device={detail} close={close} />
      )}
      {view.dialog === "revoke" && view.revoke && (
        <RevokeDialog
          peer={view.revoke}
          memberSide={view.side === "member"}
          close={close}
        />
      )}
    </>
  );
}

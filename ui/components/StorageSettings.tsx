import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { preference } from "../state/store";
import { Button, Dialog, Notice, SingleChoice, Switch } from "./ui";
import { SettingsSection as Group, Setting as Row } from "./ui/Settings";

interface StorageHotCategory {
  files: number;
  bytes: number;
  archivable?: number;
  compressible?: number;
  prunable?: number;
  capacity?: number;
}

interface StorageStatus {
  hot: {
    receipts: StorageHotCategory;
    coordination: StorageHotCategory;
    dispatches: StorageHotCategory;
    changes: StorageHotCategory;
    notifications: StorageHotCategory;
    controlMetrics: StorageHotCategory;
    outputs: StorageHotCategory;
  };
  archives: { files: number; bytes: number };
  legacy: { files: number; bytes: number; directories: Record<string, { files: number; bytes: number }> };
  warnings?: string[];
}

interface StorageArchiveResult {
  applied: boolean;
  categories: Record<string, { eligible?: number; archived?: number; compressed?: number; pruned?: number; bytes?: number }>;
}

interface StoragePruneResult {
  applied: boolean;
  olderThanDays: number;
  includeLegacy: boolean;
  archives: { eligible: number; removed: number; bytes: number };
  legacy: { directories: string[]; removed: number; bytes: number };
}

const archiveRetentionPreference = preference("archive-retention-days", "0", value => value, value => value);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function StorageSettings() {
  const retention = archiveRetentionPreference.use();
  const [status, setStatus] = useState<StorageStatus>();
  const [archiving, setArchiving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone?: "danger" }>();
  const [pruneOpen, setPruneOpen] = useState(false);
  const [includeLegacy, setIncludeLegacy] = useState(true);
  const [prunePreview, setPrunePreview] = useState<StoragePruneResult>();
  const [loadingPreview, setLoadingPreview] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<StorageStatus>("storage/status"));
    } catch {
      /* Storage status is optional when Core is unavailable. */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadPrunePreview = useCallback(async (withLegacy: boolean) => {
    setLoadingPreview(true);
    try {
      const olderThanDays = Number(retention) > 0 ? Number(retention) : 90;
      setPrunePreview(await api<StoragePruneResult>("storage/prune", "POST", {
        apply: false,
        olderThanDays,
        includeLegacy: withLegacy,
      }));
    } catch (error) {
      setNotice({ message: String(error), tone: "danger" });
    } finally {
      setLoadingPreview(false);
    }
  }, [retention]);

  const hotFiles = status
    ? status.hot.receipts.files + status.hot.coordination.files + status.hot.dispatches.files +
      status.hot.changes.files + status.hot.notifications.files + status.hot.controlMetrics.files + status.hot.outputs.files
    : 0;
  const hotBytes = status
    ? status.hot.receipts.bytes + status.hot.coordination.bytes + status.hot.dispatches.bytes +
      status.hot.changes.bytes + status.hot.notifications.bytes + status.hot.controlMetrics.bytes + status.hot.outputs.bytes
    : 0;
  const archivableCount = status
    ? (status.hot.receipts.archivable ?? 0) + (status.hot.coordination.archivable ?? 0) +
      (status.hot.dispatches.archivable ?? 0) + (status.hot.changes.archivable ?? 0) +
      (status.hot.notifications.archivable ?? 0) + (status.hot.controlMetrics.compressible ?? 0) +
      (status.hot.outputs.prunable ?? 0)
    : 0;
  const highWater = !!status?.warnings?.includes("coordination-high-water");

  const archiveDescription = !status
    ? t("storage.loading")
    : highWater
      ? t("storage.archiveDescriptionHighWater", {
          files: hotFiles,
          size: formatBytes(hotBytes),
          archivable: archivableCount,
          coordFiles: status.hot.coordination.files,
          coordCap: status.hot.coordination.capacity ?? 8192,
        })
      : t("storage.archiveDescription", {
          files: hotFiles,
          size: formatBytes(hotBytes),
          archivable: archivableCount,
        });

  const cleanupDescription = !status
    ? t("storage.loading")
    : status.legacy.bytes > 0 || status.archives.bytes > 0
      ? t("storage.cleanupDescription", {
          archives: formatBytes(status.archives.bytes),
          legacy: formatBytes(status.legacy.bytes),
        })
      : t("storage.cleanupEmpty");

  async function handleArchiveNow() {
    if (archiving) return;
    setArchiving(true);
    setNotice(undefined);
    try {
      const result = await api<StorageArchiveResult>("storage/archive", "POST", { apply: true });
      let moved = 0;
      for (const entry of Object.values(result.categories || {})) {
        moved += (entry.archived ?? 0) + (entry.compressed ?? 0) + (entry.pruned ?? 0);
      }
      await refresh();
      setNotice({ message: t("storage.archivedNotice", { count: moved }) });
    } catch (error) {
      setNotice({ message: String(error), tone: "danger" });
    } finally {
      setArchiving(false);
    }
  }

  function openPruneDialog() {
    setPruneOpen(true);
    void loadPrunePreview(includeLegacy);
  }

  async function handleApplyPrune() {
    if (pruning) return;
    const olderThanDays = Number(retention) > 0 ? Number(retention) : 90;
    setPruning(true);
    setNotice(undefined);
    try {
      const result = await api<StoragePruneResult>("storage/prune", "POST", {
        apply: true,
        olderThanDays,
        includeLegacy,
      });
      setPruneOpen(false);
      await refresh();
      const freed = formatBytes((result.archives?.bytes ?? 0) + (result.legacy?.bytes ?? 0));
      setNotice({ message: t("storage.prunedNotice", { size: freed }) });
    } catch (error) {
      setNotice({ message: String(error), tone: "danger" });
    } finally {
      setPruning(false);
    }
  }

  const pruneTotalBytes = (prunePreview?.archives.bytes ?? 0) + (prunePreview?.legacy.bytes ?? 0);
  const pruneHasItems = (prunePreview?.archives.eligible ?? 0) > 0 || (prunePreview?.legacy.directories.length ?? 0) > 0;

  return (
    <>
      <Group title={t("storage.title")}>
        {notice && <Notice tone={notice.tone}>{notice.message}</Notice>}
        <Row title={t("storage.localArchive")} description={archiveDescription} width="auto">
          <Button
            variant="primary"
            busy={archiving}
            disabled={!status || archivableCount === 0}
            onClick={() => void handleArchiveNow()}
          >
            {t("storage.archiveNow")}
          </Button>
        </Row>
        <Row title={t("storage.retention")} description={t("storage.retentionDescription")} width={180}>
          <SingleChoice
            dropdown
            fill
            label={t("storage.retention")}
            value={retention}
            onChange={value => archiveRetentionPreference.set(value)}
            options={[
              { value: "0", label: t("storage.retentionForever") },
              { value: "30", label: t("storage.retentionDays", { days: 30 }) },
              { value: "90", label: t("storage.retentionDays", { days: 90 }) },
              { value: "180", label: t("storage.retentionDays", { days: 180 }) },
            ]}
          />
        </Row>
        <Row title={t("storage.cleanup")} description={cleanupDescription} width="auto">
          <Button
            variant="secondary"
            disabled={!status || pruning}
            onClick={openPruneDialog}
          >
            {t("storage.previewCleanup")}
          </Button>
        </Row>
      </Group>
      {pruneOpen && (
        <Dialog
          open={pruneOpen}
          busy={pruning || loadingPreview}
          title={t("storage.pruneDialogTitle")}
          description={t("storage.pruneDialogDescription")}
          onClose={() => setPruneOpen(false)}
          actions={
            <>
              <Button variant="ghost" disabled={pruning} onClick={() => setPruneOpen(false)}>
                {t("cancel")}
              </Button>
              <Button
                variant="danger"
                busy={pruning}
                disabled={loadingPreview || !pruneHasItems}
                onClick={() => void handleApplyPrune()}
              >
                {t("storage.confirmPrune")}
              </Button>
            </>
          }
        >
          <div className="settings-stack">
            <Row
              title={t("storage.includeLegacy")}
              description={t("storage.includeLegacyDescription")}
              toggle
            >
              <Switch
                label={t("storage.includeLegacy")}
                checked={includeLegacy}
                disabled={pruning || loadingPreview}
                onChange={value => {
                  setIncludeLegacy(value);
                  void loadPrunePreview(value);
                }}
              />
            </Row>
            <Row
              title={t("storage.pruneSummaryTitle")}
              description={
                loadingPreview || !prunePreview
                  ? t("storage.loading")
                  : pruneHasItems
                    ? t("storage.pruneSummary", {
                        archives: prunePreview.archives.eligible,
                        legacyDirs: prunePreview.legacy.directories.join(", ") || t("none"),
                        size: formatBytes(pruneTotalBytes),
                      })
                    : t("storage.pruneNothing")
              }
            >
              <span />
            </Row>
          </div>
        </Dialog>
      )}
    </>
  );
}

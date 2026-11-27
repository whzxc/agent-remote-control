import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { preference } from "../state/store";
import { Button } from "./kit/button";
import {
  StoragePruneDialogBodyView,
  StorageSettingsView,
} from "./settings/StorageSettingsView";
import { Dialog } from "./ui";
import { Setting, SettingsSection } from "./ui/Settings";

interface StorageHotCategory {
  files: number;
  bytes: number;
  archivable?: number;
  compressible?: number;
  prunable?: number;
  prunableBytes?: number;
  capacity?: number;
}

interface StorageStatus {
  policy?: {
    outputsMaxAgeDays?: number;
    archiveRetentionDays?: number;
  };
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
  legacy: {
    files: number;
    bytes: number;
    directories: Record<string, { files: number; bytes: number }>;
  };
  warnings?: string[];
}

interface StorageArchiveResult {
  applied: boolean;
  categories: Record<
    string,
    { eligible?: number; archived?: number; compressed?: number; bytes?: number }
  >;
  summary?: {
    eligibleArchive?: number;
    archived?: number;
    eligibleCompress?: number;
    compressed?: number;
  };
}

interface StoragePruneResult {
  applied: boolean;
  olderThanDays: number;
  includeLegacy: boolean;
  includeOutputs: boolean;
  archives: { eligible: number; removed: number; bytes: number };
  outputs?: { eligible: number; removed: number; bytes: number };
  legacy: { directories: string[]; removed: number; bytes: number };
}

const archiveRetentionPreference = preference(
  "archive-retention-days",
  "0",
  (value) => value,
  (value) => value,
);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function StorageSettings() {
  const retention = archiveRetentionPreference.use();
  const [status, setStatus] = useState<StorageStatus>();
  const [archiving, setArchiving] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone?: "danger" }>();
  const [pruneOpen, setPruneOpen] = useState(false);
  const [includeOutputs, setIncludeOutputs] = useState(true);
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

  const loadPrunePreview = useCallback(
    async (withLegacy: boolean, withOutputs: boolean) => {
      setLoadingPreview(true);
      try {
        const olderThanDays = Number(retention) > 0 ? Number(retention) : 90;
        setPrunePreview(
          await api<StoragePruneResult>("storage/prune", "POST", {
            apply: false,
            olderThanDays,
            includeLegacy: withLegacy,
            includeOutputs: withOutputs,
          }),
        );
      } catch (error) {
        setNotice({ message: String(error), tone: "danger" });
      } finally {
        setLoadingPreview(false);
      }
    },
    [retention],
  );

  const outputsMaxAgeDays = status?.policy?.outputsMaxAgeDays ?? 7;
  const hotFiles = status
    ? status.hot.receipts.files +
      status.hot.coordination.files +
      status.hot.dispatches.files +
      status.hot.changes.files +
      status.hot.notifications.files +
      status.hot.controlMetrics.files +
      status.hot.outputs.files
    : 0;
  const hotBytes = status
    ? status.hot.receipts.bytes +
      status.hot.coordination.bytes +
      status.hot.dispatches.bytes +
      status.hot.changes.bytes +
      status.hot.notifications.bytes +
      status.hot.controlMetrics.bytes +
      status.hot.outputs.bytes
    : 0;
  const archivableCount = status
    ? (status.hot.receipts.archivable ?? 0) +
      (status.hot.coordination.archivable ?? 0) +
      (status.hot.dispatches.archivable ?? 0) +
      (status.hot.changes.archivable ?? 0) +
      (status.hot.notifications.archivable ?? 0)
    : 0;
  const compressibleCount = status
    ? (status.hot.controlMetrics.compressible ?? 0)
    : 0;
  const losslessReadyCount = archivableCount + compressibleCount;
  const expiredOutputsCount = status ? (status.hot.outputs.prunable ?? 0) : 0;
  const expiredOutputsBytes = status
    ? (status.hot.outputs.prunableBytes ?? 0)
    : 0;
  const highWater = !!status?.warnings?.includes("coordination-high-water");

  const archiveDescription = !status
    ? t("storage.loading")
    : highWater
      ? t("storage.archiveDescriptionHighWater", {
          files: hotFiles,
          size: formatBytes(hotBytes),
          archivable: archivableCount,
          compressible: compressibleCount,
          coordFiles: status.hot.coordination.files,
          coordCap: status.hot.coordination.capacity ?? 8192,
        })
      : t("storage.archiveDescription", {
          files: hotFiles,
          size: formatBytes(hotBytes),
          archivable: archivableCount,
          compressible: compressibleCount,
        });

  const cleanupDescription = !status
    ? t("storage.loading")
    : status.legacy.bytes > 0 ||
        status.archives.bytes > 0 ||
        expiredOutputsCount > 0
      ? t("storage.cleanupDescription", {
          archives: formatBytes(status.archives.bytes),
          days: outputsMaxAgeDays,
          outputs: expiredOutputsCount,
          outputsSize: formatBytes(expiredOutputsBytes),
          legacy: formatBytes(status.legacy.bytes),
        })
      : t("storage.cleanupEmpty");

  async function handleArchiveNow() {
    if (archiving) return;
    setArchiving(true);
    setNotice(undefined);
    try {
      const result = await api<StorageArchiveResult>("storage/archive", "POST", {
        apply: true,
      });
      let archived = result.summary?.archived ?? 0;
      let compressed = result.summary?.compressed ?? 0;
      if (!result.summary) {
        for (const entry of Object.values(result.categories || {})) {
          archived += entry.archived ?? 0;
          compressed += entry.compressed ?? 0;
        }
      }
      await refresh();
      setNotice({
        message: t("storage.archivedNotice", { archived, compressed }),
      });
    } catch (error) {
      setNotice({ message: String(error), tone: "danger" });
    } finally {
      setArchiving(false);
    }
  }

  function openPruneDialog() {
    setPruneOpen(true);
    void loadPrunePreview(includeLegacy, includeOutputs);
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
        includeOutputs,
      });
      setPruneOpen(false);
      await refresh();
      const freed = formatBytes(
        (result.archives?.bytes ?? 0) +
          (result.outputs?.bytes ?? 0) +
          (result.legacy?.bytes ?? 0),
      );
      setNotice({
        message: t("storage.prunedNotice", {
          archives: result.archives?.removed ?? 0,
          outputs: result.outputs?.removed ?? 0,
          legacy: result.legacy?.removed ?? 0,
          size: freed,
        }),
      });
    } catch (error) {
      setNotice({ message: String(error), tone: "danger" });
    } finally {
      setPruning(false);
    }
  }

  const pruneTotalBytes =
    (prunePreview?.archives.bytes ?? 0) +
    (prunePreview?.outputs?.bytes ?? 0) +
    (prunePreview?.legacy.bytes ?? 0);
  const pruneHasItems =
    (prunePreview?.archives.eligible ?? 0) > 0 ||
    (prunePreview?.outputs?.eligible ?? 0) > 0 ||
    (prunePreview?.legacy.directories.length ?? 0) > 0;
  const pruneSummaryText =
    loadingPreview || !prunePreview
      ? t("storage.loading")
      : pruneHasItems
        ? t("storage.pruneSummary", {
            archives: prunePreview.archives.eligible,
            outputs: prunePreview.outputs?.eligible ?? 0,
            legacyDirs: prunePreview.legacy.directories.join(", ") || t("none"),
            size: formatBytes(pruneTotalBytes),
          })
        : t("storage.pruneNothing");

  return (
    <>
      <StorageSettingsView
        archiveDescription={archiveDescription}
        cleanupDescription={cleanupDescription}
        outputsMaxAgeDays={outputsMaxAgeDays}
        retention={retention}
        onRetentionChange={(value) => archiveRetentionPreference.set(value)}
        archiving={archiving}
        archiveDisabled={!status || losslessReadyCount === 0}
        onArchiveNow={() => void handleArchiveNow()}
        cleanupDisabled={!status || pruning}
        onOpenCleanup={openPruneDialog}
        notice={notice}
      />
      {pruneOpen && (
        <Dialog
          open={pruneOpen}
          busy={pruning || loadingPreview}
          title={t("storage.pruneDialogTitle")}
          description={t("storage.pruneDialogDescription")}
          onClose={() => setPruneOpen(false)}
          actions={
            <>
              <Button
                variant="ghost"
                disabled={pruning}
                onClick={() => setPruneOpen(false)}
              >
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
          <StoragePruneDialogBodyView
            outputsMaxAgeDays={outputsMaxAgeDays}
            includeOutputs={includeOutputs}
            includeLegacy={includeLegacy}
            disabled={pruning || loadingPreview}
            summaryText={pruneSummaryText}
            Section={SettingsSection}
            Row={Setting}
            onIncludeOutputsChange={(value) => {
              setIncludeOutputs(value);
              void loadPrunePreview(includeLegacy, value);
            }}
            onIncludeLegacyChange={(value) => {
              setIncludeLegacy(value);
              void loadPrunePreview(value, includeOutputs);
            }}
          />
        </Dialog>
      )}
    </>
  );
}

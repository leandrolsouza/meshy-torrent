import { access, stat } from 'fs/promises';
import { constants } from 'fs';
import type { DownloadDiagnostic, DownloadItem } from '../shared/types';
import type { DownloadManager } from './downloadManager';
import type { DownloadDiagnosticsEngine } from './enginePorts';

/** Observações locais; ausência de peers não permite concluir que o torrent não tem seeders. */
export function createDownloadDiagnostics(options: {
    manager: DownloadManager;
    engine: DownloadDiagnosticsEngine;
    now?: () => number;
    isFolderAvailable?: (folder: string) => Promise<boolean>;
    disableTimer?: boolean;
}) {
    const folders = new Map<string, boolean>();
    const progress = new Map<string, { bytes: number; advancedAt: number }>();
    let checking = false;
    let disposed = false;
    const available =
        options.isFolderAvailable ??
        (async (folder: string) => {
            try {
                await access(folder, constants.R_OK | constants.W_OK);
                return (await stat(folder)).isDirectory();
            } catch {
                return false;
            }
        });
    const refresh = async () => {
        if (checking || disposed) return;
        checking = true;
        try {
            const paths = new Set(options.manager.getAll().map((item) => item.destinationFolder));
            for (const folder of folders.keys()) if (!paths.has(folder)) folders.delete(folder);
            await Promise.all(
                [...paths].map(async (folder) => {
                    try {
                        const result = await available(folder);
                        if (!disposed) folders.set(folder, result);
                    } catch {
                        if (!disposed) folders.delete(folder);
                    }
                }),
            );
        } catch {
            /* Mantém observações anteriores quando o snapshot está indisponível. */
        } finally {
            checking = false;
        }
    };
    const enrich = (items: DownloadItem[]): DownloadItem[] => {
        const now = options.now?.() ?? Date.now();
        const hashes = new Set(items.map((item) => item.infoHash));
        for (const hash of progress.keys()) if (!hashes.has(hash)) progress.delete(hash);
        return items.map((item) => {
            const previous = progress.get(item.infoHash);
            if (
                !previous ||
                previous.bytes !== item.downloadedSize ||
                item.status !== 'downloading'
            )
                progress.set(item.infoHash, { bytes: item.downloadedSize, advancedAt: now });
            let diagnostic: DownloadDiagnostic | undefined;
            if (!item.fileOperation && item.status !== 'completed') {
                if (item.pauseReason === 'disk-space') diagnostic = 'disk-space';
                else if (folders.get(item.destinationFolder) === false)
                    diagnostic = 'folder-unavailable';
                else if (item.status === 'metadata-failed') diagnostic = 'metadata-failed';
                else if (item.status === 'queued') diagnostic = 'queued';
                else if (item.status === 'resolving-metadata') diagnostic = 'metadata';
                else if (item.status === 'downloading') {
                    if (item.selectedFileCount === 0) diagnostic = 'no-selection';
                    else if (item.numPeers === 0) {
                        let failedTrackers = false;
                        try {
                            const trackers = options.engine.getTrackers(item.infoHash);
                            failedTrackers =
                                trackers.length > 0 &&
                                trackers.every((tracker) => tracker.status === 'error');
                        } catch {
                            /* Tracker indisponível não comprova falha. */
                        }
                        diagnostic = failedTrackers ? 'trackers-error' : 'no-peers';
                    } else if (
                        item.downloadSpeed === 0 &&
                        now - progress.get(item.infoHash)!.advancedAt >= 30_000
                    )
                        diagnostic = 'stalled';
                }
            }
            const snapshot = { ...item };
            delete snapshot.diagnostic;
            if (diagnostic) snapshot.diagnostic = diagnostic;
            return snapshot;
        });
    };
    const timer = options.disableTimer ? undefined : setInterval(() => void refresh(), 5000);
    timer?.unref();
    return {
        refresh,
        enrich,
        dispose() {
            disposed = true;
            clearInterval(timer);
            folders.clear();
            progress.clear();
        },
    };
}
export type DownloadDiagnostics = ReturnType<typeof createDownloadDiagnostics>;

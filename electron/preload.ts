import { contextBridge, ipcRenderer } from 'electron';
import { parseTraceContext } from '../shared/traceContext';
import type { TraceContext } from '../shared/traceContext';
import { MAX_TORRENT_BYTES } from '../shared/torrentLimits';
import { ErrorCodes } from '../shared/errorCodes';
import type {
    DownloadItem,
    AppSettings,
    IPCResponse,
    TorrentFileInfo,
    TrackerInfo,
    TorrentMetadata,
    PeerInfo,
    PieceStatus,
    MeshyAPI,
    TorrentErrorEvent,
} from '../shared/types';

// ─── Expose API via contextBridge ────────────────────────────────────────────

// Metadados são separados dos payloads de negócio e não expõem canais arbitrários.
function invoke<T>(
    channel: string,
    payload?: unknown,
    parent?: TraceContext,
): Promise<IPCResponse<T>> {
    const randomId = (bytes: number): string =>
        Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
            byte.toString(16).padStart(2, '0'),
        ).join('');
    const safeParent = parseTraceContext(parent);
    const context: TraceContext = {
        traceId: safeParent?.traceId ?? randomId(16),
        spanId: randomId(8),
        ...(safeParent ? { parentSpanId: safeParent.spanId } : {}),
    };
    return ipcRenderer.invoke(channel, payload, context);
}

const meshyAPI: MeshyAPI = {
    getUpdateStatus: () => invoke('app:update-status'),
    checkForUpdates: () => invoke('app:check-updates'),
    installUpdate: () => invoke('app:install-update'),
    onUpdateStatus(callback) {
        const listener = (
            _event: Electron.IpcRendererEvent,
            status: import('../shared/types').AppUpdateStatus,
        ) => callback(status);
        ipcRenderer.on('app:update-status', listener);
        return () => ipcRenderer.removeListener('app:update-status', listener);
    },
    getBandwidthStatus: () => invoke('bandwidth:get-status'),
    setLightMode: (enabled) => invoke('bandwidth:set-light', { enabled }),
    batchAction: (infoHashes, operation, deleteFiles) =>
        invoke('torrent:batch-action', { infoHashes, operation, deleteFiles }),
    selectTorrentFiles: () => invoke('dialog:select-torrent-files'),
    manageFiles: (infoHash, operation, destinationFolder) =>
        invoke('torrent:manage-files', { infoHash, operation, destinationFolder }),
    getExternalTorrentRequests: () => invoke('app:get-external-torrents'),
    acknowledgeExternalTorrentRequest: (id) => invoke('app:acknowledge-external-torrent', { id }),
    registerMagnetHandler: () => invoke('app:register-magnet-handler'),
    getMagnetHandlerStatus: () => invoke('app:get-magnet-handler-status'),
    openMagnetDefaultApps: () => invoke('app:open-magnet-default-apps'),
    onExternalTorrentRequests(callback) {
        const listener = (
            _event: Electron.IpcRendererEvent,
            requests: import('../shared/types').ExternalTorrentRequest[],
        ) => callback(requests);
        ipcRenderer.on('app:external-torrents', listener);
        return () => ipcRenderer.removeListener('app:external-torrents', listener);
    },
    prepareTorrent: (requestId, source) => {
        if (source?.kind === 'buffer' && source.buffer?.byteLength > MAX_TORRENT_BYTES)
            return Promise.resolve({ success: false, error: ErrorCodes.INVALID_FILE_PATH });
        return invoke('torrent:prepare', { requestId, source });
    },
    cancelTorrentPreparation: (requestId) => invoke('torrent:cancel-preparation', { requestId }),
    getDiskSpace: (requestId, destinationFolder, selectedIndices) =>
        invoke('torrent:disk-space', { requestId, destinationFolder, selectedIndices }),
    confirmTorrent: (requestId, destinationFolder, selectedIndices) =>
        invoke('torrent:confirm', { requestId, destinationFolder, selectedIndices }),
    // ── Commands ────────────────────────────────────────────────────────────────

    addTorrentFile(filePath: string): Promise<IPCResponse<DownloadItem>> {
        return invoke('torrent:add-file', { filePath });
    },

    addTorrentFileBuffer(buffer: Uint8Array): Promise<IPCResponse<DownloadItem>> {
        // Evita copiar entradas grandes para o main; o handler também valida o limite.
        if (buffer?.byteLength > MAX_TORRENT_BYTES)
            return Promise.resolve({ success: false, error: ErrorCodes.INVALID_FILE_PATH });
        return invoke('torrent:add-file-buffer', { buffer });
    },

    addMagnetLink(magnetUri: string): Promise<IPCResponse<DownloadItem>> {
        return invoke('torrent:add-magnet', { magnetUri });
    },

    setSeedingEnabled(infoHash: string, enabled: boolean): Promise<IPCResponse<DownloadItem>> {
        return invoke('torrent:set-seeding-enabled', { infoHash, enabled });
    },
    pause(infoHash: string): Promise<IPCResponse<void>> {
        return invoke('torrent:pause', { infoHash });
    },

    resume(infoHash: string): Promise<IPCResponse<void>> {
        return invoke('torrent:resume', { infoHash });
    },

    remove(infoHash: string, deleteFiles: boolean): Promise<IPCResponse<void>> {
        return invoke('torrent:remove', { infoHash, deleteFiles });
    },

    getAll(): Promise<IPCResponse<DownloadItem[]>> {
        return invoke('torrent:get-all');
    },

    getSettings(): Promise<IPCResponse<AppSettings>> {
        return invoke('settings:get');
    },

    setSettings(partial: Partial<AppSettings>): Promise<IPCResponse<AppSettings>> {
        return invoke('settings:set', partial);
    },

    selectFolder(): Promise<IPCResponse<string>> {
        return invoke('settings:select-folder');
    },

    selectTorrentFile(): Promise<IPCResponse<string>> {
        return invoke('dialog:select-torrent-file');
    },

    // ── File Selection ──────────────────────────────────────────────────────────

    getFiles(infoHash: string): Promise<IPCResponse<TorrentFileInfo[]>> {
        return invoke('torrent:get-files', { infoHash });
    },

    setFileSelection(
        infoHash: string,
        selectedIndices: number[],
    ): Promise<IPCResponse<TorrentFileInfo[]>> {
        return invoke('torrent:set-file-selection', { infoHash, selectedIndices });
    },

    // ── Trackers (por torrent) ──────────────────────────────────────────────────

    getTrackers(infoHash: string): Promise<IPCResponse<TrackerInfo[]>> {
        return invoke('tracker:get', { infoHash });
    },

    addTracker(infoHash: string, url: string): Promise<IPCResponse<TrackerInfo[]>> {
        return invoke('tracker:add', { infoHash, url });
    },

    removeTracker(infoHash: string, url: string): Promise<IPCResponse<TrackerInfo[]>> {
        return invoke('tracker:remove', { infoHash, url });
    },

    applyGlobalTrackers(infoHash: string): Promise<IPCResponse<TrackerInfo[]>> {
        return invoke('tracker:apply-global', { infoHash });
    },

    // ── Retry ───────────────────────────────────────────────────────────────────

    retryDownload(infoHash: string): Promise<IPCResponse<DownloadItem>> {
        return invoke('torrent:retry', { infoHash });
    },

    // ── Trackers globais ────────────────────────────────────────────────────────

    getGlobalTrackers(): Promise<IPCResponse<string[]>> {
        return invoke('tracker:get-global');
    },

    addGlobalTracker(url: string): Promise<IPCResponse<string[]>> {
        return invoke('tracker:add-global', { url });
    },

    removeGlobalTracker(url: string): Promise<IPCResponse<string[]>> {
        return invoke('tracker:remove-global', { url });
    },

    // ── Destino — abrir pasta ou arquivo ────────────────────────────────────────

    openFolder(infoHash: string): Promise<IPCResponse<void>> {
        return invoke('torrent:open-folder', { infoHash });
    },

    openFile(infoHash: string): Promise<IPCResponse<void>> {
        return invoke('torrent:open-file', { infoHash });
    },

    // ── Fila de downloads — reordenação e consulta ─────────────────────────────

    reorderQueue(infoHash: string, newIndex: number): Promise<IPCResponse<string[]>> {
        return invoke('queue:reorder', { infoHash, newIndex });
    },

    getQueueOrder(): Promise<IPCResponse<string[]>> {
        return invoke('queue:get-order');
    },

    // ── Detalhes do torrent (painel de detalhes) ──────────────────────────────────

    getMetadata(infoHash: string): Promise<IPCResponse<TorrentMetadata>> {
        return invoke('torrent:get-metadata', { infoHash });
    },

    getPeers(infoHash: string): Promise<IPCResponse<PeerInfo[]>> {
        return invoke('torrent:get-peers', { infoHash });
    },

    getPieces(infoHash: string): Promise<IPCResponse<PieceStatus>> {
        return invoke('torrent:get-pieces', { infoHash });
    },

    // ── Events ──────────────────────────────────────────────────────────────────

    /**
     * Subscribes to torrent progress updates emitted by the main process every second.
     * Returns a cleanup function that removes the listener when called.
     */
    onProgress(callback: (items: DownloadItem[]) => void): () => void {
        const listener = (_event: Electron.IpcRendererEvent, items: DownloadItem[]) => {
            callback(items);
        };
        ipcRenderer.on('torrent:progress', listener);
        return () => {
            ipcRenderer.removeListener('torrent:progress', listener);
        };
    },

    /**
     * Subscribes to torrent error events emitted by the main process.
     * Returns a cleanup function that removes the listener when called.
     */
    onError(callback: (data: TorrentErrorEvent) => void): () => void {
        const listener = (_event: Electron.IpcRendererEvent, data: TorrentErrorEvent) => {
            callback(data);
        };
        ipcRenderer.on('torrent:error', listener);
        return () => {
            ipcRenderer.removeListener('torrent:error', listener);
        };
    },

    // ── Observabilidade ─────────────────────────────────────────────────────────

    /**
     * Reporta erros do renderer (ErrorBoundary, exceções não capturadas) ao main process
     * para persistência via electron-log. Fire-and-forget — não bloqueia a UI.
     */
    reportError(error: {
        message: string;
        source: string;
        stack?: string;
        componentStack?: string;
        traceContext?: TraceContext;
    }): void {
        const { traceContext, ...payload } = error;
        invoke('renderer:report-error', payload, traceContext).catch(() => {
            // Silenciar falhas no report — não queremos erros ao reportar erros
        });
    },

    /**
     * Retorna snapshot das métricas de operação do main process.
     * Útil para debugging e monitoramento.
     */
    getMetrics(): Promise<IPCResponse<Record<string, unknown>>> {
        return invoke('app:get-metrics');
    },
};

contextBridge.exposeInMainWorld('meshy', meshyAPI);

import { getOperationContext, runWithOperationContext } from './operationContext';
import type { OperationContext } from './operationContext';
import { traceOperation } from './tracing';
import { EventEmitter } from 'events';
import { existsSync, accessSync, constants as fsConstants } from 'fs';
import type { TorrentInfo } from './torrentEngine';
import type { DownloadManagerEngine } from './enginePorts';
import type { SettingsManager } from './settingsManager';
import type { DiskSpaceService } from './diskSpace';
import type { PreparedTorrent } from './torrentPreparation';
import { createTorrentFilesService, resolveTorrentFile } from './torrentFiles';
import type { TorrentFilesService, FileMove } from './torrentFiles';
import type { FileOperation } from '../shared/types';
import { ErrorCodes } from '../shared/errorCodes';
import type {
    DownloadItem,
    PersistedDownloadItem,
    TorrentFileInfo,
    TorrentStatus,
    DiskSpaceInfo,
    TorrentMetadata,
} from '../shared/types';
import { DEFAULT_MAX_CONCURRENT_DOWNLOADS } from '../shared/validators';
import { logger as defaultLogger } from './logger';
import type { Logger } from './logger';
import {
    createDownloadSessionRepository,
    serializePersistedDownloadItem,
    validatePersistedDownloadItem,
} from './downloadSession';
import type { DownloadSessionRepository, PersistedStore } from './downloadSession';

export type { DownloadItem, PersistedDownloadItem } from '../shared/types';

export interface DownloadQueueStats {
    activeDownloads: number;
    pendingAdds: number;
    occupiedSlots: number;
    maxConcurrentDownloads: number;
    queuedDownloads: number;
    activeSeeders: number;
    slotUtilization: number | null;
}

export interface DownloadManager {
    addPreparedTorrent(
        prepared: PreparedTorrent,
        destinationFolder: string,
        selectedIndices: number[],
    ): Promise<DownloadItem>;
    getDiskSpace(
        destinationFolder: string,
        selectedBytes: number,
        excludeHash?: string,
    ): Promise<DiskSpaceInfo>;
    checkDiskSpace(): Promise<void>;
    getFiles(infoHash: string): TorrentFileInfo[];
    manageFiles(
        infoHash: string,
        operation: FileOperation,
        destinationFolder?: string,
    ): Promise<DownloadItem>;
    addTorrentFile(filePath: string): Promise<DownloadItem>;
    addTorrentBuffer(buffer: Buffer): Promise<DownloadItem>;
    addMagnetLink(magnetUri: string): Promise<DownloadItem>;
    setSeedingEnabled(infoHash: string, enabled: boolean): Promise<DownloadItem>;
    applySeedingSettings(): Promise<void>;
    pause(infoHash: string): Promise<void>;
    resume(infoHash: string): Promise<void>;
    remove(infoHash: string, deleteFiles: boolean): Promise<void>;
    getAll(): DownloadItem[];
    /** Gauge operacional autoritativo; inclui reservas de adições pendentes. */
    getOperationalState(): DownloadQueueStats;
    setFileSelection(infoHash: string, selectedIndices: number[]): TorrentFileInfo[];
    restoreSession(): Promise<void>;
    persistSession(): void;
    /** Atualiza o limite de downloads simultâneos e processa a fila */
    setMaxConcurrentDownloads(max: number): void;
    /** Retenta um download que está em status 'error' ou 'metadata-failed' */
    retryDownload(infoHash: string): Promise<DownloadItem>;
    /** Reordena um item na fila de downloads */
    reorderQueue(infoHash: string, newIndex: number): string[];
    /** Retorna a ordem atual da fila */
    getQueueOrder(): string[];
    /** Retorna metadados em cache para um torrent concluído (disponível após restart sem engine) */
    getCachedMetadata(infoHash: string): TorrentMetadata | undefined;
    on(event: 'update', listener: (item: DownloadItem) => void): void;
    on(event: 'remove', listener: (infoHash: string) => void): void;
    removeListener(event: 'update', listener: (item: DownloadItem) => void): void;
    removeListener(event: 'remove', listener: (infoHash: string) => void): void;
}

export type { PersistedStore } from './downloadSession';

// ─── Helper ───────────────────────────────────────────────────────────────────

function torrentInfoToDownloadItem(
    info: TorrentInfo,
    destinationFolder: string,
    addedAt: number,
): DownloadItem {
    return {
        infoHash: info.infoHash,
        name: info.name,
        totalSize: info.totalSize,
        downloadedSize: info.downloaded,
        progress: info.progress,
        downloadSpeed: info.downloadSpeed,
        uploadSpeed: info.uploadSpeed,
        numPeers: info.numPeers,
        numSeeders: info.numSeeders,
        timeRemaining: info.timeRemaining,
        status: info.status,
        destinationFolder,
        addedAt,
    };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const METADATA_TIMEOUT_MS = 60_000;

/** Configuração de retry com exponential backoff */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000; // 1s, 4s, 16s (base^attempt²)

/** Intervalo de limpeza periódica de recursos órfãos (5 minutos) */
const ORPHAN_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;

// ─── Folder validation ────────────────────────────────────────────────────────

/**
 * Validates that the given folder path exists and is writable.
 * Throws an Error with a descriptive message if validation fails.
 */
function validateDestinationFolder(folderPath: string): void {
    if (!existsSync(folderPath)) {
        throw new Error('Pasta inválida ou sem permissão de escrita');
    }
    try {
        accessSync(folderPath, fsConstants.W_OK);
    } catch {
        throw new Error('Pasta inválida ou sem permissão de escrita');
    }
}

// ─── Implementation ───────────────────────────────────────────────────────────

class DownloadManagerImpl extends EventEmitter implements DownloadManager {
    private readonly items = new Map<string, DownloadItem>();
    /** Pending metadata-resolution timers keyed by infoHash */
    private readonly metadataTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Tracks selected file indices per torrent for persistence */
    private readonly selectedFileIndicesMap = new Map<string, number[]>();
    private readonly confirmedMetadata = new Map<string, Buffer>();
    private readonly fileCatalog = new Map<string, TorrentFileInfo[]>();
    private readonly _metadataCache = new Map<string, TorrentMetadata>();
    private readonly torrentFiles: TorrentFilesService;
    private readonly recoverMetadata: ((magnetUri: string) => Promise<PreparedTorrent>) | undefined;
    /** Fila ordenada de infoHashes aguardando slot de download */
    private readonly queue: string[] = [];
    /** Limite de downloads simultâneos */
    private maxConcurrent: number;
    private seedWork: Promise<void> = Promise.resolve();
    private readonly seedingSet = new Set<string>();
    private pendingAdds = 0;
    private readonly pendingHashes = new Set<string>();
    private readonly removingHashes = new Set<string>();
    /** Tracks magnet URIs for queued items that need to be added to the engine later */
    private readonly queuedContexts = new Map<string, OperationContext>();
    private readonly queuedMagnetUris = new Map<string, string>();
    /** Armazena o magnetUri original de todos os torrents adicionados via magnet link (para persistência) */
    private readonly originalMagnetUris = new Map<string, string>();
    private readonly engine: DownloadManagerEngine;
    private readonly settings: SettingsManager;
    private readonly sessionRepository: DownloadSessionRepository | undefined;
    /** Bloqueia snapshots parciais durante a restauração e após uma falha inesperada. */
    private sessionPersistenceBlocked = false;
    private readonly log: Logger;
    private readonly diskSpace: DiskSpaceService | undefined;
    private admission: Promise<unknown> = Promise.resolve();
    private checkingDisk = false;
    private processingDiskQueue = false;
    /** Timer de limpeza periódica de recursos órfãos */
    private readonly cleanupTimer: ReturnType<typeof setInterval> | null;
    /**
     * Lock por torrent para serializar operações de pause/resume.
     * Cada Promise representa a operação em andamento; a próxima operação
     * encadeia-se na anterior para evitar race conditions.
     */
    private readonly opLocks = new Map<string, Promise<unknown>>();

    constructor(
        engine: DownloadManagerEngine,
        settings: SettingsManager,
        store?: PersistedStore,
        log?: Logger,
        options?: {
            disableCleanupTimer?: boolean;
            diskSpace?: DiskSpaceService;
            torrentFiles?: TorrentFilesService;
            recoverMetadata?: (magnetUri: string) => Promise<PreparedTorrent>;
        },
    ) {
        super();
        // Evitar warnings de memory leak — o ipcHandler e notificationManager
        // registram listeners de 'update' e 'remove' por janela.
        this.setMaxListeners(0);
        this.engine = engine;
        this.torrentFiles = options?.torrentFiles ?? createTorrentFilesService();
        this.recoverMetadata = options?.recoverMetadata;
        this.settings = settings;
        this.log = log ?? defaultLogger;
        this.sessionRepository = store
            ? createDownloadSessionRepository(store, this.log)
            : undefined;
        this.diskSpace = options?.diskSpace;
        this.maxConcurrent =
            settings.get().maxConcurrentDownloads ?? DEFAULT_MAX_CONCURRENT_DOWNLOADS;

        // Limpeza periódica de recursos órfãos (5 minutos).
        // Desabilitável em testes para evitar interferência com fake timers.
        // unref() permite que o timer não impeça o encerramento do processo.
        if (options?.disableCleanupTimer) {
            this.cleanupTimer = null;
        } else {
            this.cleanupTimer = setInterval(
                () => this._cleanupOrphans(),
                ORPHAN_CLEANUP_INTERVAL_MS,
            );
            this.cleanupTimer.unref();
        }

        // Subscribe to engine events
        this.engine.on('restarting', () => {
            this.seedingSet.clear();
            for (const [hash, item] of this.items) {
                if (item.status === 'seeding')
                    this.items.set(hash, { ...item, status: 'completed' });
            }
            for (const hash of this.metadataTimers.keys()) this._clearMetadataTimer(hash);
        });
        this.engine.on('restarted', () => {
            this._scheduleSeeds();
            for (const item of this.items.values()) {
                if (item.status === 'resolving-metadata') this._startMetadataTimer(item.infoHash);
            }
            this._processQueue();
        });
        this.engine.on('progress', (info: TorrentInfo) => {
            const existing = this.items.get(info.infoHash);
            if (!existing || this.removingHashes.has(info.infoHash)) return;

            // Ignorar eventos de progresso para downloads já concluídos.
            // O WebTorrent continua emitindo 'download'/'upload' mesmo após
            // marcarmos como completed (porque o torrent inteiro pode não ter
            // terminado). Sem este guard, a detecção de conclusão por arquivos
            // selecionados dispara repetidamente.
            if (existing.status === 'completed') return;

            // Ignorar eventos de progresso para downloads pausados.
            // Após engine.pause() + destroyAllWires(), o WebTorrent pode
            // ainda emitir eventos residuais de 'download'/'upload'.
            // Sem este guard, o status 'paused' seria sobrescrito por 'downloading'.
            if (
                existing.status === 'paused' ||
                existing.status === 'queued' ||
                existing.status === 'metadata-failed' ||
                existing.status === 'error'
            )
                return;

            if (existing.status === 'seeding') {
                const updated = {
                    ...existing,
                    uploadSpeed: info.uploadSpeed,
                    numPeers: info.numPeers,
                    numSeeders: info.numSeeders,
                };
                this.items.set(info.infoHash, updated);
                this.emit('update', updated);
                return;
            }

            // Detect metadata resolution: resolving-metadata → downloading
            // When this transition happens, clear the 60s timeout and update
            // name + totalSize from the now-resolved metadata.
            const wasResolvingMetadata = existing.status === 'resolving-metadata';
            const isNowDownloading = info.status === 'downloading';

            if (wasResolvingMetadata && isNowDownloading) {
                this._clearMetadataTimer(info.infoHash);
                const selected = this.selectedFileIndicesMap.get(info.infoHash);
                if (selected) this.engine.setFileSelection(info.infoHash, selected);
            } else if (!wasResolvingMetadata && info.status === 'resolving-metadata') {
                this._startMetadataTimer(info.infoHash);
            }

            // Recalculate progress and totalSize based on selected files
            let totalSize =
                wasResolvingMetadata && isNowDownloading ? info.totalSize : existing.totalSize;
            let downloadedSize = info.downloaded;
            let progress = info.progress;
            let selectedFileCount = existing.selectedFileCount;
            let totalFileCount = existing.totalFileCount;

            try {
                const files = this.engine.getFiles(info.infoHash);
                if (files.length > 0) {
                    const selectedFiles = files.filter((f) => f.selected);
                    totalFileCount = files.length;
                    selectedFileCount = selectedFiles.length;

                    if (selectedFiles.length > 0) {
                        totalSize = selectedFiles.reduce((sum, f) => sum + f.length, 0);
                        downloadedSize = selectedFiles.reduce((sum, f) => sum + f.downloaded, 0);
                        progress = totalSize > 0 ? downloadedSize / totalSize : 0;
                    }
                }
            } catch {
                // getFiles pode falhar se o torrent ainda não está no engine (ex: resolving-metadata)
            }

            // Detectar conclusão baseada nos arquivos selecionados:
            // O WebTorrent só emite 'done' quando TODOS os arquivos do torrent
            // são baixados. Quando o usuário desmarca arquivos, o 'done' nunca
            // dispara. Verificamos manualmente se todos os selecionados já foram
            // baixados (progress >= 1) e o torrent está ativo.
            const selectedFilesComplete =
                totalSize > 0 && downloadedSize >= totalSize && info.status === 'downloading';

            if (selectedFilesComplete) {
                const completedAt = Date.now();
                const elapsedMs = completedAt - existing.addedAt;
                const completed: DownloadItem = {
                    ...existing,
                    name: wasResolvingMetadata && isNowDownloading ? info.name : existing.name,
                    totalSize,
                    downloadedSize,
                    progress: 1,
                    downloadSpeed: 0,
                    uploadSpeed: 0,
                    numPeers: info.numPeers,
                    numSeeders: info.numSeeders,
                    timeRemaining: 0,
                    status: 'completed',
                    ...(selectedFileCount !== undefined ? { selectedFileCount } : {}),
                    ...(totalFileCount !== undefined ? { totalFileCount } : {}),
                    completedAt,
                    elapsedMs,
                };
                try {
                    const meta = this.engine.getMetadata(info.infoHash);
                    this._metadataCache.set(info.infoHash, meta);
                } catch {
                    /* metadata may not be available */
                }
                this._completeTorrent(completed);

                // Liberar slot para a fila
                this._processQueue();
                return;
            }

            const updated: DownloadItem = {
                ...existing,
                // Update name when metadata becomes available
                name: wasResolvingMetadata && isNowDownloading ? info.name : existing.name,
                totalSize,
                downloadedSize,
                progress,
                downloadSpeed: info.downloadSpeed,
                uploadSpeed: info.uploadSpeed,
                numPeers: info.numPeers,
                numSeeders: info.numSeeders,
                timeRemaining: info.timeRemaining,
                status: info.status,
                ...(selectedFileCount !== undefined ? { selectedFileCount } : {}),
                ...(totalFileCount !== undefined ? { totalFileCount } : {}),
            };
            this.items.set(info.infoHash, updated);
            this.emit('update', updated);
        });

        this.engine.on('done', (infoHash: string) => {
            const existing = this.items.get(infoHash);
            if (
                !existing ||
                this.removingHashes.has(infoHash) ||
                existing.fileOperation ||
                !this._isActiveStatus(existing.status)
            )
                return;

            this._clearMetadataTimer(infoHash);
            try {
                const meta = this.engine.getMetadata(infoHash);
                this._metadataCache.set(infoHash, meta);
            } catch {
                /* metadata may not be available */
            }
            const completedAt = Date.now();
            const elapsedMs = completedAt - existing.addedAt;
            const updated: DownloadItem = {
                ...existing,
                status: 'completed',
                progress: 1,
                completedAt,
                elapsedMs,
            };
            this._completeTorrent(updated);

            // Um slot de download foi liberado, independente do seed.
            this._processQueue();
        });

        this.engine.on('error', (infoHash: string, err: Error) => {
            this.log.error('[DownloadManager] Torrent error:', infoHash.slice(0, 8), err.message);

            const existing = this.items.get(infoHash);
            if (!existing || this.removingHashes.has(infoHash) || existing.fileOperation) return;

            if (
                (err as NodeJS.ErrnoException).code === 'ENOSPC' ||
                /\bENOSPC\b/.test(err.message)
            ) {
                this._markDiskPaused(existing, ErrorCodes.DISK_SPACE_LOW);
                void this.engine
                    .pause(infoHash)
                    .catch((pauseError) =>
                        this.log.warn(
                            '[DownloadManager] Falha ao suspender disco cheio:',
                            pauseError,
                        ),
                    );
                this._persistSessionAfterEngineError();
                this._processQueue();
                return;
            }

            this._clearMetadataTimer(infoHash);
            const updated: DownloadItem = {
                ...existing,
                status: 'error',
                errorMessage: err.message,
            };
            this.items.set(infoHash, updated);
            this.emit('update', updated);

            // Um slot foi liberado — processar a fila
            this.seedingSet.delete(infoHash);
            this._scheduleSeeds();
            this._persistSessionAfterEngineError();
            this._processQueue();
        });
    }

    // ── addTorrentFile ──────────────────────────────────────────────────────────

    addPreparedTorrent(
        prepared: PreparedTorrent,
        destinationFolder: string,
        selectedIndices: number[],
    ): Promise<DownloadItem> {
        const work = this.admission
            .catch(() => {})
            .then(async () => {
                const { preview } = prepared;
                if (this.items.has(preview.infoHash) || this.pendingHashes.has(preview.infoHash))
                    throw new Error(ErrorCodes.TORRENT_DUPLICATE);
                if (selectedIndices.length === 0) throw new Error(ErrorCodes.FILE_SELECTION_EMPTY);
                if (
                    selectedIndices.some(
                        (index) =>
                            !Number.isInteger(index) ||
                            !preview.files.some((file) => file.index === index),
                    )
                )
                    throw new Error(ErrorCodes.FILE_INDEX_INVALID);
                validateDestinationFolder(destinationFolder);
                const indices = [...new Set(selectedIndices)];
                const selectedBytes = preview.files
                    .filter((file) => indices.includes(file.index))
                    .reduce((sum, file) => sum + file.length, 0);
                await this._ensureDiskSpace(destinationFolder, selectedBytes);
                const hasSlot = this._activeCount() < this.maxConcurrent;
                this.pendingHashes.add(preview.infoHash);
                this.pendingAdds++;
                let slotReserved = true;
                try {
                    const info = await this.engine.addTorrentBuffer(prepared.buffer, true, {
                        destinationFolder,
                        selectedFileIndices: indices,
                    });
                    const files = this.engine
                        .getFiles(info.infoHash)
                        .filter((file) => file.selected);
                    const downloadedSize = files.reduce((sum, file) => sum + file.downloaded, 0);
                    const complete =
                        files.length > 0 && files.every((file) => file.downloaded >= file.length);
                    const now = Date.now();
                    const item: DownloadItem = {
                        ...torrentInfoToDownloadItem(info, destinationFolder, now),
                        totalSize: selectedBytes,
                        downloadedSize,
                        progress: complete
                            ? 1
                            : selectedBytes > 0
                              ? downloadedSize / selectedBytes
                              : 0,
                        selectedFileCount: indices.length,
                        totalFileCount: preview.files.length,
                        status: complete ? 'completed' : hasSlot ? 'paused' : 'queued',
                        ...(complete ? { completedAt: now, elapsedMs: 0 } : {}),
                    };
                    this.originalMagnetUris.set(info.infoHash, prepared.magnetUri);
                    this.confirmedMetadata.set(info.infoHash, Buffer.from(prepared.buffer));
                    this.fileCatalog.set(
                        info.infoHash,
                        prepared.preview.files.map((file) => ({
                            ...file,
                            selected: indices.includes(file.index),
                        })),
                    );
                    this.selectedFileIndicesMap.set(info.infoHash, indices);
                    this.items.set(info.infoHash, item);
                    if (!hasSlot && !complete) this._enqueue(info.infoHash);
                    this.emit('update', item);
                    // Libera a reserva de slot antes de resume, que contabiliza os itens ativos.
                    this.pendingAdds--;
                    slotReserved = false;
                    if (complete) this._scheduleSeeds();
                    if (hasSlot && !complete) {
                        try {
                            await this.resume(info.infoHash, true);
                        } catch (error) {
                            const current = this.items.get(info.infoHash);
                            const message = (error as Error).message;
                            if (
                                current &&
                                (message === ErrorCodes.DISK_SPACE_LOW ||
                                    message === ErrorCodes.DISK_SPACE_UNAVAILABLE)
                            )
                                this._markDiskPaused(current, message);
                            else if (current) {
                                const failed: DownloadItem = {
                                    ...current,
                                    status: 'error',
                                    errorMessage: ErrorCodes.OPERATION_FAILED,
                                };
                                this.items.set(current.infoHash, failed);
                                this.emit('update', failed);
                            }
                        }
                    }
                    this._applyGlobalTrackers(info.infoHash);
                    this.persistSession();
                    return this.getAll().find((download) => download.infoHash === info.infoHash)!;
                } finally {
                    this.pendingHashes.delete(preview.infoHash);
                    // O slot também precisa ser liberado quando a adição falha antes de criar o item.
                    if (slotReserved) this.pendingAdds--;
                    this._processQueue();
                }
            });
        this.admission = work;
        return work;
    }

    getFiles(infoHash: string): TorrentFileInfo[] {
        if (!this.items.has(infoHash)) throw new Error(ErrorCodes.TORRENT_NOT_FOUND);
        try {
            const files = this.engine.getFiles(infoHash);
            if (files.length)
                this.fileCatalog.set(
                    infoHash,
                    files.map((file) => ({ ...file })),
                );
        } catch {
            /* Sessões pausadas/concluídas podem não estar no engine. */
        }
        return (this.fileCatalog.get(infoHash) ?? []).map((file) => ({ ...file }));
    }

    manageFiles(
        infoHash: string,
        operation: FileOperation,
        destinationFolder?: string,
    ): Promise<DownloadItem> {
        const work = this.admission
            .catch(() => {})
            .then(() =>
                this._withLock(infoHash, async () => {
                    const existing = this.items.get(infoHash);
                    if (!existing) throw new Error(ErrorCodes.TORRENT_NOT_FOUND);
                    if (this.engine.isRestarting?.()) throw new Error(ErrorCodes.ENGINE_RESTARTING);
                    let metadata =
                        this.confirmedMetadata.get(infoHash) ??
                        this.engine.getTorrentFile?.(infoHash);
                    let files = this.getFiles(infoHash);
                    const magnetUri = this.originalMagnetUris.get(infoHash);
                    if ((!metadata || !files.length) && magnetUri && this.recoverMetadata) {
                        const recovered = await this.recoverMetadata(magnetUri);
                        if (recovered.preview.infoHash !== infoHash)
                            throw new Error(ErrorCodes.FILE_METADATA_UNAVAILABLE);
                        metadata = recovered.buffer;
                        const selected = this.selectedFileIndicesMap.get(infoHash);
                        files = recovered.preview.files.map((file) => ({
                            ...file,
                            selected: selected ? selected.includes(file.index) : true,
                        }));
                        this.fileCatalog.set(infoHash, files);
                    }
                    if (!metadata || !files.length)
                        throw new Error(ErrorCodes.FILE_METADATA_UNAVAILABLE);
                    const target =
                        operation === 'verify' ? existing.destinationFolder : destinationFolder;
                    if (!target) throw new Error(ErrorCodes.INVALID_PARAMS);
                    await this.torrentFiles.validate(target, files);
                    if (this.engine.isRestarting?.()) throw new Error(ErrorCodes.ENGINE_RESTARTING);
                    this.confirmedMetadata.set(infoHash, Buffer.from(metadata));
                    const indices =
                        this.selectedFileIndicesMap.get(infoHash) ??
                        files.filter((file) => file.selected).map((file) => file.index);
                    this.selectedFileIndicesMap.set(infoHash, indices);
                    const paused: DownloadItem = {
                        ...existing,
                        status: 'paused',
                        fileOperation: operation,
                        downloadSpeed: 0,
                        uploadSpeed: 0,
                    };
                    delete paused.pauseReason;
                    delete paused.errorMessage;
                    this.items.set(infoHash, paused);
                    const queueIndex = this.queue.indexOf(infoHash);
                    if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
                    this.queuedMagnetUris.delete(infoHash);
                    this._clearMetadataTimer(infoHash);
                    this.emit('update', paused);
                    this.persistSession();
                    let move: FileMove | undefined;
                    let destinationCommitted = false;
                    let keepOriginals = false;
                    try {
                        await this.engine.detachTorrent(infoHash);
                        this.seedingSet.delete(infoHash);
                        this._scheduleSeeds();
                        if (operation === 'move') {
                            const sourcePaths = new Set(
                                await Promise.all(
                                    files.map((file) =>
                                        resolveTorrentFile(existing.destinationFolder, file.path),
                                    ),
                                ),
                            );
                            for (const other of this.items.values()) {
                                if (other.infoHash === infoHash) continue;
                                for (const file of this.getFiles(other.infoHash)) {
                                    try {
                                        if (
                                            sourcePaths.has(
                                                await resolveTorrentFile(
                                                    other.destinationFolder,
                                                    file.path,
                                                ),
                                            )
                                        )
                                            keepOriginals = true;
                                    } catch {
                                        /* Pasta de outro torrent indisponível; não participa desta cópia. */
                                    }
                                }
                            }
                            const bytes = await this.torrentFiles.existingBytes(
                                existing.destinationFolder,
                                files,
                            );
                            await this._ensureDiskSpace(target, bytes, infoHash);
                            move = await this.torrentFiles.copy(
                                existing.destinationFolder,
                                target,
                                files,
                            );
                        }
                        await this.engine.addTorrentBuffer(metadata, true, {
                            destinationFolder: target,
                            selectedFileIndices: indices,
                            verifyExisting: true,
                        });
                        const verified = this.engine.getFiles(infoHash);
                        this.fileCatalog.set(
                            infoHash,
                            verified.map((file) => ({ ...file })),
                        );
                        const selected = verified.filter((file) => file.selected);
                        const totalSize = selected.reduce((sum, file) => sum + file.length, 0);
                        const downloadedSize = selected.reduce(
                            (sum, file) => sum + Math.min(file.length, file.downloaded),
                            0,
                        );
                        const complete =
                            selected.length > 0 &&
                            selected.every((file) => file.downloaded >= file.length);
                        const result: DownloadItem = {
                            ...paused,
                            destinationFolder: target,
                            totalSize,
                            downloadedSize,
                            progress: complete ? 1 : totalSize > 0 ? downloadedSize / totalSize : 0,
                            selectedFileCount: selected.length,
                            totalFileCount: verified.length,
                            status: complete ? 'completed' : 'paused',
                        };
                        delete result.fileOperation;
                        if (complete) result.completedAt = existing.completedAt ?? Date.now();
                        else {
                            delete result.completedAt;
                            delete result.elapsedMs;
                        }
                        this.items.set(infoHash, result);
                        this.persistSession();
                        destinationCommitted = true;
                        if (move && (keepOriginals || !(await move.commit())))
                            result.errorMessage = ErrorCodes.FILE_MOVE_SOURCE_RETAINED;
                        this.persistSession();
                        this.emit('update', result);
                        this._scheduleSeeds();
                        return { ...result };
                    } catch (error) {
                        if (!destinationCommitted) {
                            await this.engine.detachTorrent(infoHash).catch(() => {});
                            await move
                                ?.rollback()
                                .catch((rollbackError) =>
                                    this.log.warn(
                                        '[DownloadManager] Cópia mantida após falha de recuperação:',
                                        rollbackError,
                                    ),
                                );
                            const failed = {
                                ...existing,
                                status: 'paused' as const,
                                downloadSpeed: 0,
                                uploadSpeed: 0,
                            };
                            delete failed.fileOperation;
                            this.items.set(infoHash, failed);
                            this.fileCatalog.set(infoHash, files);
                            this.emit('update', failed);
                            this.persistSession();
                        }
                        throw error;
                    } finally {
                        this._processQueue();
                    }
                }),
            );
        this.admission = work;
        return work;
    }

    async getDiskSpace(
        destinationFolder: string,
        selectedBytes: number,
        excludeHash?: string,
    ): Promise<DiskSpaceInfo> {
        if (!this.diskSpace) throw new Error(ErrorCodes.DISK_SPACE_UNAVAILABLE);
        return this.diskSpace.inspect(destinationFolder, selectedBytes, this.getAll(), excludeHash);
    }

    private async _ensureDiskSpace(
        destinationFolder: string,
        selectedBytes: number,
        excludeHash?: string,
    ): Promise<void> {
        if (!this.diskSpace) return;
        const space = await this.getDiskSpace(destinationFolder, selectedBytes, excludeHash);
        if (!space.sufficient) throw new Error(ErrorCodes.DISK_SPACE_LOW);
    }

    private _markDiskPaused(item: DownloadItem, reason: string): void {
        this._clearMetadataTimer(item.infoHash);
        const queueIndex = this.queue.indexOf(item.infoHash);
        if (queueIndex !== -1) this.queue.splice(queueIndex, 1);
        const paused: DownloadItem = {
            ...item,
            status: 'paused',
            pauseReason: 'disk-space',
            errorMessage: reason,
            downloadSpeed: 0,
            uploadSpeed: 0,
        };
        this.items.set(item.infoHash, paused);
        this.emit('update', paused);
    }

    async checkDiskSpace(): Promise<void> {
        if (!this.diskSpace || this.checkingDisk || this.engine.isRestarting?.()) return;
        this.checkingDisk = true;
        try {
            for (const item of this.getAll()) {
                if (!this._isActiveStatus(item.status)) continue;
                try {
                    await this._ensureDiskSpace(
                        item.destinationFolder,
                        Math.max(0, item.totalSize - item.downloadedSize),
                        item.infoHash,
                    );
                } catch (error) {
                    const current = this.items.get(item.infoHash);
                    if (!current || !this._isActiveStatus(current.status)) continue;
                    await this.pause(item.infoHash);
                    const paused = this.items.get(item.infoHash);
                    if (paused?.status === 'paused')
                        this._markDiskPaused(paused, (error as Error).message);
                    this.persistSession();
                }
            }
        } finally {
            this.checkingDisk = false;
        }
    }

    async addTorrentFile(filePath: string): Promise<DownloadItem> {
        const destinationFolder = this.settings.get().destinationFolder;
        validateDestinationFolder(destinationFolder);

        const hasSlot = this._activeCount() < this.maxConcurrent;
        if (hasSlot) this.pendingAdds++;
        try {
            const info = await this.engine.addTorrentFile(filePath, !hasSlot, {
                destinationFolder,
            });

            // Duplicate detection: check if infoHash already exists
            const existing = this.items.get(info.infoHash);
            if (existing) {
                throw new Error('Torrent já existe na lista');
            }

            const addedAt = Date.now();

            // Verificar se há slots disponíveis
            if (hasSlot) {
                const item = torrentInfoToDownloadItem(info, destinationFolder, addedAt);
                this.items.set(item.infoHash, item);
                this.emit('update', item);

                // Aplicar trackers globais automaticamente (não bloqueia o retorno)
                this._applyGlobalTrackers(item.infoHash);

                return item;
            }

            // Sem slots — pausar imediatamente e enfileirar
            await this.engine.pause(info.infoHash);

            const item: DownloadItem = {
                ...torrentInfoToDownloadItem(info, destinationFolder, addedAt),
                status: 'queued',
            };

            this.items.set(item.infoHash, item);
            this._enqueue(item.infoHash);
            this.emit('update', item);

            return item;
        } finally {
            if (hasSlot) this.pendingAdds--;
            this._processQueue();
        }
    }

    // ── addTorrentBuffer ────────────────────────────────────────────────────────

    async addTorrentBuffer(buffer: Buffer): Promise<DownloadItem> {
        const destinationFolder = this.settings.get().destinationFolder;
        validateDestinationFolder(destinationFolder);

        const hasSlot = this._activeCount() < this.maxConcurrent;
        if (hasSlot) this.pendingAdds++;
        try {
            const info = await this.engine.addTorrentBuffer(buffer, !hasSlot, {
                destinationFolder,
            });

            // Duplicate detection: check if infoHash already exists
            const existing = this.items.get(info.infoHash);
            if (existing) {
                throw new Error('Torrent já existe na lista');
            }

            const addedAt = Date.now();

            // Verificar se há slots disponíveis
            if (hasSlot) {
                const item = torrentInfoToDownloadItem(info, destinationFolder, addedAt);
                this.items.set(item.infoHash, item);
                this.emit('update', item);

                // Aplicar trackers globais automaticamente (não bloqueia o retorno)
                this._applyGlobalTrackers(item.infoHash);

                return item;
            }

            // Sem slots — pausar imediatamente e enfileirar
            await this.engine.pause(info.infoHash);

            const item: DownloadItem = {
                ...torrentInfoToDownloadItem(info, destinationFolder, addedAt),
                status: 'queued',
            };

            this.items.set(item.infoHash, item);
            this._enqueue(item.infoHash);
            this.emit('update', item);

            return item;
        } finally {
            if (hasSlot) this.pendingAdds--;
            this._processQueue();
        }
    }

    // ── addMagnetLink ───────────────────────────────────────────────────────────

    async addMagnetLink(magnetUri: string): Promise<DownloadItem> {
        // Validate destination folder before starting the transfer
        const destinationFolder = this.settings.get().destinationFolder;
        validateDestinationFolder(destinationFolder);

        // Extract infoHash from magnet URI for early duplicate detection
        const hashMatch = magnetUri.match(/xt=urn:btih:([a-fA-F0-9]{40})/i);
        if (hashMatch) {
            const infoHash = hashMatch[1]!.toLowerCase();
            if (this.items.has(infoHash) || this.pendingHashes.has(infoHash)) {
                throw new Error('Torrent já existe na lista');
            }
        }

        // Verificar se há slots disponíveis
        const hasSlot = this._activeCount() < this.maxConcurrent;

        // Para magnet links sem slot, enfileirar sem adicionar ao engine
        // (evita resolver metadados desnecessariamente)
        if (!hasSlot && hashMatch) {
            const infoHash = hashMatch[1]!.toLowerCase();
            const addedAt = Date.now();

            // Extrair display name (dn) do magnet URI, se disponível
            const dnMatch = magnetUri.match(/[?&]dn=([^&]+)/);
            const rawDn = dnMatch?.[1];
            const magnetName = rawDn ? decodeURIComponent(rawDn) : infoHash;

            const item: DownloadItem = {
                infoHash,
                name: magnetName,
                totalSize: 0,
                downloadedSize: 0,
                progress: 0,
                downloadSpeed: 0,
                uploadSpeed: 0,
                numPeers: 0,
                numSeeders: 0,
                timeRemaining: Infinity,
                status: 'queued',
                destinationFolder,
                addedAt,
            };

            this.items.set(item.infoHash, item);
            this.queuedMagnetUris.set(item.infoHash, magnetUri);
            this.originalMagnetUris.set(item.infoHash, magnetUri);
            this._enqueue(item.infoHash);
            this.emit('update', item);

            return item;
        }

        const pendingHash = hashMatch?.[1]?.toLowerCase();
        if (pendingHash) this.pendingHashes.add(pendingHash);
        if (hasSlot) this.pendingAdds++;
        try {
            const info = await this.engine.addMagnetLink(magnetUri, false, { destinationFolder });

            // Armazenar magnetUri original para persistência de sessão
            this.originalMagnetUris.set(info.infoHash, magnetUri);

            // Post-add duplicate check (in case infoHash wasn't extractable before)
            const existing = this.items.get(info.infoHash);
            if (existing) {
                throw new Error('Torrent já existe na lista');
            }

            const addedAt = Date.now();

            if (hasSlot) {
                // Se o engine já resolveu os metadados (status 'downloading'),
                // usar esse status diretamente. Caso contrário, iniciar como
                // 'resolving-metadata' com timeout de 60s.
                const initialStatus =
                    info.status === 'downloading' ? 'downloading' : 'resolving-metadata';
                const item: DownloadItem = {
                    ...torrentInfoToDownloadItem(info, destinationFolder, addedAt),
                    status: initialStatus,
                };

                this.items.set(item.infoHash, item);
                this.emit('update', item);

                // Só iniciar o timer de metadados se ainda estiver resolvendo
                if (initialStatus === 'resolving-metadata') {
                    this._startMetadataTimer(item.infoHash);
                }

                // Aplicar trackers globais automaticamente (não bloqueia o retorno)
                this._applyGlobalTrackers(item.infoHash);

                return item;
            }

            // Sem slots e não conseguimos extrair o hash antes — pausar e enfileirar
            await this.engine.pause(info.infoHash);

            const item: DownloadItem = {
                ...torrentInfoToDownloadItem(info, destinationFolder, addedAt),
                status: 'queued',
            };

            this.items.set(item.infoHash, item);
            this._enqueue(item.infoHash);
            this.emit('update', item);

            return item;
        } finally {
            if (pendingHash) this.pendingHashes.delete(pendingHash);
            if (hasSlot) this.pendingAdds--;
            this._processQueue();
        }
    }
    /** Serializa a fila de seed, inclusive mudanças concorrentes de configuração. */
    private _scheduleSeeds(): void {
        void this.applySeedingSettings().catch((err) =>
            this.log.warn('[DownloadManager] Falha no seeding:', err),
        );
    }

    private _completeTorrent(item: DownloadItem): void {
        const settings = this.settings.get();
        const waiting = [...this.items.values()].some(
            (candidate) =>
                candidate.status === 'completed' &&
                !candidate.seedingDisabled &&
                !candidate.fileOperation &&
                (candidate.completedAt ?? 0) <= (item.completedAt ?? 0),
        );
        const canSeed =
            !waiting &&
            (settings.seedingEnabled ?? true) &&
            !item.seedingDisabled &&
            this.seedingSet.size < (settings.maxConcurrentSeeders ?? 2) &&
            !this.engine.isRestarting?.();
        const updated: DownloadItem = {
            ...item,
            status: canSeed ? 'seeding' : 'completed',
            downloadedSize: item.totalSize,
            downloadSpeed: 0,
            timeRemaining: 0,
        };
        if (canSeed) this.seedingSet.add(item.infoHash);
        this.items.set(item.infoHash, updated);
        this.emit('update', updated);
        if (!canSeed) {
            void this._withLock(item.infoHash, () => this.engine.pause(item.infoHash))
                .catch((err) => this.log.warn('[DownloadManager] Falha ao suspender seed:', err))
                .finally(() => this._scheduleSeeds());
        }
        this.persistSession();
    }

    async setSeedingEnabled(infoHash: string, enabled: boolean): Promise<DownloadItem> {
        if (typeof enabled !== 'boolean') throw new Error(ErrorCodes.INVALID_PARAMS);
        await this._withLock(infoHash, async () => {
            const item = this.items.get(infoHash);
            if (!item) throw new Error(ErrorCodes.TORRENT_NOT_FOUND);
            if (this.removingHashes.has(infoHash) || item.fileOperation)
                throw new Error(ErrorCodes.FILE_OPERATION_BUSY);
            const updated = { ...item, seedingDisabled: !enabled };
            if (updated.seedingDisabled && item.status === 'seeding') {
                this.items.set(infoHash, { ...updated, status: 'completed', uploadSpeed: 0 });
                try {
                    await this.engine.pause(infoHash);
                } catch (err) {
                    this.items.set(infoHash, item);
                    throw err;
                }
                this.seedingSet.delete(infoHash);
            } else this.items.set(infoHash, updated);
            this.persistSession();
            this.emit('update', this.items.get(infoHash)!);
        });
        await this.applySeedingSettings();
        return this.items.get(infoHash)!;
    }

    applySeedingSettings(): Promise<void> {
        const work = this.seedWork
            .catch(() => {})
            .then(async () => {
                if (this.engine.isRestarting?.()) return;
                const settings = this.settings.get();
                const max =
                    (settings.seedingEnabled ?? true) ? (settings.maxConcurrentSeeders ?? 2) : 0;
                // Set conserva a ordem real de início; os últimos são suspensos primeiro.
                for (const hash of [...this.seedingSet].reverse()) {
                    if (this.seedingSet.size <= max) break;
                    await this._withLock(hash, async () => {
                        const item = this.items.get(hash);
                        if (!item || item.status !== 'seeding') return;
                        const updated: DownloadItem = {
                            ...item,
                            status: 'completed',
                            uploadSpeed: 0,
                        };
                        this.items.set(hash, updated);
                        try {
                            await this.engine.pause(hash);
                        } catch (err) {
                            this.items.set(hash, item);
                            throw err;
                        }
                        this.seedingSet.delete(hash);
                        this.emit('update', updated);
                    });
                }
                const candidates = [...this.items.values()]
                    .filter(
                        (item) =>
                            item.status === 'completed' &&
                            !item.seedingDisabled &&
                            !item.fileOperation,
                    )
                    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
                for (const candidate of candidates) {
                    if (this.seedingSet.size >= max || this.engine.isRestarting?.()) break;
                    await this._withLock(candidate.infoHash, async () => {
                        const item = this.items.get(candidate.infoHash);
                        if (
                            !item ||
                            item.status !== 'completed' ||
                            item.seedingDisabled ||
                            item.fileOperation
                        )
                            return;
                        if (!existsSync(item.destinationFolder)) {
                            const missing: DownloadItem = { ...item, status: 'files-not-found' };
                            this.items.set(item.infoHash, missing);
                            this.emit('update', missing);
                            return;
                        }
                        const updated: DownloadItem = { ...item, status: 'seeding' };
                        this.items.set(item.infoHash, updated);
                        this.seedingSet.add(item.infoHash);
                        try {
                            if (
                                !this.engine
                                    .getAll()
                                    .some((torrent) => torrent.infoHash === item.infoHash)
                            ) {
                                const magnet =
                                    this.originalMagnetUris.get(item.infoHash) ??
                                    'magnet:?xt=urn:btih:' + item.infoHash;
                                // A verificação dos dados precede a retomada da rede.
                                let buffer = this.confirmedMetadata.get(item.infoHash);
                                if (!buffer && this.recoverMetadata) {
                                    const recovered = await this.recoverMetadata(magnet);
                                    if (recovered.preview.infoHash !== item.infoHash)
                                        throw new Error(ErrorCodes.FILE_METADATA_UNAVAILABLE);
                                    buffer = Buffer.from(recovered.buffer);
                                    this.confirmedMetadata.set(item.infoHash, buffer);
                                }
                                if (buffer)
                                    await this.engine.addTorrentBuffer(
                                        buffer,
                                        true,
                                        this._torrentOptions(item),
                                    );
                                else
                                    await this.engine.addMagnetLink(
                                        magnet,
                                        true,
                                        this._torrentOptions(item),
                                    );
                            }
                            await this.engine.resume(item.infoHash, true);
                            if (
                                this.engine.isRestarting?.() ||
                                this.items.get(item.infoHash)?.status !== 'seeding'
                            )
                                return;
                            this.emit('update', this.items.get(item.infoHash)!);
                        } catch (err) {
                            if (
                                this.engine.isRestarting?.() ||
                                this.items.get(item.infoHash)?.status !== 'seeding'
                            )
                                return;
                            this.seedingSet.delete(item.infoHash);
                            const failed: DownloadItem = {
                                ...item,
                                status: 'error',
                                errorMessage: (err as Error).message,
                            };
                            this.items.set(item.infoHash, failed);
                            this.emit('update', failed);
                            try {
                                await this.engine.pause(item.infoHash);
                            } catch {
                                /* erro já informado no item */
                            }
                        }
                    });
                }
                this.persistSession();
            });
        this.seedWork = work;
        return work;
    }

    // ── pause ───────────────────────────────────────────────────────────────────

    async pause(infoHash: string): Promise<void> {
        return this._withLock(infoHash, async () => {
            const existing = this.items.get(infoHash);

            // Se o item está na fila, apenas removê-lo da fila (não está no engine)
            if (existing && existing.status === 'queued') {
                const queueIdx = this.queue.indexOf(infoHash);
                if (queueIdx !== -1) {
                    this.queue.splice(queueIdx, 1);
                }

                // Se o item está no engine (foi pausado ao enfileirar), pausar lá também
                // Se é um magnet enfileirado sem engine, apenas atualizar o status
                if (!this.queuedMagnetUris.has(infoHash)) {
                    try {
                        await this.engine.pause(infoHash);
                    } catch (pauseErr) {
                        this.log.warn(
                            '[DownloadManager] Falha ao pausar item enfileirado:',
                            infoHash.slice(0, 8),
                            (pauseErr as Error).message,
                        );
                    }
                }

                const updated: DownloadItem = { ...existing, status: 'paused' };
                this.items.set(infoHash, updated);
                this.emit('update', updated);
                return;
            }

            // Atualizar status ANTES do await para que:
            // 1. O progress handler ignore eventos residuais do engine
            // 2. O _activeCount() reflita o slot liberado imediatamente
            if (existing) {
                const updated: DownloadItem = { ...existing, status: 'paused' };
                this.items.set(infoHash, updated);
                this.emit('update', updated);
            }

            try {
                await this.engine.pause(infoHash);
            } catch (err) {
                // Se o engine falhou ao pausar, reverter o status
                if (existing) {
                    this.items.set(infoHash, existing);
                    this.emit('update', existing);
                }
                throw err;
            }

            // Um slot foi liberado — processar a fila
            this.seedingSet.delete(infoHash);
            this._scheduleSeeds();
            this.persistSession();
            this._processQueue();
        });
    }

    // ── resume ──────────────────────────────────────────────────────────────────

    async resume(infoHash: string, admitted = false): Promise<void> {
        const completed = this.items.get(infoHash);
        if (completed?.progress === 1 && completed.completedAt !== undefined) {
            await this._withLock(infoHash, async () => {
                const item = this.items.get(infoHash);
                if (!item || item.fileOperation) throw new Error(ErrorCodes.FILE_OPERATION_BUSY);
                if (item.status !== 'seeding')
                    this.items.set(infoHash, { ...item, status: 'completed' });
            });
            await this.applySeedingSettings();
            return;
        }
        if (this.diskSpace && !admitted) {
            const work = this.admission.catch(() => {}).then(() => this.resume(infoHash, true));
            this.admission = work;
            return work;
        }
        return this._withLock(infoHash, async () => {
            const existing = this.items.get(infoHash);
            if (!existing) {
                throw new Error(`Torrent não encontrado: ${infoHash}`);
            }
            await this._ensureDiskSpace(
                existing.destinationFolder,
                Math.max(0, existing.totalSize - existing.downloadedSize),
                infoHash,
            );
            if (existing.pauseReason) {
                delete existing.pauseReason;
                delete existing.errorMessage;
            }

            // Se não há slots disponíveis, enfileirar em vez de retomar
            if (this._activeCount() >= this.maxConcurrent) {
                // Já está na fila? Não fazer nada
                if (existing.status === 'queued') return;

                const updated: DownloadItem = { ...existing, status: 'queued' };
                this.items.set(infoHash, updated);
                if (!this.queue.includes(infoHash)) {
                    this._enqueue(infoHash);
                }
                this.emit('update', updated);
                return;
            }

            // Se é um magnet enfileirado que nunca foi adicionado ao engine
            if (this.queuedMagnetUris.has(infoHash)) {
                const magnetUri = this.queuedMagnetUris.get(infoHash)!;
                this.queuedMagnetUris.delete(infoHash);

                // Remover da fila
                const queueIdx = this.queue.indexOf(infoHash);
                if (queueIdx !== -1) this.queue.splice(queueIdx, 1);

                // Atualizar status ANTES do await para ocupar o slot
                const starting: DownloadItem = {
                    ...existing,
                    status: 'resolving-metadata',
                };
                this.items.set(infoHash, starting);
                this.emit('update', starting);

                try {
                    const info = await this._addStoredTorrent(existing, magnetUri);

                    const current = this.items.get(infoHash);
                    if (!current) return;

                    const updated: DownloadItem = {
                        ...current,
                        name: info.name || current.name,
                        totalSize: this.selectedFileIndicesMap.has(infoHash)
                            ? current.totalSize
                            : info.totalSize || current.totalSize,
                        status:
                            info.status === 'downloading' ? 'downloading' : 'resolving-metadata',
                    };
                    this.items.set(infoHash, updated);
                    this.emit('update', updated);

                    if (updated.status === 'resolving-metadata') this._startMetadataTimer(infoHash);
                } catch (err) {
                    // Se falhou, reverter para o status anterior
                    const current = this.items.get(infoHash);
                    if (current) {
                        const errItem: DownloadItem = {
                            ...current,
                            status: 'error',
                            errorMessage: (err as Error).message,
                        };
                        this.items.set(infoHash, errItem);
                        this.emit('update', errItem);
                    }
                    this._processQueue();
                }
                return;
            }

            // Remover da fila se estava lá
            const queueIdx = this.queue.indexOf(infoHash);
            if (queueIdx !== -1) this.queue.splice(queueIdx, 1);

            // Atualizar status ANTES do await para que:
            // 1. O _activeCount() reflita o slot ocupado imediatamente
            // 2. O progress handler aceite eventos do engine
            const updated: DownloadItem = { ...existing, status: 'downloading' };
            this.items.set(infoHash, updated);
            this.emit('update', updated);

            try {
                // Se o torrent não está no engine (ex: restaurado de sessão como pausado),
                // re-adicionar usando o magnetUri original antes de tentar resume.
                const magnetUri = this.originalMagnetUris.get(infoHash);
                if (magnetUri) {
                    try {
                        await this.engine.resume(infoHash);
                    } catch {
                        // engine.resume falhou — torrent não existe no engine.
                        // Re-adicionar via magnetUri.
                        const reAdded: DownloadItem = {
                            ...updated,
                            status: 'resolving-metadata',
                        };
                        this.items.set(infoHash, reAdded);
                        this.emit('update', reAdded);

                        const reAddedInfo = await this._addStoredTorrent(existing, magnetUri);

                        // Reaplicar seleção de arquivos se existir
                        const selectedIndices = this.selectedFileIndicesMap.get(infoHash);
                        if (selectedIndices && selectedIndices.length > 0) {
                            try {
                                const files = this.engine.getFiles(infoHash);
                                const maxIndex = files.length;
                                const validIndices = selectedIndices.filter(
                                    (idx) => idx >= 0 && idx < maxIndex,
                                );
                                if (validIndices.length > 0) {
                                    this.engine.setFileSelection(infoHash, validIndices);
                                }
                            } catch {
                                // Seleção pode falhar se metadados ainda não resolveram
                            }
                        }

                        // Atualizar status para downloading
                        const downloading: DownloadItem = {
                            ...this.items.get(infoHash)!,
                            status:
                                reAddedInfo.status === 'downloading'
                                    ? 'downloading'
                                    : 'resolving-metadata',
                        };
                        this.items.set(infoHash, downloading);
                        this.emit('update', downloading);
                        if (downloading.status === 'resolving-metadata')
                            this._startMetadataTimer(infoHash);
                        return;
                    }
                } else {
                    await this.engine.resume(infoHash);
                }
            } catch (err) {
                // Se o engine falhou ao retomar, marcar como erro
                const current = this.items.get(infoHash);
                if (current) {
                    const errItem: DownloadItem = {
                        ...current,
                        status: 'error',
                        errorMessage: (err as Error).message,
                    };
                    this.items.set(infoHash, errItem);
                    this.emit('update', errItem);
                }
                this._processQueue();
                throw err;
            }
        });
    }

    // ── setFileSelection ───────────────────────────────────────────────────────

    setFileSelection(infoHash: string, selectedIndices: number[]): TorrentFileInfo[] {
        if (this.removingHashes.has(infoHash) || this.items.get(infoHash)?.fileOperation)
            throw new Error(ErrorCodes.FILE_OPERATION_BUSY);
        const updatedFiles = this.engine.setFileSelection(infoHash, selectedIndices);

        // Track selected indices for persistence
        this.selectedFileIndicesMap.set(infoHash, [...selectedIndices]);

        // Update the DownloadItem with file selection info
        const existing = this.items.get(infoHash);
        if (existing) {
            const selectedFiles = updatedFiles.filter((f) => f.selected);
            const totalSize = selectedFiles.reduce((sum, f) => sum + f.length, 0);
            const downloadedSize = selectedFiles.reduce((sum, f) => sum + f.downloaded, 0);
            const progress = totalSize > 0 ? downloadedSize / totalSize : 0;

            const updated: DownloadItem = {
                ...existing,
                totalSize,
                downloadedSize,
                progress,
                selectedFileCount: selectedFiles.length,
                totalFileCount: updatedFiles.length,
            };
            this.items.set(infoHash, updated);
            this.persistSession();
            this.emit('update', updated);
        }

        return updatedFiles;
    }

    // ── retryDownload ─────────────────────────────────────────────────────────

    async retryDownload(infoHash: string): Promise<DownloadItem> {
        if (this.removingHashes.has(infoHash)) throw new Error(ErrorCodes.FILE_OPERATION_BUSY);
        const existing = this.items.get(infoHash);
        if (!existing) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        // Só permite retry de downloads em estado de erro
        if (existing.status !== 'error' && existing.status !== 'metadata-failed') {
            throw new Error(`Torrent não está em estado de erro: ${existing.status}`);
        }

        this.log.info(
            '[DownloadManager] Retentando download:',
            infoHash.slice(0, 8),
            existing.name,
        );

        // Limpar estado de erro
        const { errorMessage: _, ...existingBase } = existing;
        const retrying: DownloadItem = {
            ...existingBase,
            status: 'queued',
        };
        this.items.set(infoHash, retrying);
        this.emit('update', retrying);

        // Tentar remover do engine (pode já ter sido removido)
        try {
            await this.engine.remove(infoHash, false);
        } catch {
            // Pode não estar no engine — ok
        }

        // Se há um magnet URI persistido, usar para re-adicionar
        const magnetUri =
            this.queuedMagnetUris.get(infoHash) ?? this.originalMagnetUris.get(infoHash);
        if (magnetUri) {
            this.queuedMagnetUris.delete(infoHash);
        }

        // Verificar se há slots disponíveis
        if (this._activeCount() >= this.maxConcurrent) {
            // Sem slots — enfileirar
            if (!this.queue.includes(infoHash)) {
                this._enqueue(infoHash);
            }
            if (magnetUri) {
                this.queuedMagnetUris.set(infoHash, magnetUri);
            }
            this.emit('update', retrying);
            return retrying;
        }

        // Há slots — tentar re-adicionar com exponential backoff
        this.pendingAdds++;
        try {
            return await this._retryWithBackoff(infoHash, retrying, magnetUri);
        } finally {
            this.pendingAdds--;
            this._processQueue();
        }
    }

    /**
     * Tenta re-adicionar um torrent ao engine com exponential backoff.
     * Faz até RETRY_MAX_ATTEMPTS tentativas com delays crescentes (1s, 4s, 16s).
     * Se todas falharem, marca o item como 'error' com a mensagem da última falha.
     */
    private async _retryWithBackoff(
        infoHash: string,
        retrying: DownloadItem,
        magnetUri: string | undefined,
    ): Promise<DownloadItem> {
        let lastError: string = '';

        for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
            // Delay com exponential backoff (0ms na primeira tentativa)
            if (attempt > 0) {
                const delayMs = RETRY_BASE_DELAY_MS * Math.pow(4, attempt - 1);
                this.log.debug(
                    `[DownloadManager] Retry tentativa ${attempt + 1}/${RETRY_MAX_ATTEMPTS}`,
                    `aguardando ${delayMs}ms`,
                    infoHash.slice(0, 8),
                );
                await new Promise((resolve) => setTimeout(resolve, delayMs));

                // Verificar se o item ainda existe e está em estado retentável
                const current = this.items.get(infoHash);
                if (!current || (current.status !== 'queued' && current.status !== 'error')) {
                    // Item foi removido ou mudou de estado durante o delay — abortar
                    return current ?? retrying;
                }
            }

            if (magnetUri) {
                try {
                    const info = await this._addStoredTorrent(retrying, magnetUri);
                    const updated: DownloadItem = {
                        ...retrying,
                        name: info.name || retrying.name,
                        totalSize: info.totalSize || retrying.totalSize,
                        status:
                            info.status === 'downloading' ? 'downloading' : 'resolving-metadata',
                    };
                    this.items.set(infoHash, updated);
                    this.emit('update', updated);

                    if (updated.status === 'resolving-metadata') this._startMetadataTimer(infoHash);

                    this._applyGlobalTrackers(infoHash);
                    return updated;
                } catch (err) {
                    lastError = (err as Error).message;
                    this.log.warn(
                        `[DownloadManager] Retry tentativa ${attempt + 1}/${RETRY_MAX_ATTEMPTS} falhou:`,
                        infoHash.slice(0, 8),
                        lastError,
                    );
                }
            } else {
                // Sem magnet URI — tentar retomar via engine.resume
                try {
                    await this.engine.resume(infoHash);
                    const updated: DownloadItem = { ...retrying, status: 'downloading' };
                    this.items.set(infoHash, updated);
                    this.emit('update', updated);
                    return updated;
                } catch (err) {
                    lastError = (err as Error).message;
                    this.log.warn(
                        `[DownloadManager] Retry tentativa ${attempt + 1}/${RETRY_MAX_ATTEMPTS} falhou (resume):`,
                        infoHash.slice(0, 8),
                        lastError,
                    );
                }
            }
        }

        // Todas as tentativas falharam
        this.log.error(
            `[DownloadManager] Retry esgotado após ${RETRY_MAX_ATTEMPTS} tentativas:`,
            infoHash.slice(0, 8),
            lastError,
        );
        const errItem: DownloadItem = {
            ...retrying,
            status: 'error',
            errorMessage: lastError,
        };
        this.items.set(infoHash, errItem);
        this.emit('update', errItem);
        return errItem;
    }

    // ── remove ──────────────────────────────────────────────────────────────────

    async remove(infoHash: string, deleteFiles: boolean): Promise<void> {
        return this._withLock(infoHash, async () => {
            const existing = this.items.get(infoHash);
            if (!existing) {
                await this.engine.remove(infoHash, deleteFiles);
                return;
            }
            if (existing.fileOperation) throw new Error(ErrorCodes.FILE_OPERATION_BUSY);
            const wasActive = this._isActiveStatus(existing?.status);
            const wasQueued = existing?.status === 'queued';
            const hadQueuedMagnet = this.queuedMagnetUris.has(infoHash);
            // O WebTorrent pode descartar o torrent antes de informar uma falha de exclusão.
            // Guarde o catálogo e os metadados para permitir repetir mesmo após reiniciar.
            const files = this.getFiles(infoHash);
            const metadata = this.engine.getTorrentFile?.(infoHash);
            if (metadata) this.confirmedMetadata.set(infoHash, metadata);
            this.removingHashes.add(infoHash);

            // Remover da fila se estava lá
            const queueIdx = this.queue.indexOf(infoHash);
            if (queueIdx !== -1) this.queue.splice(queueIdx, 1);
            this._clearMetadataTimer(infoHash);

            try {
                // Magnets enfileirados podem nunca ter sido adicionados ao engine.
                if (!(wasQueued && hadQueuedMagnet)) {
                    await this.engine.remove(infoHash, deleteFiles);
                }
                // Também cobre sessões restauradas e tentativas após exclusão parcial.
                if (deleteFiles) await this.torrentFiles.remove(existing.destinationFolder, files);
                this.items.delete(infoHash);
                this.queuedContexts.delete(infoHash);
                this.persistSession();
            } catch (removeErr) {
                const failed: DownloadItem = {
                    ...existing,
                    status: 'error',
                    errorMessage: ErrorCodes.OPERATION_FAILED,
                    downloadSpeed: 0,
                    uploadSpeed: 0,
                };
                this.items.set(infoHash, failed);
                this.log.warn(
                    '[DownloadManager] Falha ao remover do engine ou excluir arquivos:',
                    infoHash.slice(0, 8),
                    (removeErr as Error).message,
                );
                // Se a engine ainda existir, impeça que continue usando os dados parcialmente excluídos.
                await this.engine.pause(infoHash).catch(() => {});
                this._persistSessionAfterEngineError();
                this.emit('update', failed);
                throw removeErr;
            } finally {
                this.removingHashes.delete(infoHash);
                this.seedingSet.delete(infoHash);
                this._scheduleSeeds();
                if (wasActive) this._processQueue();
            }

            this.queuedMagnetUris.delete(infoHash);
            this.originalMagnetUris.delete(infoHash);
            this.selectedFileIndicesMap.delete(infoHash);
            this.confirmedMetadata.delete(infoHash);
            this.fileCatalog.delete(infoHash);
            this._metadataCache.delete(infoHash);
            this.emit('remove', infoHash);
        });
    }

    // ── getAll ──────────────────────────────────────────────────────────────────

    getOperationalState(): DownloadQueueStats {
        const occupiedSlots = this._activeCount();
        return {
            activeDownloads: occupiedSlots - this.pendingAdds,
            pendingAdds: this.pendingAdds,
            occupiedSlots,
            maxConcurrentDownloads: this.maxConcurrent,
            queuedDownloads: this.queue.length,
            activeSeeders: this.seedingSet.size,
            slotUtilization: this.maxConcurrent > 0 ? occupiedSlots / this.maxConcurrent : null,
        };
    }

    getAll(): DownloadItem[] {
        const items = Array.from(this.items.values());
        return items.map((item) => {
            // Enriquecer com posição na fila
            const queueIdx = this.queue.indexOf(item.infoHash);
            const queuePosition = queueIdx !== -1 ? queueIdx + 1 : undefined;

            // Enrich with file count info if available
            try {
                const files = this.getFiles(item.infoHash);
                if (files.length > 0) {
                    const selectedFiles = files.filter((f) => f.selected);
                    return {
                        ...item,
                        ...(queuePosition !== undefined ? { queuePosition } : {}),
                        selectedFileCount: selectedFiles.length,
                        totalFileCount: files.length,
                    };
                }
            } catch {
                // getFiles pode falhar — retornar item sem enriquecimento de arquivos
            }
            return { ...item, ...(queuePosition !== undefined ? { queuePosition } : {}) };
        });
    }

    // ── restoreSession ──────────────────────────────────────────────────────────

    async restoreSession(): Promise<void> {
        if (!this.sessionRepository) return;

        this.sessionPersistenceBlocked = true;
        await this._restoreSession();
        this.sessionPersistenceBlocked = false;
        this.persistSession();
    }

    private async _restoreSession(): Promise<void> {
        if (!this.sessionRepository) return;
        const persisted = this.sessionRepository.read();

        for (const entry of persisted) {
            const validation = validatePersistedDownloadItem(entry);
            if (!validation.valid) {
                this.log.warn(
                    '[DownloadManager] Item persistido inválido, ignorando:',
                    validation.reason,
                );
                continue;
            }
            const persistedItem = validation.item;
            if (validation.metadata)
                this.confirmedMetadata.set(persistedItem.infoHash, validation.metadata);
            if (persistedItem.creator !== undefined) {
                this._metadataCache.set(persistedItem.infoHash, {
                    infoHash: persistedItem.infoHash,
                    creator: persistedItem.creator,
                    comment: persistedItem.comment ?? null,
                    creationDate: persistedItem.creationDate ?? null,
                });
            }
            const folderExists = existsSync(persistedItem.destinationFolder);

            let status: TorrentStatus =
                persistedItem.status === 'seeding' ? 'completed' : persistedItem.status;
            if (!folderExists && persistedItem.status !== 'completed') {
                status = 'files-not-found';
            }

            // Restore the item into the in-memory map
            const item: DownloadItem = {
                infoHash: persistedItem.infoHash,
                name: persistedItem.name,
                totalSize: persistedItem.totalSize,
                downloadedSize: persistedItem.downloadedSize,
                progress: persistedItem.progress,
                downloadSpeed: 0,
                uploadSpeed: 0,
                numPeers: 0,
                numSeeders: 0,
                timeRemaining: Infinity,
                status,
                destinationFolder: persistedItem.destinationFolder,
                addedAt: persistedItem.addedAt,
                seedingDisabled: persistedItem.seedingDisabled === true,
                ...(persistedItem.selectedFileCount !== undefined
                    ? { selectedFileCount: persistedItem.selectedFileCount }
                    : {}),
                ...(persistedItem.totalFileCount !== undefined
                    ? { totalFileCount: persistedItem.totalFileCount }
                    : {}),
                ...(persistedItem.completedAt !== undefined
                    ? { completedAt: persistedItem.completedAt }
                    : {}),
                ...(persistedItem.elapsedMs !== undefined
                    ? { elapsedMs: persistedItem.elapsedMs }
                    : {}),
                ...(persistedItem.errorMessage !== undefined
                    ? { errorMessage: persistedItem.errorMessage }
                    : {}),
                ...(persistedItem.pauseReason === 'disk-space'
                    ? { pauseReason: persistedItem.pauseReason }
                    : {}),
            };

            this.items.set(item.infoHash, item);
            if (validation.files) this.fileCatalog.set(item.infoHash, validation.files);
            this.emit('update', item);

            // Arquivos/buffers legados podem ter apenas metadados inline. O magnet
            // derivado identifica o torrent; _addStoredTorrent prioriza esses bytes.
            const restoredMagnetUri =
                persistedItem.magnetUri ??
                (this.confirmedMetadata.has(item.infoHash)
                    ? `magnet:?xt=urn:btih:${item.infoHash}`
                    : undefined);
            if (restoredMagnetUri) {
                this.originalMagnetUris.set(item.infoHash, restoredMagnetUri);
            }

            // Restore selected file indices into the map for later persistence
            if (persistedItem.selectedFileIndices) {
                this.selectedFileIndicesMap.set(item.infoHash, [
                    ...persistedItem.selectedFileIndices,
                ]);
            }

            // Auto-resume items that were downloading; re-queue items that were queued
            if (persistedItem.status === 'queued' && folderExists) {
                // Restaurar como queued — adicionar à fila sem iniciar
                const queued: DownloadItem = { ...item, status: 'queued' };
                this.items.set(item.infoHash, queued);

                if (restoredMagnetUri) {
                    this.queuedMagnetUris.set(item.infoHash, restoredMagnetUri);
                }

                this._enqueue(item.infoHash);
                this.emit('update', queued);
                continue;
            }

            const shouldResume =
                (persistedItem.status === 'downloading' ||
                    persistedItem.status === 'resolving-metadata') &&
                folderExists;

            if (shouldResume) {
                // Verificar se há slots disponíveis
                // Nota: o item já está no mapa com status 'downloading' da sessão anterior,
                // mas ainda não foi adicionado ao engine. Não contá-lo como ativo.
                const activeExcludingSelf = this._activeCountExcluding(item.infoHash);
                if (activeExcludingSelf >= this.maxConcurrent) {
                    // Sem slots — enfileirar
                    const queued: DownloadItem = { ...item, status: 'queued' };
                    this.items.set(item.infoHash, queued);

                    // Guardar a referência para retomar depois
                    if (restoredMagnetUri) {
                        this.queuedMagnetUris.set(item.infoHash, restoredMagnetUri);
                    }

                    this._enqueue(item.infoHash);
                    this.emit('update', queued);
                    continue;
                }

                try {
                    // Re-add to engine using magnetUri or torrentFilePath
                    let restoredInfo: TorrentInfo | undefined;
                    await this._ensureDiskSpace(
                        item.destinationFolder,
                        Math.max(0, item.totalSize - item.downloadedSize),
                        item.infoHash,
                    );
                    if (restoredMagnetUri) {
                        restoredInfo = await this._addStoredTorrent(item, restoredMagnetUri);
                    } else if (persistedItem.torrentFilePath) {
                        restoredInfo = await this.engine.addTorrentFile(
                            persistedItem.torrentFilePath,
                            false,
                            this._torrentOptions(item),
                        );
                    }

                    // Reapply file selection if persisted (ignoring invalid indices)
                    if (
                        persistedItem.selectedFileIndices &&
                        persistedItem.selectedFileIndices.length > 0
                    ) {
                        try {
                            const files = this.engine.getFiles(item.infoHash);
                            const maxIndex = files.length;
                            const validIndices = persistedItem.selectedFileIndices.filter(
                                (idx) => idx >= 0 && idx < maxIndex,
                            );
                            if (validIndices.length > 0) {
                                this.engine.setFileSelection(item.infoHash, validIndices);
                                this.selectedFileIndicesMap.set(item.infoHash, validIndices);
                            }
                        } catch (selectionErr) {
                            this.log.warn(
                                '[DownloadManager] Falha ao reaplicar seleção de arquivos:',
                                item.infoHash.slice(0, 8),
                                (selectionErr as Error).message,
                            );
                        }
                    }

                    // Update status to downloading after successful re-add
                    const updated: DownloadItem = {
                        ...item,
                        status:
                            restoredInfo?.status === 'resolving-metadata'
                                ? 'resolving-metadata'
                                : 'downloading',
                    };
                    this.items.set(item.infoHash, updated);
                    this.emit('update', updated);
                    if (updated.status === 'resolving-metadata')
                        this._startMetadataTimer(item.infoHash);
                } catch (restoreErr) {
                    if (
                        (restoreErr as Error).message === ErrorCodes.DISK_SPACE_LOW ||
                        (restoreErr as Error).message === ErrorCodes.DISK_SPACE_UNAVAILABLE
                    ) {
                        this._markDiskPaused(item, (restoreErr as Error).message);
                        continue;
                    }
                    // Falha ao re-adicionar — marcar como erro com mensagem
                    const errMsg = (restoreErr as Error).message;
                    this.log.error(
                        '[DownloadManager] Falha ao restaurar torrent:',
                        item.infoHash.slice(0, 8),
                        errMsg,
                    );
                    const errItem: DownloadItem = {
                        ...item,
                        status: 'error',
                        errorMessage: errMsg,
                    };
                    this.items.set(item.infoHash, errItem);
                    this.emit('update', errItem);
                }
            }
        }
        await this.applySeedingSettings();
    }

    // ── persistSession ──────────────────────────────────────────────────────────

    persistSession(): void {
        if (!this.sessionRepository) return;
        if (this.sessionPersistenceBlocked) {
            this.log.warn('[DownloadManager] Sessão original preservada: restauração incompleta');
            return;
        }

        const items = Array.from(this.items.values());
        const persisted: PersistedDownloadItem[] = items.map((item) => {
            const files = this.getFiles(item.infoHash);
            const metadata = this.engine.getTorrentFile?.(item.infoHash);
            if (metadata) this.confirmedMetadata.set(item.infoHash, metadata);
            const magnetUri =
                this.originalMagnetUris.get(item.infoHash) ??
                this.queuedMagnetUris.get(item.infoHash);
            const selectedFileIndices = this.selectedFileIndicesMap.get(item.infoHash);
            const cachedMeta = this._metadataCache.get(item.infoHash);
            return serializePersistedDownloadItem({
                item,
                files,
                ...(selectedFileIndices !== undefined ? { selectedFileIndices } : {}),
                ...(magnetUri !== undefined ? { magnetUri } : {}),
                ...(this.confirmedMetadata.has(item.infoHash)
                    ? {
                          torrentFileBase64: this.confirmedMetadata
                              .get(item.infoHash)!
                              .toString('base64'),
                      }
                    : {}),
                ...(cachedMeta !== undefined ? { cachedMetadata: cachedMeta } : {}),
            });
        });

        this.sessionRepository.write(persisted, this.queue);
    }

    // ── setMaxConcurrentDownloads ───────────────────────────────────────────────

    setMaxConcurrentDownloads(max: number): void {
        this.maxConcurrent = max;
        // Se o novo limite é maior, processar a fila para iniciar downloads pendentes
        this._processQueue();
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /** Uma falha ao salvar não pode interromper o tratamento do erro nem a fila. */
    private _persistSessionAfterEngineError(): void {
        try {
            this.persistSession();
        } catch (error) {
            this.log.warn(
                '[DownloadManager] Falha ao persistir sessão após erro da engine:',
                (error as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN',
            );
        }
    }

    /**
     * Serializa operações por torrent: encadeia a próxima operação na Promise
     * anterior para o mesmo infoHash, garantindo que pause/resume não se
     * sobreponham. Se a operação anterior falhou, a próxima ainda executa.
     */
    private _withLock<T>(infoHash: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.opLocks.get(infoHash) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        this.opLocks.set(infoHash, next);
        // Limpar o lock quando a cadeia terminar para não acumular memória
        next.catch(() => {}).then(() => {
            if (this.opLocks.get(infoHash) === next) {
                this.opLocks.delete(infoHash);
            }
        });
        return next;
    }

    /**
     * Limpa recursos órfãos: entries em metadataTimers,
     * selectedFileIndicesMap e queuedMagnetUris que não possuem item
     * correspondente no mapa de downloads. Isso pode acontecer se uma
     * remoção falhar parcialmente ou se houver um bug de sincronização.
     */
    private _cleanupOrphans(): void {
        const queued = new Set(this.queue);
        for (const hash of this.queuedContexts.keys()) {
            if (!queued.has(hash)) this.queuedContexts.delete(hash);
        }
        let cleaned = 0;

        for (const infoHash of this.metadataTimers.keys()) {
            if (!this.items.has(infoHash)) {
                this._clearMetadataTimer(infoHash);
                cleaned++;
            }
        }

        for (const infoHash of this.selectedFileIndicesMap.keys()) {
            if (!this.items.has(infoHash)) {
                this.selectedFileIndicesMap.delete(infoHash);
                cleaned++;
            }
        }

        for (const infoHash of this.queuedMagnetUris.keys()) {
            if (!this.items.has(infoHash)) {
                this.queuedMagnetUris.delete(infoHash);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            this.log.warn(
                `[DownloadManager] Limpeza periódica: ${cleaned} recurso(s) órfão(s) removido(s)`,
            );
        }
    }

    /**
     * Aplica trackers globais automaticamente a um torrent recém-adicionado.
     * Só executa se a opção `autoApplyGlobalTrackers` estiver habilitada.
     * Erros individuais (ex: tracker duplicado) são silenciosamente ignorados
     * para não interromper a operação de adição do torrent.
     */
    private _applyGlobalTrackers(infoHash: string): void {
        try {
            const { autoApplyGlobalTrackers } = this.settings.get();
            if (!autoApplyGlobalTrackers) return;

            const globalTrackers = this.settings.getGlobalTrackers();
            if (globalTrackers.length === 0) return;

            for (const trackerUrl of globalTrackers) {
                try {
                    this.engine.addTracker(infoHash, trackerUrl);
                } catch (trackerErr) {
                    this.log.warn(
                        '[DownloadManager] Falha ao aplicar tracker global:',
                        infoHash.slice(0, 8),
                        trackerUrl,
                        (trackerErr as Error).message,
                    );
                }
            }
        } catch (err) {
            this.log.warn(
                '[DownloadManager] Falha ao aplicar trackers globais:',
                infoHash.slice(0, 8),
                (err as Error).message,
            );
        }
    }

    /** Clears and removes the pending metadata-resolution timer for the given infoHash. */
    private _clearMetadataTimer(infoHash: string): void {
        const timer = this.metadataTimers.get(infoHash);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.metadataTimers.delete(infoHash);
        }
    }

    /** Inicia o timer de 60s para resolução de metadados de magnet links. */
    private _startMetadataTimer(infoHash: string): void {
        this._clearMetadataTimer(infoHash);
        const timer = setTimeout(async () => {
            try {
                const current = this.items.get(infoHash);
                if (current && current.status === 'resolving-metadata') {
                    try {
                        await this.engine.pause(infoHash);
                    } catch (err) {
                        this.log.warn('[DownloadManager] Falha ao suspender metadados:', err);
                        return;
                    }
                    if (this.items.get(infoHash) !== current) return;
                    const failed: DownloadItem = { ...current, status: 'metadata-failed' };
                    this.items.set(infoHash, failed);
                    this.metadataTimers.delete(infoHash);
                    this.emit('update', failed);

                    // Um slot foi liberado — processar a fila
                    this._processQueue();
                }
            } catch (err) {
                this.log.error(
                    '[DownloadManager] Erro inesperado no timer de metadados:',
                    infoHash.slice(0, 8),
                    (err as Error).message,
                );
            }
        }, METADATA_TIMEOUT_MS);
        timer.unref?.();
        this.metadataTimers.set(infoHash, timer);
    }

    /** Retorna true se o status indica um download ativo (ocupando um slot). */
    private _isActiveStatus(status: TorrentStatus | undefined): boolean {
        return status === 'downloading' || status === 'resolving-metadata';
    }

    /** Conta quantos downloads estão ativos (ocupando slots). */
    private _activeCount(): number {
        let count = this.pendingAdds;
        for (const item of this.items.values()) {
            if (this._isActiveStatus(item.status)) {
                count++;
            }
        }
        return count;
    }

    /** Conta downloads ativos excluindo um infoHash específico (usado em restoreSession). */
    private _activeCountExcluding(excludeHash: string): number {
        let count = this.pendingAdds;
        for (const item of this.items.values()) {
            if (item.infoHash !== excludeHash && this._isActiveStatus(item.status)) {
                count++;
            }
        }
        return count;
    }

    /**
     * Processa a fila: inicia o próximo download enfileirado se há slots disponíveis.
     * Chamado automaticamente quando um download completa, falha, é pausado ou removido.
     */
    private _torrentOptions(item: DownloadItem): import('./torrentEngine').TorrentAddOptions {
        const selectedFileIndices = this.selectedFileIndicesMap.get(item.infoHash);
        return {
            destinationFolder: item.destinationFolder,
            ...(selectedFileIndices ? { selectedFileIndices } : {}),
        };
    }

    private _addStoredTorrent(item: DownloadItem, magnetUri: string): Promise<TorrentInfo> {
        const buffer = this.confirmedMetadata.get(item.infoHash);
        return buffer
            ? this.engine.addTorrentBuffer(buffer, false, this._torrentOptions(item))
            : this.engine.addMagnetLink(magnetUri, false, this._torrentOptions(item));
    }

    private _enqueue(infoHash: string): void {
        const context = getOperationContext();
        if (context) this.queuedContexts.set(infoHash, context);
        else this.queuedContexts.delete(infoHash);
        this.queue.push(infoHash);
    }

    private _processQueue(): void {
        if (this.engine.isRestarting?.()) return;
        if (this.diskSpace) {
            if (this.processingDiskQueue) return;
            this.processingDiskQueue = true;
            void (async () => {
                while (this.queue.length > 0 && this._activeCount() < this.maxConcurrent) {
                    const hash = this.queue[0]!;
                    const item = this.items.get(hash);
                    if (!item || item.status !== 'queued') {
                        this.queue.shift();
                        continue;
                    }
                    try {
                        await runWithOperationContext(this.queuedContexts.get(hash), () =>
                            traceOperation('download.queue.start', () => this.resume(hash)),
                        );
                        this.queuedContexts.delete(hash);
                    } catch (error) {
                        const current = this.items.get(hash);
                        if (current?.status === 'queued')
                            this._markDiskPaused(current, (error as Error).message);
                    }
                }
                this.persistSession();
            })()
                .catch((error) => this.log.warn('[DownloadManager] Falha na fila:', error))
                .finally(() => {
                    this.processingDiskQueue = false;
                });
            return;
        }
        while (this.queue.length > 0 && this._activeCount() < this.maxConcurrent) {
            const infoHash = this.queue.shift()!;
            const queueContext = this.queuedContexts.get(infoHash);
            this.queuedContexts.delete(infoHash);
            const item = this.items.get(infoHash);

            if (!item || item.status !== 'queued') {
                continue;
            }

            // Se é um magnet enfileirado que nunca foi adicionado ao engine
            if (this.queuedMagnetUris.has(infoHash)) {
                const magnetUri = this.queuedMagnetUris.get(infoHash)!;
                this.queuedMagnetUris.delete(infoHash);

                // Atualizar status sincronamente para ocupar o slot antes da operação async
                const starting: DownloadItem = { ...item, status: 'resolving-metadata' };
                this.items.set(infoHash, starting);
                this.emit('update', starting);

                // Adicionar ao engine de forma assíncrona
                runWithOperationContext(queueContext, () =>
                    traceOperation('download.queue.start', () =>
                        this._addStoredTorrent(item, magnetUri)
                            .then((info) => {
                                const current = this.items.get(infoHash);
                                if (!current || !this._isActiveStatus(current.status)) return;

                                const updated: DownloadItem = {
                                    ...current,
                                    name: info.name || current.name,
                                    totalSize: this.selectedFileIndicesMap.has(infoHash)
                                        ? current.totalSize
                                        : info.totalSize || current.totalSize,
                                    status:
                                        info.status === 'downloading'
                                            ? 'downloading'
                                            : 'resolving-metadata',
                                };
                                this.items.set(infoHash, updated);
                                this.emit('update', updated);

                                if (updated.status === 'resolving-metadata')
                                    this._startMetadataTimer(infoHash);
                            })
                            .catch((err) => {
                                this.log.error(
                                    '[DownloadManager] Falha ao iniciar torrent da fila:',
                                    infoHash.slice(0, 8),
                                    (err as Error).message,
                                );
                                const current = this.items.get(infoHash);
                                if (current) {
                                    const errItem: DownloadItem = {
                                        ...current,
                                        status: 'error',
                                        errorMessage: (err as Error).message,
                                    };
                                    this.items.set(infoHash, errItem);
                                    this.emit('update', errItem);
                                }
                                // Tentar o próximo da fila
                                this._processQueue();
                            }),
                    ),
                );

                continue;
            }

            // Atualizar status sincronamente para ocupar o slot antes da operação async
            const resuming: DownloadItem = { ...item, status: 'downloading' };
            this.items.set(infoHash, resuming);
            this.emit('update', resuming);

            // Torrent já está no engine (foi pausado ao enfileirar) — retomar
            runWithOperationContext(queueContext, () =>
                traceOperation('download.queue.start', () =>
                    this.engine
                        .resume(infoHash)
                        .then(() => {
                            // Status já foi atualizado sincronamente; emitir novamente para garantir consistência
                            const current = this.items.get(infoHash);
                            if (current && current.status === 'downloading') {
                                this.emit('update', current);
                            }
                        })
                        .catch((err) => {
                            this.log.error(
                                '[DownloadManager] Falha ao retomar torrent da fila:',
                                infoHash.slice(0, 8),
                                (err as Error).message,
                            );
                            const current = this.items.get(infoHash);
                            if (current) {
                                const errItem: DownloadItem = {
                                    ...current,
                                    status: 'error',
                                    errorMessage: (err as Error).message,
                                };
                                this.items.set(infoHash, errItem);
                                this.emit('update', errItem);
                            }
                            // Tentar o próximo da fila
                            this._processQueue();
                        }),
                ),
            );
        }
    }

    // ── reorderQueue ────────────────────────────────────────────────────────────

    reorderQueue(infoHash: string, newIndex: number): string[] {
        // Validar que o infoHash está na fila
        const currentIndex = this.queue.indexOf(infoHash);
        if (currentIndex === -1) {
            throw new Error('Item não encontrado na fila');
        }

        // Validar que newIndex está dentro dos limites
        if (newIndex < 0 || newIndex >= this.queue.length) {
            throw new Error('Posição inválida na fila');
        }

        // Remover da posição atual e inserir na nova posição
        this.queue.splice(currentIndex, 1);
        this.queue.splice(newIndex, 0, infoHash);

        // Emitir evento update para o item movido com queuePosition atualizado
        const item = this.items.get(infoHash);
        if (item) {
            const updated: DownloadItem = {
                ...item,
                queuePosition: newIndex + 1,
            };
            this.items.set(infoHash, updated);
            this.emit('update', updated);
        }

        return [...this.queue];
    }

    // ── getQueueOrder ───────────────────────────────────────────────────────────

    getQueueOrder(): string[] {
        return [...this.queue];
    }

    // ── getCachedMetadata ───────────────────────────────────────────────────────

    getCachedMetadata(infoHash: string): TorrentMetadata | undefined {
        return this._metadataCache.get(infoHash);
    }

    // ── EventEmitter overloads (type-safe) ──────────────────────────────────────

    on(event: 'update', listener: (item: DownloadItem) => void): this;
    on(event: 'remove', listener: (infoHash: string) => void): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a new DownloadManager instance.
 *
 * @param engine    TorrentEngine instance to delegate torrent operations to.
 * @param settings  SettingsManager instance to read configuration from.
 * @param store     Optional persisted store for session persistence (injectable for tests).
 * @param log       Optional logger instance (defaults to electron-log; injectable for tests).
 * @param options   Optional configuration (e.g., disableCleanupTimer for tests).
 */
export function createDownloadManager(
    engine: DownloadManagerEngine,
    settings: SettingsManager,
    store?: PersistedStore,
    log?: Logger,
    options?: {
        disableCleanupTimer?: boolean;
        diskSpace?: DiskSpaceService;
        torrentFiles?: TorrentFilesService;
        recoverMetadata?: (magnetUri: string) => Promise<PreparedTorrent>;
    },
): DownloadManager {
    return new DownloadManagerImpl(engine, settings, store, log, options);
}

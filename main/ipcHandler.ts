import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import { existsSync, accessSync, statSync, constants as fsConstants } from 'fs';
import { resolve, basename } from 'path';
import type { DownloadManager } from './downloadManager';
import type { SettingsManager } from './settingsManager';
import type { TorrentEngine } from './torrentEngine';
import type { BandwidthController } from './bandwidthController';
import type { DownloadDiagnostics } from './downloadDiagnostics';
import { createDefaultBandwidthSettings, getEffectiveBandwidth } from '../shared/bandwidth';
import { performBatchAction } from './batchActions';
import type { BatchAction, BatchActionResult, BandwidthStatus } from '../shared/types';
import type {
    DownloadItem,
    AppSettings,
    IPCResponse,
    TorrentFileInfo,
    TrackerInfo,
    TorrentMetadata,
    PeerInfo,
    PieceStatus,
    MagnetHandlerStatus,
} from '../shared/types';
import { isValidTorrentFile, hasTorrentMagicBytes, MAX_TORRENT_BYTES } from './validators';
import { isValidTrackerUrl } from '../shared/validators';
import { ErrorCodes } from '../shared/errorCodes';
import { logger, createScopedLogger } from './logger';
import type { ScopedLogger } from './logger';
import { metrics } from './metrics';
import type { MetricsSnapshot } from './metrics';
import {
    validatePayload,
    infoHashSchema,
    infoHashHexSchema,
    infoHashUrlSchema,
    urlSchema,
} from './payloadValidator';
import { validateSettingsPayload } from './settingsValidator';
import { randomBytes } from 'crypto';
import type { TorrentPreparation } from './torrentPreparation';
import type { TorrentSource } from '../shared/types';
import type { ExternalTorrentInbox } from './externalTorrents';
import { resolveTorrentFile } from './torrentFiles';
import { isTrustedIpcSender } from './rendererSecurity';
import { canOpenDownloadedFile } from './fileOpening';
import type { UpdateManager } from './updateManager';

export type { IPCResponse } from '../shared/types';

// ─── Correlation ID ───────────────────────────────────────────────────────────

/** Gera um correlation ID curto (8 caracteres hex) para rastreamento de operações IPC */
function generateCorrelationId(): string {
    return randomBytes(4).toString('hex');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok<T>(data: T): IPCResponse<T> {
    return { success: true, data };
}

function fail(error: string): IPCResponse<never> {
    return { success: false, error };
}

function failWithLog(channel: string, err: unknown, scopedLog?: ScopedLogger): IPCResponse<never> {
    const message = err instanceof Error ? err.message : String(err);
    if (scopedLog) {
        scopedLog.error('Falha na operação', { errorCode: message });
    } else {
        logger.error(`[IPC] ${channel} failed:`, message);
    }
    // Retornar código genérico para não vazar caminhos de SO, nomes de classe
    // ou stack traces internos para o renderer. O erro completo fica apenas nos logs.
    const known = Object.values(ErrorCodes).some((code) => code === message);
    return { success: false, error: known ? message : ErrorCodes.OPERATION_FAILED };
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

/**
 * Verifica se um caminho de diretório tem permissão de escrita.
 * Retorna false em caso de erro (diretório inacessível, sem permissão, etc).
 */
function hasWritePermission(dirPath: string): boolean {
    try {
        accessSync(dirPath, fsConstants.W_OK);
        return true;
    } catch {
        return false;
    }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

/**
 * Rate limiter simples por canal IPC usando sliding window.
 * Limita o número de chamadas por segundo para evitar abuso do renderer.
 */
class ChannelRateLimiter {
    private readonly timestamps = new Map<string, number[]>();
    private readonly maxPerSecond: number;

    constructor(maxPerSecond: number) {
        this.maxPerSecond = maxPerSecond;
    }

    /**
     * Tenta consumir um token para o canal. Retorna true se permitido.
     */
    tryConsume(channel: string): boolean {
        const now = Date.now();
        const windowStart = now - 1000;

        let calls = this.timestamps.get(channel);
        if (!calls) {
            calls = [];
            this.timestamps.set(channel, calls);
        }

        // Remover timestamps fora da janela de 1 segundo
        // noUncheckedIndexedAccess: calls[0] é garantido pela guarda calls.length > 0
        while (calls.length > 0 && calls[0]! <= windowStart) {
            calls.shift();
        }

        if (calls.length >= this.maxPerSecond) {
            return false;
        }

        calls.push(now);
        return true;
    }

    /** Limpa todos os timestamps. Útil para testes. */
    reset(): void {
        this.timestamps.clear();
    }
}

/** Rate limiter global para todos os canais IPC (500 chamadas/segundo por canal) */
const rateLimiter = new ChannelRateLimiter(500);

// Exportado para permitir reset nos testes
export { rateLimiter as _rateLimiter };

/** Código de erro para rate limiting (centralizado em ErrorCodes) */
const RATE_LIMITED = ErrorCodes.RATE_LIMITED;

/** Timeout padrão para operações IPC (30 segundos) */
const IPC_TIMEOUT_MS = 30_000;

/**
 * Envolve uma Promise com um timeout. Se a operação não completar dentro do
 * prazo, rejeita com um erro descritivo incluindo o nome do canal IPC.
 */
function withTimeout<T>(
    promise: Promise<T>,
    channel: string,
    timeoutMs = IPC_TIMEOUT_MS,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Operação expirou após ${timeoutMs}ms`));
        }, timeoutMs);

        promise
            .then((result) => {
                clearTimeout(timer);
                resolve(result);
            })
            .catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

// ─── Metrics wrapper ──────────────────────────────────────────────────────────

/**
 * Envolve um handler IPC com tracking de latência e contagem de erros.
 * Mede o tempo de execução e registra no coletor de métricas.
 * Em modo debug, loga a latência de cada chamada.
 */
function withMetrics<T>(
    channel: string,
    correlationId: string,
    handler: () => Promise<IPCResponse<T>>,
): Promise<IPCResponse<T>> {
    const start = Date.now();
    return handler().then((result) => {
        const durationMs = Date.now() - start;
        metrics.recordIpcCall(channel, durationMs, result.success);
        logger.debug(
            `[IPC] ${channel} concluído`,
            `cid=${correlationId}`,
            `durationMs=${durationMs}`,
            `success=${result.success}`,
        );
        return result;
    });
}

// ─── Handler registration ─────────────────────────────────────────────────────

/**
 * Sets up per-window resources: the 1-second progress interval and
 * error forwarding from the TorrentEngine to the renderer.
 *
 * Call this for each new BrowserWindow. The interval is automatically
 * cleared when the window is closed.
 */
export function attachWindowEvents(
    downloadManager: DownloadManager,
    torrentEngine: TorrentEngine,
    mainWindow: BrowserWindow,
    diagnostics?: DownloadDiagnostics,
): void {
    // ── Progress interval (1 s) ───────────────────────────────────────────────
    const progressInterval = setInterval(() => {
        if (!mainWindow.isDestroyed()) {
            const items = downloadManager.getAll();
            mainWindow.webContents.send('torrent:progress', diagnostics?.enrich(items) ?? items);
        }
    }, 1000);

    mainWindow.on('closed', () => {
        clearInterval(progressInterval);
    });

    // ── TorrentEngine error forwarding ────────────────────────────────────────
    const errorListener = (infoHash: string, err: Error) => {
        metrics.recordEngineError();
        const stack = err.stack?.split('\n').slice(0, 3).join(' | ') ?? '';
        logger.error('[IPC] Engine error:', infoHash.slice(0, 8), err.message, stack);
        if (
            !mainWindow.isDestroyed() &&
            !downloadManager.getAll().find((item) => item.infoHash === infoHash)?.fileOperation &&
            !downloadManager.getAll().find((item) => item.infoHash === infoHash)?.pauseReason
        ) {
            mainWindow.webContents.send('torrent:error', { infoHash, message: err.message });
        }
    };
    torrentEngine.on('error', errorListener);

    mainWindow.on('closed', () => {
        torrentEngine.removeListener('error', errorListener);
    });
}

/**
 * Registers all IPC handlers for the Meshy application.
 *
 * IMPORTANT: Call this only ONCE during the app lifecycle. IPC handlers
 * registered via `ipcMain.handle` are global — calling this a second time
 * will throw because the channels are already registered.
 *
 * For per-window setup (progress interval, error forwarding), use
 * `attachWindowEvents` instead.
 *
 * Each handler:
 * - Validates its input payload via `validatePayload` and returns `{ success: false, error }` for invalid payloads.
 * - Wraps all logic in try/catch, never throwing an unhandled exception.
 * - Returns a typed `IPCResponse<T>`.
 */
export function registerIpcHandlers(
    downloadManager: DownloadManager,
    settingsManager: SettingsManager,
    torrentEngine?: TorrentEngine,
    preparation?: TorrentPreparation,
    desktop?: {
        inbox: ExternalTorrentInbox;
        registerMagnetHandler: () => Promise<MagnetHandlerStatus>;
        getMagnetHandlerStatus: () => Promise<MagnetHandlerStatus>;
        openMagnetDefaultApps: () => Promise<void>;
        bandwidth?: BandwidthController;
        diagnostics?: DownloadDiagnostics;
        updates?: UpdateManager;
    },
): void {
    // ── Wrapper para tracking automático de métricas ──────────────────────────
    // Intercepta ipcMain.handle para medir latência e contar erros de cada canal.
    // Inclui rate limiting para proteger contra abuso do renderer.
    const trackedHandle = <T>(
        channel: string,
        handler: (event: Electron.IpcMainInvokeEvent, payload: unknown) => Promise<IPCResponse<T>>,
    ): void => {
        ipcMain.handle(channel, async (event, payload) => {
            if (!isTrustedIpcSender(event)) return fail(ErrorCodes.INVALID_PARAMS);
            const cid = generateCorrelationId();
            if (!rateLimiter.tryConsume(channel)) {
                logger.warn(`[IPC] Rate limit excedido para canal: ${channel} cid=${cid}`);
                return fail(RATE_LIMITED) as IPCResponse<T>;
            }
            return withMetrics(channel, cid, () => handler(event, payload));
        });
    };

    for (const [channel, action] of [
        ['app:update-status', 'getStatus'],
        ['app:check-updates', 'check'],
        ['app:install-update', 'install'],
    ] as const) {
        trackedHandle(channel, async (_event, payload) => {
            if (payload !== undefined) return fail(ErrorCodes.INVALID_PARAMS);
            if (!desktop?.updates) return fail(ErrorCodes.UPDATE_UNAVAILABLE);
            try {
                return ok(await desktop.updates[action]());
            } catch (error) {
                return failWithLog(channel, error);
            }
        });
    }

    const applyBandwidth = (force = false) => {
        if (desktop?.bandwidth) return desktop.bandwidth.refresh(force);
        const status = getEffectiveBandwidth(settingsManager.get());
        torrentEngine?.setDownloadSpeedLimit?.(status.downloadLimit);
        torrentEngine?.setUploadSpeedLimit?.(status.uploadLimit);
        return status;
    };
    trackedHandle('bandwidth:get-status', async (): Promise<IPCResponse<BandwidthStatus>> => {
        try {
            return ok(
                desktop?.bandwidth?.getStatus() ?? getEffectiveBandwidth(settingsManager.get()),
            );
        } catch (error) {
            return failWithLog('bandwidth:get-status', error);
        }
    });
    trackedHandle(
        'bandwidth:set-light',
        async (_event, payload): Promise<IPCResponse<BandwidthStatus>> => {
            try {
                if (
                    !payload ||
                    typeof payload !== 'object' ||
                    typeof (payload as { enabled?: unknown }).enabled !== 'boolean'
                )
                    return fail(ErrorCodes.INVALID_PARAMS);
                if (torrentEngine?.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);
                settingsManager.set({
                    bandwidth: {
                        ...(settingsManager.get().bandwidth ?? createDefaultBandwidthSettings()),
                        manualEnabled: (payload as { enabled: boolean }).enabled,
                    },
                });
                return ok(applyBandwidth());
            } catch (error) {
                return failWithLog('bandwidth:set-light', error);
            }
        },
    );
    let batchBusy = false;
    trackedHandle(
        'torrent:batch-action',
        async (_event, payload): Promise<IPCResponse<BatchActionResult[]>> => {
            if (!payload || typeof payload !== 'object') return fail(ErrorCodes.INVALID_PARAMS);
            const { infoHashes, operation, deleteFiles } = payload as {
                infoHashes?: unknown;
                operation?: unknown;
                deleteFiles?: unknown;
            };
            if (
                !Array.isArray(infoHashes) ||
                !infoHashes.length ||
                infoHashes.length > 200 ||
                !infoHashes.every(
                    (hash) => typeof hash === 'string' && /^[a-f0-9]{40}$/i.test(hash),
                ) ||
                new Set(infoHashes).size !== infoHashes.length ||
                !['pause', 'resume', 'remove'].includes(operation as string) ||
                (deleteFiles !== undefined && typeof deleteFiles !== 'boolean') ||
                (operation === 'remove' && typeof deleteFiles !== 'boolean')
            )
                return fail(ErrorCodes.INVALID_PARAMS);
            if (batchBusy) return fail(ErrorCodes.OPERATION_FAILED);
            batchBusy = true;
            try {
                return ok(
                    await performBatchAction(
                        downloadManager,
                        infoHashes,
                        operation as BatchAction,
                        deleteFiles === true,
                        () => torrentEngine?.isRestarting() ?? false,
                    ),
                );
            } catch (error) {
                return failWithLog('torrent:batch-action', error);
            } finally {
                batchBusy = false;
            }
        },
    );

    trackedHandle('dialog:select-torrent-files', async (): Promise<IPCResponse<string[]>> => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openFile', 'multiSelections'],
                filters: [{ name: 'Torrent', extensions: ['torrent'] }],
            });
            if (result.canceled || !result.filePaths.length)
                return fail(ErrorCodes.NO_FILE_SELECTED);
            return ok(result.filePaths.slice(0, 200));
        } catch (error) {
            return failWithLog('dialog:select-torrent-files', error);
        }
    });

    // ── torrent:add-file ──────────────────────────────────────────────────────
    const requestSchema = { requestId: { type: 'string' as const, nonEmpty: true } };
    const requestIdFor = (payload: unknown): string => {
        const result = validatePayload<{ requestId: string }>(payload, requestSchema);
        if (!result.valid || !/^[a-zA-Z0-9-]{8,80}$/.test(result.data.requestId))
            throw new Error(ErrorCodes.INVALID_PARAMS);
        return result.data.requestId;
    };
    const selectionFor = (
        event: Electron.IpcMainInvokeEvent,
        payload: unknown,
    ): { requestId: string; destinationFolder: string; selectedIndices: number[] } => {
        const requestId = scopedRequestId(event, requestIdFor(payload));
        const data = payload as Record<string, unknown>;
        if (
            typeof data.destinationFolder !== 'string' ||
            !data.destinationFolder.trim() ||
            !Array.isArray(data.selectedIndices)
        )
            throw new Error(ErrorCodes.INVALID_PARAMS);
        const selectedIndices: number[] = [];
        for (const index of data.selectedIndices) {
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
                throw new Error(ErrorCodes.FILE_INDEX_INVALID);
            selectedIndices.push(index);
        }
        if (!preparation) throw new Error(ErrorCodes.ENGINE_NOT_AVAILABLE);
        const draft = preparation.get(requestId);
        if (
            !selectedIndices.every((index) =>
                draft.preview.files.some((file) => file.index === index),
            )
        )
            throw new Error(ErrorCodes.FILE_INDEX_INVALID);
        return {
            requestId,
            destinationFolder: resolve(data.destinationFolder),
            selectedIndices: [...new Set(selectedIndices)],
        };
    };

    const scopedRequestId = (event: Electron.IpcMainInvokeEvent, requestId: string): string => {
        if (
            event.senderFrame &&
            event.sender?.mainFrame &&
            event.senderFrame !== event.sender.mainFrame
        )
            throw new Error(ErrorCodes.INVALID_PARAMS);
        return `${event.sender?.id ?? 0}-${requestId}`;
    };

    trackedHandle('torrent:prepare', async (_event, payload) => {
        try {
            const publicId = requestIdFor(payload);
            const requestId = scopedRequestId(_event, publicId);
            if (!preparation) return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
            const source = (payload as Record<string, unknown>).source as
                Record<string, unknown> | undefined;
            if (!source || typeof source !== 'object') return fail(ErrorCodes.INVALID_PARAMS);
            let input: TorrentSource;
            if (source.kind === 'magnet' && typeof source.magnetUri === 'string')
                input = { kind: 'magnet', magnetUri: source.magnetUri };
            else if (
                source.kind === 'file' &&
                typeof source.filePath === 'string' &&
                source.filePath.trim()
            )
                input = { kind: 'file', filePath: resolve(source.filePath) };
            else if (
                source.kind === 'buffer' &&
                source.buffer instanceof Uint8Array &&
                source.buffer.length > 0 &&
                source.buffer.length <= MAX_TORRENT_BYTES
            )
                input = { kind: 'buffer', buffer: source.buffer };
            else return fail(ErrorCodes.INVALID_PARAMS);
            const preview = await preparation.prepare(requestId, input);
            if (downloadManager.getAll().some((item) => item.infoHash === preview.infoHash)) {
                preparation.cancel(requestId);
                return fail(ErrorCodes.TORRENT_DUPLICATE);
            }
            return ok({ ...preview, requestId: publicId });
        } catch (error) {
            return failWithLog('torrent:prepare', error);
        }
    });
    trackedHandle('torrent:cancel-preparation', async (_event, payload) => {
        try {
            preparation?.cancel(scopedRequestId(_event, requestIdFor(payload)));
            return ok(undefined);
        } catch (error) {
            return failWithLog('torrent:cancel-preparation', error);
        }
    });
    trackedHandle('torrent:disk-space', async (_event, payload) => {
        try {
            const selection = selectionFor(_event, payload);
            const draft = preparation!.get(selection.requestId);
            const bytes = draft.preview.files
                .filter((file) => selection.selectedIndices.includes(file.index))
                .reduce((sum, file) => sum + file.length, 0);
            return ok(
                await downloadManager.getDiskSpace(
                    selection.destinationFolder,
                    bytes,
                    draft.preview.infoHash,
                ),
            );
        } catch (error) {
            return failWithLog('torrent:disk-space', error);
        }
    });
    const confirming = new Set<string>();
    trackedHandle('app:get-external-torrents', async () => ok(desktop?.inbox.getPending() ?? []));
    trackedHandle('app:acknowledge-external-torrent', async (_event, payload) => {
        const result = validatePayload<{ id: string }>(payload, {
            id: { type: 'string', nonEmpty: true },
        });
        if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);
        desktop?.inbox.acknowledge(result.data.id);
        return ok(undefined);
    });
    trackedHandle('app:register-magnet-handler', async () => {
        try {
            if (!desktop) return fail(ErrorCodes.PROTOCOL_REGISTRATION_FAILED);
            return ok(await desktop.registerMagnetHandler());
        } catch (error) {
            return failWithLog('app:register-magnet-handler', error);
        }
    });
    trackedHandle('app:get-magnet-handler-status', async () => {
        try {
            if (!desktop) return fail(ErrorCodes.PROTOCOL_REGISTRATION_FAILED);
            return ok(await desktop.getMagnetHandlerStatus());
        } catch (error) {
            return failWithLog('app:get-magnet-handler-status', error);
        }
    });
    trackedHandle('app:open-magnet-default-apps', async () => {
        try {
            if (!desktop) return fail(ErrorCodes.PROTOCOL_REGISTRATION_FAILED);
            await desktop.openMagnetDefaultApps();
            return ok(undefined);
        } catch (error) {
            return failWithLog('app:open-magnet-default-apps', error);
        }
    });
    trackedHandle('torrent:manage-files', async (_event, payload) => {
        const result = validatePayload<{ infoHash: string }>(payload, infoHashHexSchema);
        if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);
        const { operation, destinationFolder } = payload as Record<string, unknown>;
        if (
            !['locate', 'move', 'verify'].includes(String(operation)) ||
            (operation !== 'verify' &&
                (typeof destinationFolder !== 'string' || !destinationFolder.trim()))
        )
            return fail(ErrorCodes.INVALID_PARAMS);
        if (
            downloadManager.getAll().find((item) => item.infoHash === result.data.infoHash)
                ?.fileOperation
        )
            return fail(ErrorCodes.FILE_OPERATION_BUSY);
        try {
            return ok(
                await downloadManager.manageFiles(
                    result.data.infoHash,
                    operation as import('../shared/types').FileOperation,
                    typeof destinationFolder === 'string' ? resolve(destinationFolder) : undefined,
                ),
            );
        } catch (error) {
            return failWithLog('torrent:manage-files', error);
        }
    });
    trackedHandle('torrent:confirm', async (_event, payload) => {
        let requestId: string | undefined;
        let ownsConfirmation = false;
        try {
            const selection = selectionFor(_event, payload);
            requestId = selection.requestId;
            if (selection.selectedIndices.length === 0)
                return fail(ErrorCodes.FILE_SELECTION_EMPTY);
            if (confirming.has(requestId)) return fail(ErrorCodes.INVALID_PARAMS);
            if (torrentEngine?.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);
            if (
                !existsSync(selection.destinationFolder) ||
                !hasWritePermission(selection.destinationFolder)
            )
                return fail(ErrorCodes.DESTINATION_FOLDER_NOT_FOUND);
            confirming.add(requestId);
            ownsConfirmation = true;
            const item = await downloadManager.addPreparedTorrent(
                preparation!.get(requestId),
                selection.destinationFolder,
                selection.selectedIndices,
            );
            preparation!.cancel(requestId);
            return ok(item);
        } catch (error) {
            return failWithLog('torrent:confirm', error);
        } finally {
            if (requestId && ownsConfirmation) confirming.delete(requestId);
        }
    });

    trackedHandle(
        'torrent:add-file',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ filePath: string }>(payload, {
                    filePath: { type: 'string', nonEmpty: true },
                });
                if (!result.valid) return fail(ErrorCodes.INVALID_FILE_PATH);

                // Resolver o caminho antes de qualquer validação ou uso.
                // Normaliza separadores e resolve componentes relativos como '..'.
                const filePath = resolve(result.data.filePath);

                // Validar extensão .torrent antes de ler o arquivo do filesystem
                if (!isValidTorrentFile(filePath)) {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                logger.info('[IPC] torrent:add-file início:', basename(filePath));
                const item = await withTimeout(
                    downloadManager.addTorrentFile(filePath),
                    'torrent:add-file',
                );
                logger.info('[IPC] torrent:add-file sucesso:', item.infoHash.slice(0, 8));
                return ok(item);
            } catch (err) {
                return failWithLog('torrent:add-file', err);
            }
        },
    );

    // ── torrent:add-file-buffer ───────────────────────────────────────────────
    // Adiciona um torrent a partir de um buffer (Uint8Array) enviado pelo renderer.
    // Necessário para drag-and-drop com sandbox: true, onde File.path não está disponível.
    trackedHandle(
        'torrent:add-file-buffer',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                // Validação manual do campo `buffer` proveniente do renderer.
                // `validatePayload` suporta apenas tipos primitivos (string/number/boolean) e
                // não pode validar Buffer/Uint8Array/ArrayBuffer diretamente. Os campos
                // validados aqui são:
                //   - `buffer`: presença no objeto payload
                //   - tipo compatível (Buffer, Uint8Array ou ArrayBuffer) — Electron serializa
                //     Uint8Array como objeto numérico ao cruzar o processo IPC
                //   - conteúdo não-vazio (length > 0)
                //   - magic bytes bencode (primeiro byte === 0x64), rejeitando arquivos que não
                //     sejam torrents antes de passá-los ao WebTorrent
                if (typeof payload !== 'object' || payload === null || !('buffer' in payload)) {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                const raw = (payload as Record<string, unknown>).buffer;

                if (
                    !(raw instanceof Uint8Array || raw instanceof ArrayBuffer) ||
                    raw.byteLength === 0 ||
                    raw.byteLength > MAX_TORRENT_BYTES
                )
                    return fail(ErrorCodes.INVALID_FILE_PATH);

                // O IPC do Electron serializa Uint8Array como objeto com dados numéricos.
                // Aceitar Buffer, Uint8Array, ou ArrayBuffer.
                let buffer: Buffer;
                if (Buffer.isBuffer(raw)) {
                    buffer = raw;
                } else if (raw instanceof Uint8Array) {
                    buffer = Buffer.from(raw);
                } else if (raw instanceof ArrayBuffer) {
                    buffer = Buffer.from(raw);
                } else {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                if (buffer.length === 0) {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                // Verificar magic bytes bencode: todo arquivo .torrent começa com 'd' (0x64),
                // indicador de dicionário bencode. Rejeita buffers que não sejam torrents
                // antes de enviá-los ao engine, consistente com a validação de extensão em
                // torrent:add-file.
                if (!hasTorrentMagicBytes(buffer)) {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                logger.info('[IPC] torrent:add-file-buffer início:', buffer.length, 'bytes');
                const item = await withTimeout(
                    downloadManager.addTorrentBuffer(buffer),
                    'torrent:add-file-buffer',
                );
                logger.info('[IPC] torrent:add-file-buffer sucesso:', item.infoHash.slice(0, 8));
                return ok(item);
            } catch (err) {
                return failWithLog('torrent:add-file-buffer', err);
            }
        },
    );

    // ── torrent:add-magnet ────────────────────────────────────────────────────
    trackedHandle(
        'torrent:add-magnet',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ magnetUri: string }>(payload, {
                    magnetUri: { type: 'string', nonEmpty: true },
                });
                if (!result.valid) return fail(ErrorCodes.INVALID_MAGNET_URI);

                logger.info('[IPC] torrent:add-magnet início');
                const item = await withTimeout(
                    downloadManager.addMagnetLink(result.data.magnetUri),
                    'torrent:add-magnet',
                );
                logger.info('[IPC] torrent:add-magnet sucesso:', item.infoHash.slice(0, 8));
                return ok(item);
            } catch (err) {
                return failWithLog('torrent:add-magnet', err);
            }
        },
    );

    // ── torrent:pause ─────────────────────────────────────────────────────────
    trackedHandle('torrent:pause', async (_event, payload: unknown): Promise<IPCResponse<void>> => {
        try {
            if (torrentEngine?.isRestarting()) {
                return fail(ErrorCodes.ENGINE_RESTARTING);
            }

            const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
            if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

            await withTimeout(downloadManager.pause(result.data.infoHash), 'torrent:pause');
            return ok(undefined);
        } catch (err) {
            return failWithLog('torrent:pause', err);
        }
    });

    // ── torrent:resume ────────────────────────────────────────────────────────
    trackedHandle(
        'torrent:resume',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                await withTimeout(downloadManager.resume(result.data.infoHash), 'torrent:resume');
                return ok(undefined);
            } catch (err) {
                return failWithLog('torrent:resume', err);
            }
        },
    );

    // ── torrent:remove ────────────────────────────────────────────────────────
    trackedHandle(
        'torrent:remove',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ infoHash: string; deleteFiles: boolean }>(
                    payload,
                    {
                        infoHash: { type: 'string', nonEmpty: true },
                        deleteFiles: { type: 'boolean' },
                    },
                );
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                await withTimeout(
                    downloadManager.remove(result.data.infoHash, result.data.deleteFiles),
                    'torrent:remove',
                );
                return ok(undefined);
            } catch (err) {
                return failWithLog('torrent:remove', err);
            }
        },
    );

    // ── torrent:get-all ───────────────────────────────────────────────────────
    trackedHandle('torrent:get-all', async (_event): Promise<IPCResponse<DownloadItem[]>> => {
        try {
            const items = downloadManager.getAll();
            return ok(desktop?.diagnostics?.enrich(items) ?? items);
        } catch (err) {
            return failWithLog('torrent:get-all', err);
        }
    });

    // ── settings:get ──────────────────────────────────────────────────────────
    trackedHandle('settings:get', async (_event): Promise<IPCResponse<AppSettings>> => {
        try {
            const settings = settingsManager.get();
            return ok(settings);
        } catch (err) {
            return failWithLog('settings:get', err);
        }
    });

    // ── settings:set ──────────────────────────────────────────────────────────
    trackedHandle(
        'settings:set',
        async (_event, payload: unknown): Promise<IPCResponse<AppSettings>> => {
            try {
                if (torrentEngine?.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);
                if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
                    return fail(ErrorCodes.INVALID_SETTINGS_PAYLOAD);
                }

                const partial = payload as Partial<AppSettings>;

                // Validação declarativa de todos os campos
                const validationError = validateSettingsPayload(partial);
                if (validationError) {
                    return fail(validationError);
                }

                // Validar que a pasta de destino existe e tem permissão de escrita
                if (partial.destinationFolder !== undefined) {
                    // Resolver o caminho antes de validar (normaliza separadores, expande
                    // '..'). O caminho resolvido é também
                    // persistido para evitar caminhos relativos em configurações salvas.
                    const resolvedFolder = resolve(partial.destinationFolder);
                    if (!existsSync(resolvedFolder) || !hasWritePermission(resolvedFolder)) {
                        return fail(ErrorCodes.INVALID_PARAMS);
                    }
                    partial.destinationFolder = resolvedFolder;
                }

                // Capturar configurações anteriores ANTES de persistir (para detecção de mudança)
                const previousSettings = settingsManager.get();
                const networkChanged =
                    (partial.dhtEnabled !== undefined &&
                        partial.dhtEnabled !== previousSettings.dhtEnabled) ||
                    (partial.pexEnabled !== undefined &&
                        partial.pexEnabled !== previousSettings.pexEnabled) ||
                    (partial.utpEnabled !== undefined &&
                        partial.utpEnabled !== previousSettings.utpEnabled);

                if (
                    networkChanged &&
                    torrentEngine &&
                    downloadManager.getAll().some((item) => item.fileOperation)
                )
                    return fail(ErrorCodes.FILE_OPERATION_BUSY);

                settingsManager.set(partial);

                // Notificar o downloadManager sobre a mudança no limite de downloads simultâneos
                if (partial.maxConcurrentDownloads !== undefined) {
                    downloadManager.setMaxConcurrentDownloads(partial.maxConcurrentDownloads);
                }

                if (networkChanged && torrentEngine) {
                    const currentSettings = settingsManager.get();
                    await torrentEngine.restart({
                        downloadPath: currentSettings.destinationFolder,
                        downloadSpeedLimit: currentSettings.downloadSpeedLimit,
                        uploadSpeedLimit: currentSettings.uploadSpeedLimit,
                        dhtEnabled: currentSettings.dhtEnabled,
                        pexEnabled: currentSettings.pexEnabled,
                        utpEnabled: currentSettings.utpEnabled,
                    });
                }

                const updated = settingsManager.get();
                applyBandwidth(networkChanged);
                return ok(updated);
            } catch (err) {
                return failWithLog('settings:set', err);
            }
        },
    );

    // ── settings:select-folder ────────────────────────────────────────────────
    trackedHandle('settings:select-folder', async (_event): Promise<IPCResponse<string>> => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openDirectory'],
            });

            if (result.canceled || result.filePaths.length === 0) {
                return fail(ErrorCodes.NO_FOLDER_SELECTED);
            }

            // noUncheckedIndexedAccess: filePaths[0] garantido pela guarda length === 0 acima
            return ok(result.filePaths[0]!);
        } catch (err) {
            return failWithLog('settings:select-folder', err);
        }
    });

    // ── dialog:select-torrent-file ────────────────────────────────────────────
    // Abre o diálogo nativo do SO para selecionar um arquivo .torrent.
    // Necessário porque sandbox: true impede o acesso a File.path no renderer.
    trackedHandle('dialog:select-torrent-file', async (_event): Promise<IPCResponse<string>> => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openFile'],
                filters: [{ name: 'Torrent', extensions: ['torrent'] }],
            });

            if (result.canceled || result.filePaths.length === 0) {
                return fail(ErrorCodes.NO_FILE_SELECTED);
            }

            // noUncheckedIndexedAccess: filePaths[0] garantido pela guarda length === 0 acima
            return ok(result.filePaths[0]!);
        } catch (err) {
            return failWithLog('dialog:select-torrent-file', err);
        }
    });

    // ── torrent:get-files ─────────────────────────────────────────────────────
    trackedHandle(
        'torrent:get-files',
        async (_event, payload: unknown): Promise<IPCResponse<TorrentFileInfo[]>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;

                // Check if torrent exists in the download manager
                const allItems = downloadManager.getAll();
                const item = allItems.find((i) => i.infoHash === infoHash);

                if (!item) {
                    return fail(ErrorCodes.TORRENT_NOT_FOUND);
                }

                // If torrent is resolving metadata, return empty array
                if (item.status === 'resolving-metadata') {
                    return ok([]);
                }

                if (!torrentEngine && !downloadManager.getFiles) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                const files =
                    downloadManager.getFiles?.(infoHash) ?? torrentEngine!.getFiles(infoHash);
                return ok(files);
            } catch (err) {
                return failWithLog('torrent:get-files', err);
            }
        },
    );

    // ── torrent:set-file-selection ────────────────────────────────────────────
    trackedHandle(
        'torrent:set-file-selection',
        async (_event, payload: unknown): Promise<IPCResponse<TorrentFileInfo[]>> => {
            try {
                // Campos validados via validatePayload:
                //   - `infoHash`: string não-vazia, identifica o torrent alvo
                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;

                // `selectedIndices` é um array de inteiros e não pode ser validado pelo
                // validatePayload (suporta apenas tipos primitivos). Validação manual:
                //   - deve ser um array não-vazio
                //   - cada elemento deve ser um inteiro não-negativo
                //   - cada índice deve estar dentro do intervalo [0, totalFiles - 1]
                const rawIndices = (payload as Record<string, unknown>).selectedIndices;

                if (!Array.isArray(rawIndices) || rawIndices.length === 0) {
                    return fail(ErrorCodes.FILE_SELECTION_EMPTY);
                }

                for (const idx of rawIndices) {
                    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
                        return fail(ErrorCodes.FILE_INDEX_INVALID);
                    }
                }

                const selectedIndices = rawIndices as number[];

                // Check if torrent exists
                const allItems = downloadManager.getAll();
                const item = allItems.find((i) => i.infoHash === infoHash);

                if (!item) {
                    return fail(ErrorCodes.TORRENT_NOT_FOUND);
                }

                if (!torrentEngine) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                // Validação de índices fora de range: obtém o número real de arquivos do
                // torrent e rejeita qualquer índice >= totalFiles. Também rejeita quando
                // o torrent ainda não possui arquivos conhecidos (totalFiles === 0), pois
                // índices seriam inválidos independente do valor.
                const currentFiles = torrentEngine.getFiles(infoHash);
                const totalFiles = currentFiles.length;

                if (totalFiles === 0) {
                    return fail(ErrorCodes.FILE_INDEX_INVALID);
                }

                for (const idx of selectedIndices) {
                    if (idx >= totalFiles) {
                        return fail(ErrorCodes.FILE_INDEX_INVALID);
                    }
                }

                const updatedFiles = torrentEngine.setFileSelection(infoHash, selectedIndices);
                return ok(updatedFiles);
            } catch (err) {
                return failWithLog('torrent:set-file-selection', err);
            }
        },
    );

    // ── torrent:retry ─────────────────────────────────────────────────────────
    trackedHandle(
        'torrent:retry',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const item = await withTimeout(
                    downloadManager.retryDownload(result.data.infoHash),
                    'torrent:retry',
                );
                return ok(item);
            } catch (err) {
                return failWithLog('torrent:retry', err);
            }
        },
    );

    // ── tracker:get ───────────────────────────────────────────────────────────
    trackedHandle(
        'tracker:get',
        async (_event, payload: unknown): Promise<IPCResponse<TrackerInfo[]>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                if (!torrentEngine) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                const trackers = torrentEngine.getTrackers(result.data.infoHash);
                return ok(trackers);
            } catch (err) {
                return failWithLog('tracker:get', err);
            }
        },
    );

    // ── tracker:add ───────────────────────────────────────────────────────────
    trackedHandle(
        'tracker:add',
        async (_event, payload: unknown): Promise<IPCResponse<TrackerInfo[]>> => {
            try {
                const result = validatePayload<{ infoHash: string; url: string }>(
                    payload,
                    infoHashUrlSchema,
                );
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                if (!torrentEngine) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                const { infoHash, url } = result.data;

                if (!isValidTrackerUrl(url)) {
                    return fail(ErrorCodes.INVALID_TRACKER_URL);
                }

                torrentEngine.addTracker(infoHash, url);
                const trackers = torrentEngine.getTrackers(infoHash);
                return ok(trackers);
            } catch (err) {
                return failWithLog('tracker:add', err);
            }
        },
    );

    // ── tracker:remove ────────────────────────────────────────────────────────
    trackedHandle(
        'tracker:remove',
        async (_event, payload: unknown): Promise<IPCResponse<TrackerInfo[]>> => {
            try {
                const result = validatePayload<{ infoHash: string; url: string }>(
                    payload,
                    infoHashUrlSchema,
                );
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                if (!torrentEngine) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                const { infoHash, url } = result.data;
                torrentEngine.removeTracker(infoHash, url);
                const trackers = torrentEngine.getTrackers(infoHash);
                return ok(trackers);
            } catch (err) {
                return failWithLog('tracker:remove', err);
            }
        },
    );

    // ── tracker:apply-global ──────────────────────────────────────────────────
    trackedHandle(
        'tracker:apply-global',
        async (_event, payload: unknown): Promise<IPCResponse<TrackerInfo[]>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                if (!torrentEngine) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                const { infoHash } = result.data;
                const globalTrackers = settingsManager.getGlobalTrackers();

                for (const url of globalTrackers) {
                    try {
                        torrentEngine.addTracker(infoHash, url);
                    } catch {
                        // Erros individuais de tracker (ex: duplicatas) são esperados
                    }
                }

                const trackers = torrentEngine.getTrackers(infoHash);
                return ok(trackers);
            } catch (err) {
                return failWithLog('tracker:apply-global', err);
            }
        },
    );

    // ── tracker:get-global ────────────────────────────────────────────────────
    trackedHandle('tracker:get-global', async (_event): Promise<IPCResponse<string[]>> => {
        try {
            const trackers = settingsManager.getGlobalTrackers();
            return ok(trackers);
        } catch (err) {
            return failWithLog('tracker:get-global', err);
        }
    });

    // ── tracker:add-global ────────────────────────────────────────────────────
    trackedHandle(
        'tracker:add-global',
        async (_event, payload: unknown): Promise<IPCResponse<string[]>> => {
            try {
                const result = validatePayload<{ url: string }>(payload, urlSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { url } = result.data;

                if (!isValidTrackerUrl(url)) {
                    return fail(ErrorCodes.INVALID_TRACKER_URL);
                }

                settingsManager.addGlobalTracker(url);
                const trackers = settingsManager.getGlobalTrackers();
                return ok(trackers);
            } catch (err) {
                return failWithLog('tracker:add-global', err);
            }
        },
    );

    // ── tracker:remove-global ─────────────────────────────────────────────────
    trackedHandle(
        'tracker:remove-global',
        async (_event, payload: unknown): Promise<IPCResponse<string[]>> => {
            try {
                const result = validatePayload<{ url: string }>(payload, urlSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { url } = result.data;
                settingsManager.removeGlobalTracker(url);
                const trackers = settingsManager.getGlobalTrackers();
                return ok(trackers);
            } catch (err) {
                return failWithLog('tracker:remove-global', err);
            }
        },
    );

    // ── renderer:report-error ─────────────────────────────────────────────────
    // Canal para o renderer reportar erros (ErrorBoundary, exceções não capturadas)
    // ao main process, onde são persistidos via electron-log.
    trackedHandle(
        'renderer:report-error',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            const scopedLog = createScopedLogger(logger, { channel: 'renderer:report-error' });
            try {
                const result = validatePayload<{ message: string; source: string }>(payload, {
                    message: { type: 'string', nonEmpty: true },
                    source: { type: 'string', nonEmpty: true },
                });
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { message, source } = result.data;

                // Extrair stack trace opcional (não obrigatório)
                const stack =
                    typeof payload === 'object' && payload !== null
                        ? (payload as Record<string, unknown>).stack
                        : undefined;
                const stackStr = typeof stack === 'string' ? stack : undefined;

                // Extrair component stack opcional (React ErrorBoundary)
                const componentStack =
                    typeof payload === 'object' && payload !== null
                        ? (payload as Record<string, unknown>).componentStack
                        : undefined;
                const componentStackStr =
                    typeof componentStack === 'string' ? componentStack : undefined;

                scopedLog.error(`${source}: ${message}`, {
                    source,
                    ...(stackStr ? { stack: stackStr } : {}),
                    ...(componentStackStr ? { componentStack: componentStackStr } : {}),
                });

                // Registrar nas métricas
                metrics.recordRendererError();

                return ok(undefined);
            } catch (err) {
                return failWithLog('renderer:report-error', err, scopedLog);
            }
        },
    );

    // ── torrent:open-folder ───────────────────────────────────────────────────
    // Abre a pasta de destino do download no gerenciador de arquivos do SO.
    trackedHandle(
        'torrent:open-folder',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;

                // Buscar o DownloadItem correspondente
                const allItems = downloadManager.getAll();
                const item = allItems.find((i) => i.infoHash === infoHash);

                if (!item) {
                    return fail(ErrorCodes.TORRENT_NOT_FOUND);
                }

                // Verificar se a pasta de destino existe
                if (
                    !existsSync(item.destinationFolder) ||
                    !statSync(item.destinationFolder).isDirectory()
                ) {
                    return fail(ErrorCodes.DESTINATION_FOLDER_NOT_FOUND);
                }

                // Abrir a pasta no gerenciador de arquivos do SO
                const shellError = await shell.openPath(item.destinationFolder);

                if (shellError) {
                    return fail(ErrorCodes.DESTINATION_OPEN_FAILED);
                }

                return ok(undefined);
            } catch (err) {
                return failWithLog('torrent:open-folder', err);
            }
        },
    );

    // ── torrent:open-file ────────────────────────────────────────────────────
    // Abre o arquivo baixado diretamente no aplicativo padrão do SO.
    trackedHandle(
        'torrent:open-file',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;

                // Buscar o DownloadItem correspondente
                const allItems = downloadManager.getAll();
                const item = allItems.find((i) => i.infoHash === infoHash);

                if (!item) {
                    return fail(ErrorCodes.TORRENT_NOT_FOUND);
                }

                // Verificar se o download está concluído
                if (item.status !== 'completed') {
                    return fail(ErrorCodes.DESTINATION_NOT_COMPLETED);
                }

                // Obter a lista de arquivos do torrent
                if (!torrentEngine && !downloadManager.getFiles) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                const files =
                    downloadManager.getFiles?.(infoHash) ?? torrentEngine!.getFiles(infoHash);

                // Encontrar o primeiro arquivo selecionado
                const selectedFile = files.find((file) => file.selected === true);

                if (!selectedFile) {
                    return fail(ErrorCodes.DESTINATION_FILE_NOT_FOUND);
                }

                // Construir o caminho completo do arquivo
                const fullPath = await resolveTorrentFile(
                    item.destinationFolder,
                    selectedFile.path,
                );

                // Verificar se o arquivo existe
                if (!existsSync(fullPath)) {
                    return fail(ErrorCodes.DESTINATION_FILE_NOT_FOUND);
                }

                // Executáveis, scripts e formatos desconhecidos exigem ação no SO.
                if (!canOpenDownloadedFile(fullPath)) {
                    shell.showItemInFolder(fullPath);
                    return ok(undefined);
                }

                // Abrir o arquivo no aplicativo padrão do SO
                const shellError = await shell.openPath(fullPath);

                if (shellError) {
                    return fail(ErrorCodes.DESTINATION_OPEN_FAILED);
                }

                return ok(undefined);
            } catch (err) {
                return failWithLog('torrent:open-file', err);
            }
        },
    );

    // ── queue:reorder ─────────────────────────────────────────────────────────
    // Reordena um item na fila de downloads para uma nova posição.
    trackedHandle(
        'queue:reorder',
        async (_event, payload: unknown): Promise<IPCResponse<string[]>> => {
            try {
                const result = validatePayload<{ infoHash: string; newIndex: number }>(payload, {
                    infoHash: { type: 'string', nonEmpty: true },
                    newIndex: { type: 'number' },
                });
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash, newIndex } = result.data;

                // Validar que newIndex é inteiro não-negativo
                if (!Number.isInteger(newIndex) || newIndex < 0) {
                    return fail(ErrorCodes.QUEUE_INVALID_INDEX);
                }

                const order = downloadManager.reorderQueue(infoHash, newIndex);
                return ok(order);
            } catch (err) {
                return failWithLog('queue:reorder', err);
            }
        },
    );

    // ── queue:get-order ───────────────────────────────────────────────────────
    // Retorna a ordem atual da fila de downloads.
    trackedHandle('queue:get-order', async (_event): Promise<IPCResponse<string[]>> => {
        try {
            const order = downloadManager.getQueueOrder();
            return ok(order);
        } catch (err) {
            return failWithLog('queue:get-order', err);
        }
    });

    // ── app:get-metrics ───────────────────────────────────────────────────────
    // Retorna snapshot das métricas de operação para debugging no renderer.
    trackedHandle('app:get-metrics', async (_event): Promise<IPCResponse<MetricsSnapshot>> => {
        try {
            const snapshot = metrics.getSnapshot();
            return ok(snapshot);
        } catch (err) {
            return failWithLog('app:get-metrics', err);
        }
    });

    // ── torrent:get-metadata ──────────────────────────────────────────────────
    // Retorna metadados detalhados do torrent (creator, comment, creationDate).
    trackedHandle(
        'torrent:get-metadata',
        async (_event, payload: unknown): Promise<IPCResponse<TorrentMetadata>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashHexSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;
                const item = downloadManager.getAll().find((i) => i.infoHash === infoHash);
                if (!item) return fail(ErrorCodes.TORRENT_NOT_FOUND);

                if (!torrentEngine) return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                if (torrentEngine.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);

                const metadata = torrentEngine.getMetadata(infoHash);
                return ok(metadata);
            } catch (err) {
                return failWithLog('torrent:get-metadata', err);
            }
        },
    );

    // ── torrent:get-peers ─────────────────────────────────────────────────────
    // Retorna a lista de peers conectados ao torrent.
    trackedHandle(
        'torrent:get-peers',
        async (_event, payload: unknown): Promise<IPCResponse<PeerInfo[]>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashHexSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;
                const item = downloadManager.getAll().find((i) => i.infoHash === infoHash);
                if (!item) return fail(ErrorCodes.TORRENT_NOT_FOUND);

                if (!torrentEngine) return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                if (torrentEngine.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);

                // Torrent em resolving-metadata retorna array vazio
                if (item.status === 'resolving-metadata') return ok([]);

                const peers = torrentEngine.getPeers(infoHash);
                return ok(peers);
            } catch (err) {
                return failWithLog('torrent:get-peers', err);
            }
        },
    );

    // ── torrent:get-pieces ────────────────────────────────────────────────────
    // Retorna o status de cada peça do torrent (true = completa, false = pendente).
    trackedHandle(
        'torrent:get-pieces',
        async (_event, payload: unknown): Promise<IPCResponse<PieceStatus>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashHexSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;
                const item = downloadManager.getAll().find((i) => i.infoHash === infoHash);
                if (!item) return fail(ErrorCodes.TORRENT_NOT_FOUND);

                if (!torrentEngine) return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                if (torrentEngine.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);

                // Torrent em resolving-metadata retorna array vazio
                if (item.status === 'resolving-metadata') return ok([]);

                const pieces = torrentEngine.getPieces(infoHash);
                return ok(pieces);
            } catch (err) {
                return failWithLog('torrent:get-pieces', err);
            }
        },
    );
}

import { ipcMain, BrowserWindow } from 'electron';
import { registerBandwidthIpcHandlers } from './ipc/bandwidthHandlers';
import { registerBatchIpcHandlers } from './ipc/batchHandlers';
import { registerApplicationIpcHandlers } from './ipc/applicationHandlers';
import { registerQueueIpcHandlers } from './ipc/queueHandlers';
import { registerSettingsIpcHandlers } from './ipc/settingsHandlers';
import { registerTrackerIpcHandlers } from './ipc/trackerHandlers';
import { registerTorrentIpcHandlers } from './ipc/torrentHandlers';
import type { DesktopIpcServices, IpcHandlerContext } from './ipc/context';
import type { DownloadManager } from './downloadManager';
import type { SettingsManager } from './settingsManager';
import type { TorrentIpcEngine, TorrentErrorEventSource } from './enginePorts';
import type { DownloadDiagnostics } from './downloadDiagnostics';
import { getEffectiveBandwidth } from '../shared/bandwidth';
import type { IPCResponse } from '../shared/types';
import { ErrorCodes } from '../shared/errorCodes';
import { createScopedLogger, logger } from './logger';
import { serializeLogError } from './logRedaction';
import type { ScopedLogger } from './logger';
import { markIpcOutcome, withIpcMetrics } from './ipcMetrics';
import {
    validatePayload,
    infoHashSchema,
    infoHashHexSchema,
    infoHashUrlSchema,
    urlSchema,
} from './payloadValidator';
import { parseTraceContext } from '../shared/traceContext';
import { getOperationContext, runWithOperationContext } from './operationContext';
import { traceOperation } from './tracing';
import type { TorrentPreparation } from './torrentPreparation';
import { isTrustedIpcSender } from './rendererSecurity';

export type { IPCResponse } from '../shared/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok<T>(data: T): IPCResponse<T> {
    return { success: true, data };
}

function fail(error: string): IPCResponse<never> {
    return { success: false, error };
}

function failWithLog(channel: string, err: unknown, scopedLog?: ScopedLogger): IPCResponse<never> {
    const error = serializeLogError(err);
    markIpcOutcome('exception', error);
    // Retornar código genérico para não vazar caminhos de SO, nomes de classe
    // ou stack traces internos para o renderer. O erro completo fica apenas nos logs.
    const known = Object.values(ErrorCodes).some((code) => code === error.message);
    const errorCode = known ? error.message : ErrorCodes.OPERATION_FAILED;
    (scopedLog ?? createScopedLogger(logger, { channel })).error('Falha na operação IPC', {
        event: 'ipc.operation.failed',
        channel,
        errorCode,
        error,
    });
    return { success: false, error: errorCode };
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
    torrentEngine: TorrentErrorEventSource,
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
        const stack = err.stack?.split('\n').slice(0, 3).join(' | ') ?? '';
        logger.error('[IPC] Engine error:', infoHash.slice(0, 8), err.message, stack);
        if (
            !mainWindow.isDestroyed() &&
            !downloadManager.getAll().find((item) => item.infoHash === infoHash)?.fileOperation &&
            !downloadManager.getAll().find((item) => item.infoHash === infoHash)?.pauseReason
        ) {
            const traceContext = parseTraceContext(getOperationContext());
            mainWindow.webContents.send('torrent:error', {
                infoHash,
                message: err.message,
                ...(traceContext ? { traceContext } : {}),
            });
        }
    };
    torrentEngine.on('error', errorListener);

    mainWindow.on('closed', () => {
        torrentEngine.removeListener('error', errorListener);
    });
}

/**
 * Registers all IPC handlers for the Meshy Torrent application.
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
    torrentEngine?: TorrentIpcEngine,
    preparation?: TorrentPreparation,
    desktop?: DesktopIpcServices,
): void {
    // ── Wrapper para tracking automático de métricas ──────────────────────────
    // Intercepta ipcMain.handle para medir latência e contar erros de cada canal.
    // Inclui rate limiting para proteger contra abuso do renderer.
    const trackedHandle = <T>(
        channel: string,
        handler: (event: Electron.IpcMainInvokeEvent, payload: unknown) => Promise<IPCResponse<T>>,
    ): void => {
        ipcMain.handle(channel, (event, payload, metadata: unknown) =>
            withIpcMetrics(channel, () => {
                if (!isTrustedIpcSender(event)) {
                    markIpcOutcome('unauthorized');
                    return fail(ErrorCodes.INVALID_PARAMS);
                }
                const parent = parseTraceContext(metadata);
                return runWithOperationContext(undefined, () =>
                    traceOperation(
                        channel,
                        async () => {
                            let result: IPCResponse<T>;
                            if (!rateLimiter.tryConsume(channel)) {
                                markIpcOutcome('rate_limited');
                                logger.warn(`[IPC] Rate limit excedido para canal: ${channel}`);
                                result = fail(RATE_LIMITED);
                            } else {
                                try {
                                    result = await handler(event, payload);
                                } catch (error) {
                                    result = failWithLog(channel, error);
                                }
                            }
                            // Chamadores legados sem metadados mantêm a forma anterior da resposta.
                            return metadata === undefined
                                ? result
                                : {
                                      ...result,
                                      traceContext: parseTraceContext(getOperationContext())!,
                                  };
                        },
                        parent,
                    ),
                );
            }),
        );
    };

    const applyBandwidth = (force = false) => {
        if (desktop?.bandwidth) return desktop.bandwidth.refresh(force);
        const status = getEffectiveBandwidth(settingsManager.get());
        torrentEngine?.setDownloadSpeedLimit?.(status.downloadLimit);
        torrentEngine?.setUploadSpeedLimit?.(status.uploadLimit);
        return status;
    };

    const ipcContext: IpcHandlerContext = {
        trackedHandle,
        downloadManager,
        settingsManager,
        ...(torrentEngine ? { torrentEngine } : {}),
        ...(preparation ? { preparation } : {}),
        ...(desktop ? { desktop } : {}),
        ok,
        fail,
        failWithLog,
        validatePayload,
        infoHashSchema,
        infoHashHexSchema,
        infoHashUrlSchema,
        urlSchema,
        errorCodes: ErrorCodes,
        applyBandwidth,
    };
    registerApplicationIpcHandlers(ipcContext);
    registerBandwidthIpcHandlers(ipcContext);
    registerBatchIpcHandlers(ipcContext);
    registerSettingsIpcHandlers(ipcContext);
    registerTrackerIpcHandlers(ipcContext);
    registerQueueIpcHandlers(ipcContext);

    registerTorrentIpcHandlers(ipcContext);
}

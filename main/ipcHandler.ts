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
import { logger } from './logger';
import type { ScopedLogger } from './logger';
import { metrics } from './metrics';
import {
    validatePayload,
    infoHashSchema,
    infoHashHexSchema,
    infoHashUrlSchema,
    urlSchema,
} from './payloadValidator';
import { randomBytes } from 'crypto';
import type { TorrentPreparation } from './torrentPreparation';
import { isTrustedIpcSender } from './rendererSecurity';

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

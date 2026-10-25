import { createScopedLogger, logger } from '../logger';
import { metrics } from '../metrics';
import type { MetricsSnapshot } from '../metrics';
import type { IPCResponse } from '../../shared/types';
import type { IpcHandlerContext } from './context';
export function registerApplicationIpcHandlers({
    trackedHandle,
    desktop,
    ok,
    fail,
    failWithLog,
    validatePayload,
    errorCodes: ErrorCodes,
}: IpcHandlerContext): void {
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
}

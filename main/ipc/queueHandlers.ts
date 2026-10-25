import type { IPCResponse } from '../../shared/types';
import type { IpcHandlerContext } from './context';
export function registerQueueIpcHandlers({
    trackedHandle,
    downloadManager,
    ok,
    fail,
    failWithLog,
    validatePayload,
    errorCodes: ErrorCodes,
}: IpcHandlerContext): void {
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
}

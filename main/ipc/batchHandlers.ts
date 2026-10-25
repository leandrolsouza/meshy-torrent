import type { BatchAction, BatchActionResult, IPCResponse } from '../../shared/types';
import { performBatchAction } from '../batchActions';
import type { IpcHandlerContext } from './context';
export function registerBatchIpcHandlers({
    trackedHandle,
    downloadManager,
    torrentEngine,
    ok,
    fail,
    failWithLog,
    errorCodes: ErrorCodes,
}: IpcHandlerContext): void {
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
}

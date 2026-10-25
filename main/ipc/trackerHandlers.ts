import type { IPCResponse, TrackerInfo } from '../../shared/types';
import { isValidTrackerUrl } from '../../shared/validators';
import type { IpcHandlerContext } from './context';
export function registerTrackerIpcHandlers({
    trackedHandle,
    settingsManager,
    torrentEngine,
    ok,
    fail,
    failWithLog,
    validatePayload,
    infoHashSchema,
    infoHashUrlSchema,
    urlSchema,
    errorCodes: ErrorCodes,
}: IpcHandlerContext): void {
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
}

import type { BandwidthStatus, IPCResponse } from '../../shared/types';
import { createDefaultBandwidthSettings, getEffectiveBandwidth } from '../../shared/bandwidth';
import type { IpcHandlerContext } from './context';
export function registerBandwidthIpcHandlers({
    trackedHandle,
    settingsManager,
    torrentEngine,
    desktop,
    ok,
    fail,
    failWithLog,
    errorCodes: ErrorCodes,
    applyBandwidth,
}: IpcHandlerContext): void {
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
}

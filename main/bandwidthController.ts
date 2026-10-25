import { getEffectiveBandwidth } from '../shared/bandwidth';
import type { SettingsManager } from './settingsManager';
import type { BandwidthControlEngine } from './enginePorts';

/** Funciona no main, inclusive com a janela escondida na bandeja. */
export function createBandwidthController(options: {
    settings: SettingsManager;
    engine: BandwidthControlEngine;
    now?: () => Date;
    disableTimer?: boolean;
}) {
    let applied = '';
    const getStatus = () =>
        getEffectiveBandwidth(options.settings.get(), options.now?.() ?? new Date());
    const refresh = (force = false) => {
        const status = getStatus();
        if (options.engine.isRestarting()) return status;
        const key = `${status.downloadLimit}:${status.uploadLimit}`;
        if (force || key !== applied) {
            options.engine.setDownloadSpeedLimit(status.downloadLimit);
            options.engine.setUploadSpeedLimit(status.uploadLimit);
            applied = key;
        }
        return status;
    };
    const restarted = () => {
        refresh(true);
    };
    options.engine.on('restarted', restarted);
    refresh();
    const timer = options.disableTimer ? undefined : setInterval(() => refresh(), 10_000);
    timer?.unref();
    return {
        getStatus,
        refresh,
        dispose() {
            clearInterval(timer);
            options.engine.removeListener('restarted', restarted);
        },
    };
}
export type BandwidthController = ReturnType<typeof createBandwidthController>;

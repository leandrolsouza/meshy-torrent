import { EventEmitter } from 'events';
import {
    createDefaultBandwidthSettings,
    getEffectiveBandwidth,
    isValidBandwidthSettings,
} from '../../shared/bandwidth';
import { createBandwidthController } from '../../main/bandwidthController';
import { createSettingsManager } from '../../main/settingsManager';
import type { SettingsManager, SettingsStore } from '../../main/settingsManager';
import type { TorrentEngine } from '../../main/torrentEngine';
import type { AppSettings } from '../../shared/types';

const settings = (partial: Partial<AppSettings> = {}): AppSettings => ({
    destinationFolder: '/downloads',
    downloadSpeedLimit: 0,
    uploadSpeedLimit: 0,
    maxConcurrentDownloads: 3,
    seedingEnabled: false,
    maxConcurrentSeeders: 2,
    notificationsEnabled: true,
    theme: 'vs-code-dark',
    locale: 'pt-BR',
    globalTrackers: [],
    autoApplyGlobalTrackers: false,
    dhtEnabled: true,
    pexEnabled: true,
    utpEnabled: true,
    closeToTray: false,
    ...partial,
});
const scheduled = {
    ...createDefaultBandwidthSettings(),
    scheduleEnabled: true,
    days: [1],
    start: '22:00',
    end: '06:00',
};

test.each([
    [new Date(2026, 9, 5, 21, 59), 'normal'],
    [new Date(2026, 9, 5, 22, 0), 'scheduled'],
    [new Date(2026, 9, 6, 5, 59), 'scheduled'],
    [new Date(2026, 9, 6, 6, 0), 'normal'],
    [new Date(2026, 9, 6, 22, 0), 'normal'],
])('intervalo noturno usa o dia de início e exclui o instante final: %s', (date, mode) => {
    expect(getEffectiveBandwidth(settings({ bandwidth: scheduled }), date).mode).toBe(mode);
});
test('domingo à noite continua na segunda de madrugada', () => {
    expect(
        getEffectiveBandwidth(
            settings({ bandwidth: { ...scheduled, days: [0] } }),
            new Date(2026, 9, 5, 2),
        ).mode,
    ).toBe('scheduled');
});
test('modo manual tem prioridade e nunca aumenta limites menores', () => {
    const current = settings({
        downloadSpeedLimit: 64,
        uploadSpeedLimit: 0,
        bandwidth: { ...scheduled, manualEnabled: true },
    });
    expect(getEffectiveBandwidth(current, new Date(2026, 9, 5, 23))).toMatchObject({
        mode: 'manual',
        downloadLimit: 64,
        uploadLimit: 32,
    });
    expect(current.downloadSpeedLimit).toBe(64);
    current.bandwidth!.manualEnabled = false;
    expect(getEffectiveBandwidth(current, new Date(2026, 9, 6, 12))).toMatchObject({
        mode: 'normal',
        downloadLimit: 64,
        uploadLimit: 0,
    });
});
test('intervalo diurno só vale nos dias escolhidos', () => {
    const current = settings({ bandwidth: { ...scheduled, start: '09:00', end: '18:00' } });
    expect(getEffectiveBandwidth(current, new Date(2026, 9, 5, 9)).mode).toBe('scheduled');
    expect(getEffectiveBandwidth(current, new Date(2026, 9, 5, 18)).mode).toBe('normal');
    expect(getEffectiveBandwidth(current, new Date(2026, 9, 6, 12)).mode).toBe('normal');
});
test.each([
    null,
    {},
    { ...scheduled, days: [] },
    { ...scheduled, days: [1, 1] },
    { ...scheduled, days: [7] },
    { ...scheduled, start: '24:00' },
    { ...scheduled, end: '22:00' },
    { ...scheduled, downloadLimit: 0 },
    { ...scheduled, uploadLimit: 1.5 },
    { ...scheduled, manualEnabled: 'true' },
])('configuração inválida não é aceita: %j', (value) => {
    expect(isValidBandwidthSettings(value)).toBe(false);
});
test('configurações antigas/corrompidas usam modo desativado; cópias não alteram o store', () => {
    const data = new Map<string, unknown>([['bandwidth', { scheduleEnabled: true }]]);
    const store: SettingsStore = {
        get: (key) => data.get(key) as never,
        set: (key, value) => {
            data.set(key, value);
        },
        setMany: (values) => {
            for (const [key, value] of Object.entries(values)) data.set(key, value);
        },
    };
    const manager = createSettingsManager({ store, getDownloadsPath: () => '/downloads' });
    expect(manager.get().bandwidth).toEqual(createDefaultBandwidthSettings());
    manager.get().bandwidth!.days.push(0);
    expect(manager.get().bandwidth!.days).toEqual([1, 2, 3, 4, 5]);
    manager.set({ bandwidth: scheduled });
    expect(manager.get().bandwidth).toEqual(scheduled);
});
test('horários funcionam sem renderer; restart reaplica limites e dispose limpa timer/listener', () => {
    jest.useFakeTimers();
    let now = new Date(2026, 9, 5, 21, 59);
    let restarting = false;
    const engine = Object.assign(new EventEmitter(), {
        isRestarting: () => restarting,
        setDownloadSpeedLimit: jest.fn(),
        setUploadSpeedLimit: jest.fn(),
    });
    const manager = { get: () => settings({ bandwidth: scheduled }) } as SettingsManager;
    const controller = createBandwidthController({
        settings: manager,
        engine: engine as unknown as TorrentEngine,
        now: () => now,
    });
    try {
        expect(engine.setDownloadSpeedLimit).toHaveBeenLastCalledWith(0);
        now = new Date(2026, 9, 5, 22);
        restarting = true;
        jest.advanceTimersByTime(10_000);
        expect(engine.setDownloadSpeedLimit).toHaveBeenCalledTimes(1);
        restarting = false;
        engine.emit('restarted');
        expect(engine.setDownloadSpeedLimit).toHaveBeenLastCalledWith(128);
        now = new Date(2026, 9, 6, 6);
        jest.advanceTimersByTime(10_000);
        expect(engine.setDownloadSpeedLimit).toHaveBeenLastCalledWith(0);
        controller.dispose();
        expect(engine.listenerCount('restarted')).toBe(0);
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        controller.dispose();
        jest.useRealTimers();
    }
});

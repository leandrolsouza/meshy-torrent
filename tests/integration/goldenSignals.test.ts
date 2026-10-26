import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import type WebTorrent from 'webtorrent';
import { createTorrentEngine } from '../../main/torrentEngine';
import type { TorrentInfo } from '../../main/torrentEngine';
import { createDownloadManager } from '../../main/downloadManager';
import { createMetricsCollector } from '../../main/metrics';
import { createOperationalMetrics } from '../../main/operationalMetrics';
import { attachWindowEvents } from '../../main/ipcHandler';
import type { SettingsManager } from '../../main/settingsManager';

jest.mock('webtorrent', () => jest.fn());
jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() } }));
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(() => true),
    accessSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
    ...jest.requireActual('fs/promises'),
    stat: jest.fn().mockResolvedValue({ isDirectory: () => true } as any),
    access: jest.fn().mockResolvedValue(undefined),
}));

const options = {
    downloadPath: '/fixture',
    downloadSpeedLimit: 0,
    uploadSpeedLimit: 0,
    dhtEnabled: false,
    pexEnabled: false,
    utpEnabled: false,
};
const settings = {
    get: () => ({
        destinationFolder: '/fixture',
        maxConcurrentDownloads: 1,
        seedingEnabled: false,
        globalTrackers: [],
        autoApplyGlobalTrackers: false,
    }),
} as unknown as SettingsManager;
const loopSampler = () => ({
    read: () => ({
        utilization: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
        maxMs: null,
        meanMs: null,
    }),
    dispose: jest.fn(),
});

function nativeEngine(collector: ReturnType<typeof createMetricsCollector>) {
    const torrent = Object.assign(new EventEmitter(), {
        infoHash: 'a'.repeat(40),
        ready: false,
        downloaded: 10000,
        files: [],
    });
    const client = Object.assign(new EventEmitter(), {
        torrents: [] as (typeof torrent)[],
        add: jest.fn(() => {
            client.torrents.push(torrent);
            return torrent;
        }),
    });
    const engine = createTorrentEngine(options, client as unknown as WebTorrent, collector);
    return { torrent, engine };
}

test('tráfego mede bytes dos eventos da engine, não progresso em disco ou quantidade de snapshots', async () => {
    const collector = createMetricsCollector();
    const { torrent, engine } = nativeEngine(collector);
    await engine.addMagnetLink(`magnet:?xt=urn:btih:${torrent.infoHash}`);
    engine.getAll();
    engine.getAll();
    expect(collector.getSnapshot().traffic.downloadedBytes).toBe(0);
    torrent.emit('download', 256);
    torrent.emit('upload', 128);
    torrent.emit('download', undefined);
    torrent.emit('download', -1);
    engine.getAll();
    expect(collector.getSnapshot().traffic).toEqual({ downloadedBytes: 256, uploadedBytes: 128 });
});

test('um erro da engine é contado uma vez com duas janelas e continua após ambas fecharem', async () => {
    const collector = createMetricsCollector();
    const { torrent, engine } = nativeEngine(collector);
    const manager = Object.assign(new EventEmitter(), {
        getAll: () => [],
        getOperationalState: () => ({
            activeDownloads: 0,
            pendingAdds: 0,
            occupiedSlots: 0,
            maxConcurrentDownloads: 1,
            queuedDownloads: 0,
            activeSeeders: 0,
            slotUtilization: 0,
        }),
    });
    const monitor = createOperationalMetrics({
        manager,
        engine,
        settings,
        collector,
        loopSampler: loopSampler(),
        disableTimers: true,
    });
    const windows = [0, 1].map(() =>
        Object.assign(new EventEmitter(), {
            isDestroyed: () => false,
            webContents: { send: jest.fn() },
        }),
    );
    try {
        for (const window of windows)
            attachWindowEvents(manager as never, engine, window as unknown as BrowserWindow);
        await engine.addMagnetLink(`magnet:?xt=urn:btih:${torrent.infoHash}`);
        torrent.emit('error', Object.assign(new Error('Disco cheio'), { code: 'ENOSPC' }));
        expect(collector.getSnapshot().engineErrorCount).toBe(1);
        expect(collector.getSnapshot().errorCauses.engine.disk_space).toBe(1);
        expect(windows[0]!.webContents.send).toHaveBeenCalledTimes(1);
        expect(windows[1]!.webContents.send).toHaveBeenCalledTimes(1);
        for (const window of windows) window.emit('closed');
        torrent.emit('error', Object.assign(new Error('Rede'), { code: 'ECONNRESET' }));
        expect(collector.getSnapshot().engineErrorCount).toBe(2);
        expect(collector.getSnapshot().errorCauses.engine.network).toBe(1);
    } finally {
        for (const window of windows) window.emit('closed');
        monitor.dispose();
    }
});

test('gauge real inclui reservas pendentes e fila; conclusão selecionada e done não duplicam produto', async () => {
    let clock = 0;
    const collector = createMetricsCollector({ clock: () => clock });
    let finish!: (info: TorrentInfo) => void;
    const info = (id: string): TorrentInfo => ({
        infoHash: id.repeat(40),
        name: 'fixture',
        totalSize: 100,
        progress: 0,
        downloaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 1,
        numSeeders: 1,
        timeRemaining: Infinity,
        status: 'downloading',
    });
    const engine = Object.assign(new EventEmitter(), {
        isRestarting: () => false,
        getAll: () => [],
        getFiles: () => [],
        getMetadata: jest.fn(() => {
            throw new Error('Sem metadados');
        }),
        pause: jest.fn(async () => { }),
        addMagnetLink: jest.fn(async (magnet: string) =>
            info(magnet.includes('a'.repeat(40)) ? 'a' : 'b'),
        ),
    });
    engine.addMagnetLink.mockImplementationOnce(
        () =>
            new Promise<TorrentInfo>((resolve) => {
                finish = resolve;
            }),
    );
    const manager = createDownloadManager(engine as never, settings, undefined, undefined, {
        disableCleanupTimer: true,
    });
    const monitor = createOperationalMetrics({
        manager,
        engine,
        settings,
        collector,
        clock: () => clock,
        loopSampler: loopSampler(),
        disableTimers: true,
    });
    try {
        const first = manager.addMagnetLink(`magnet:?xt=urn:btih:${'a'.repeat(40)}`);
        expect(manager.getOperationalState()).toMatchObject({
            pendingAdds: 1,
            occupiedSlots: 1,
            activeDownloads: 0,
        });
        await manager.addMagnetLink(`magnet:?xt=urn:btih:${'b'.repeat(40)}`);
        monitor.sample();
        expect(collector.getSnapshot().operational!.queue).toMatchObject({
            pendingAdds: 1,
            occupiedSlots: 1,
            queuedDownloads: 1,
            slotUtilization: 1,
        });
        finish(info('a'));
        await first;
        expect(manager.getOperationalState()).toMatchObject({
            pendingAdds: 0,
            activeDownloads: 1,
            queuedDownloads: 1,
        });
        clock = 5000;
        engine.emit('progress', { ...info('a'), progress: 1, downloaded: 100 });
        engine.emit('done', 'a'.repeat(40));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(collector.getSnapshot().downloads).toMatchObject({ started: 2, completed: 1 });
        expect(collector.getSnapshot().latency.queueWaitMs).toMatchObject({
            count: 1,
            sumMs: 5000,
        });
        expect(manager.getOperationalState()).toMatchObject({
            activeDownloads: 1,
            pendingAdds: 0,
            queuedDownloads: 0,
        });
    } finally {
        monitor.dispose();
        await manager.pause('b'.repeat(40));
    }
});

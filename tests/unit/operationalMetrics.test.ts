import { EventEmitter } from 'node:events';
import { createOperationalMetrics } from '../../main/operationalMetrics';
import { createMetricsCollector } from '../../main/metrics';
import type { DownloadItem, AppSettings } from '../../shared/types';
import type { EventLoopMetrics } from '../../main/operationalMetricTypes';

const mib = 1024 * 1024;
function item(hash = 'a', overrides: Partial<DownloadItem> = {}): DownloadItem {
    return {
        infoHash: hash.repeat(40),
        name: 'SYNTHETIC_PRIVATE_NAME',
        totalSize: 100,
        downloadedSize: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: Infinity,
        status: 'queued',
        destinationFolder: '/SYNTHETIC_PRIVATE_FOLDER',
        addedAt: 1,
        ...overrides,
    };
}

function setup(
    initial: DownloadItem[] = [],
    deferLifecycle = false,
    disableTimers = true,
    readProcessMetrics?: () => Electron.ProcessMetric[],
    readGpuStatus?: () => {
        hardwareAccelerationEnabled: boolean;
        features: Record<string, string>;
    } | null,
) {
    let current = [...initial];
    let clock = 0;
    const collector = createMetricsCollector({ clock: () => clock, now: () => 1000 + clock });
    const manager = Object.assign(new EventEmitter(), {
        getAll: jest.fn(() => current),
        getOperationalState: jest.fn(() => ({
            activeDownloads: 1,
            pendingAdds: 1,
            occupiedSlots: 2,
            maxConcurrentDownloads: 3,
            queuedDownloads: 2,
            activeSeeders: 1,
            slotUtilization: 2 / 3,
        })),
    });
    const engine = new EventEmitter();
    engine.on('error', () => {});
    const loopSampler = {
        read: jest.fn((): EventLoopMetrics => ({
            utilization: 0.5,
            p50Ms: 20,
            p95Ms: 40,
            p99Ms: 60,
            maxMs: 100,
            meanMs: 25,
        })),
        dispose: jest.fn(),
    };
    const readDisk = jest.fn(async (_folder: string) => ({
        freeBytes: 512 * mib,
        totalBytes: 1024 * mib,
    }));
    const settings = {
        get: jest.fn(() => ({ destinationFolder: '/SYNTHETIC_PRIVATE_FOLDER' }) as AppSettings),
    };
    const monitor = createOperationalMetrics({
        manager,
        engine,
        settings,
        collector,
        clock: () => clock,
        now: () => 1000 + clock,
        loopSampler,
        readDisk,
        readProcessMetrics,
        readGpuStatus,
        deferLifecycle,
        disableTimers,
    });
    const update = (next: DownloadItem) => {
        current = [...current.filter((previous) => previous.infoHash !== next.infoHash), next];
        manager.emit('update', next);
    };
    const remove = (hash: string) => {
        current = current.filter((entry) => entry.infoHash !== hash);
        manager.emit('remove', hash);
    };
    return {
        collector,
        manager,
        engine,
        monitor,
        loopSampler,
        readDisk,
        settings,
        update,
        remove,
        time: (value: number) => {
            clock = value;
        },
    };
}

test('snapshot inclui CPU e memória dos processos Electron sem guardar amostras antigas', () => {
    const processMetric: Electron.ProcessMetric = {
        pid: 42,
        creationTime: 1234,
        type: 'GPU',
        serviceName: 'GPU Process',
        cpu: {
            percentCPUUsage: 12.5,
            idleWakeupsPerSecond: 3,
            cumulativeCPUUsage: 9.5,
        },
        memory: {
            workingSetSize: 2048,
            peakWorkingSetSize: 4096,
            privateBytes: 1024,
        },
    };
    const rendererMetric: Electron.ProcessMetric = {
        ...processMetric,
        pid: 43,
        type: 'Tab',
    };
    const readProcessMetrics = jest
        .fn<Electron.ProcessMetric[], []>()
        .mockReturnValueOnce([processMetric])
        .mockReturnValueOnce([rendererMetric]);
    const fixture = setup([], false, true, readProcessMetrics);
    try {
        expect(fixture.collector.getSnapshot().processResources).toEqual([
            {
                pid: 42,
                creationTime: 1234,
                type: 'GPU',
                serviceName: 'GPU Process',
                cpuPercent: 12.5,
                idleWakeupsPerSecond: 3,
                cumulativeCpuSeconds: 9.5,
                memory: {
                    workingSetKb: 2048,
                    peakWorkingSetKb: 4096,
                    privateBytesKb: 1024,
                },
            },
        ]);
        expect(readProcessMetrics).toHaveBeenCalledTimes(1);

        fixture.monitor.sample();
        expect(readProcessMetrics).toHaveBeenCalledTimes(2);
        expect(fixture.collector.getSnapshot().processResources).toMatchObject([
            { pid: 43, type: 'Tab' },
        ]);
    } finally {
        fixture.monitor.dispose();
    }
});

test('snapshot inclui o estado da GPU quando o Chromium disponibiliza os dados', () => {
    let gpuStatus: {
        hardwareAccelerationEnabled: boolean;
        features: Record<string, string>;
    } | null = null;
    const fixture = setup([], false, true, undefined, () => gpuStatus);
    try {
        expect(fixture.collector.getSnapshot().gpuStatus).toBeNull();
        gpuStatus = {
            hardwareAccelerationEnabled: false,
            features: { webgl: 'disabled_software' },
        };
        fixture.monitor.sample();
        expect(fixture.collector.getSnapshot().gpuStatus).toEqual({
            sampledAt: 1000,
            hardwareAccelerationEnabled: false,
            features: { webgl: 'disabled_software' },
        });
    } finally {
        fixture.monitor.dispose();
    }
});

test('fila, metadados e contadores de produto medem transições sem duplicar progress/done/seed', () => {
    const fixture = setup();
    try {
        fixture.update(item());
        fixture.time(5000);
        fixture.update(item('a', { status: 'resolving-metadata' }));
        fixture.time(9000);
        fixture.update(item('a', { status: 'downloading' }));
        fixture.update(item('a', { status: 'downloading', progress: 0.5 }));
        fixture.time(15000);
        fixture.update(item('a', { status: 'completed', downloadedSize: 100, progress: 1 }));
        fixture.update(item('a', { status: 'completed', progress: 1 }));
        fixture.update(item('a', { status: 'seeding', progress: 1 }));
        const snapshot = fixture.collector.getSnapshot();
        expect(snapshot.downloads).toMatchObject({ added: 1, started: 1, completed: 1, failed: 0 });
        expect(snapshot.latency.queueWaitMs).toMatchObject({ count: 1, sumMs: 5000 });
        expect(snapshot.latency.metadataResolutionMs.resolved).toMatchObject({
            count: 1,
            sumMs: 4000,
        });
        fixture.remove(item().infoHash);
        fixture.update(item('a', { status: 'downloading' }));
        fixture.update(item('a', { status: 'completed' }));
        expect(fixture.collector.getSnapshot().downloads).toMatchObject({
            added: 2,
            started: 2,
            completed: 2,
        });
    } finally {
        fixture.monitor.dispose();
    }
});

test('restauração e importação de arquivos completos não inventam novas transferências ou conclusões', () => {
    const fixture = setup([], true);
    try {
        fixture.update(item('a', { status: 'completed' }));
        fixture.update(item('b', { status: 'downloading' }));
        fixture.update(item('c', { status: 'queued' }));
        fixture.time(100);
        fixture.monitor.startLifecycleTracking();
        fixture.update(item('a', { status: 'seeding' }));
        fixture.update(item('d', { status: 'completed' }));
        expect(fixture.collector.getSnapshot().downloads).toMatchObject({
            added: 1,
            started: 0,
            completed: 0,
        });
        fixture.update(item('b', { status: 'completed' }));
        fixture.time(400);
        fixture.update(item('c', { status: 'downloading' }));
        expect(fixture.collector.getSnapshot().downloads).toMatchObject({
            added: 1,
            started: 1,
            completed: 1,
        });
        expect(fixture.collector.getSnapshot().latency.queueWaitMs.sumMs).toBe(300);
        expect(fixture.collector.getSnapshot().traffic.downloadedBytes).toBe(0);
        fixture.monitor.sample();
        expect(fixture.collector.getSnapshot().operational!.states).toMatchObject({
            seeding: 1,
            completed: 2,
            downloading: 1,
        });
    } finally {
        fixture.monitor.dispose();
    }
});

test('metadados cancelados, falhas e timeouts têm distribuições e causas separadas', () => {
    const fixture = setup();
    try {
        fixture.update(item('a', { status: 'resolving-metadata' }));
        fixture.time(100);
        fixture.update(item('a', { status: 'paused' }));
        fixture.time(200);
        fixture.update(item('a', { status: 'resolving-metadata' }));
        fixture.time(400);
        fixture.update(item('a', { status: 'metadata-failed' }));
        fixture.update(item('a', { status: 'metadata-failed' }));
        fixture.time(500);
        fixture.update(item('a', { status: 'resolving-metadata' }));
        fixture.time(800);
        fixture.update(item('a', { status: 'error', errorMessage: 'ENOSPC' }));
        fixture.update(item('b'));
        fixture.time(900);
        fixture.update(item('b', { status: 'paused' }));
        const snapshot = fixture.collector.getSnapshot();
        expect(snapshot.latency.metadataResolutionMs.cancelled).toMatchObject({
            count: 1,
            sumMs: 100,
        });
        expect(snapshot.latency.metadataResolutionMs.failed).toMatchObject({
            count: 2,
            sumMs: 500,
        });
        expect(snapshot.latency.queueWaitMs.count).toBe(0);
        expect(snapshot.downloads).toMatchObject({ started: 1, failed: 1, metadataFailed: 1 });
        expect(snapshot.errorCauses.downloads).toMatchObject({ timeout: 1, disk_space: 1 });
        fixture.update(item('c', { status: 'resolving-metadata' }));
        fixture.time(1000);
        fixture.remove(item('c').infoHash);
        expect(fixture.collector.getSnapshot().latency.metadataResolutionMs.cancelled.count).toBe(
            2,
        );
    } finally {
        fixture.monitor.dispose();
    }
});

test('erros da engine são medidos com zero janelas e snapshots persistem diagnósticos agregados', () => {
    const fixture = setup();
    try {
        fixture.engine.emit(
            'error',
            item().infoHash,
            Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'), { code: 'EACCES' }),
        );
        fixture.update(item('a', { diagnostic: 'stalled' }));
        fixture.update(item('b', { diagnostic: 'no-peers' }));
        fixture.update(item('c', { diagnostic: 'disk-space' }));
        fixture.monitor.sample();
        const snapshot = fixture.collector.getSnapshot();
        expect(snapshot.engineErrorCount).toBe(1);
        expect(snapshot.errorCauses.engine.permission).toBe(1);
        expect(snapshot.operational).toMatchObject({
            queue: { pendingAdds: 1, occupiedSlots: 2 },
            eventLoop: { p99Ms: 60, utilization: 0.5 },
            diagnostics: { stalled: 1, 'no-peers': 1, 'disk-space': 1 },
        });
        for (const privateValue of [
            'SYNTHETIC_PRIVATE_NAME',
            'SYNTHETIC_PRIVATE_FOLDER',
            'SYNTHETIC_PRIVATE_ERROR',
            item().infoHash,
        ])
            expect(JSON.stringify(snapshot)).not.toContain(privateValue);
    } finally {
        fixture.monitor.dispose();
    }
});

test('disco agrega mínimos sem somar volumes duplicados, limita IO e impede sondagens sobrepostas', async () => {
    const fixture = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let active = 0;
    let maximum = 0;
    fixture.readDisk.mockImplementation(async (folder) => {
        active++;
        maximum = Math.max(maximum, active);
        await gate;
        active--;
        if (folder === '/offline') throw new Error('Sem acesso');
        return { freeBytes: folder === '/low' ? 32 * mib : 512 * mib, totalBytes: 1024 * mib };
    });
    try {
        for (const [index, folder] of [
            '/low',
            '/offline',
            '/other1',
            '/other2',
            '/other3',
            '/low',
        ].entries())
            fixture.update(item(String(index), { destinationFolder: folder }));
        const first = fixture.monitor.refreshDisk();
        await fixture.monitor.refreshDisk();
        expect(fixture.readDisk).toHaveBeenCalledTimes(4);
        release();
        await first;
        expect(maximum).toBe(4);
        expect(fixture.readDisk).toHaveBeenCalledTimes(6);
        fixture.monitor.sample();
        expect(fixture.collector.getSnapshot().operational!.disk).toMatchObject({
            destinationsChecked: 6,
            unavailableDestinations: 1,
            lowSpaceDestinations: 1,
            minimumFreeBytes: 32 * mib,
            minimumFreeRatio: 1 / 32,
        });
    } finally {
        release();
        fixture.monitor.dispose();
    }
});

test('falha de disco e ausência de amostras não viram capacidade zero ou saúde falsa', async () => {
    const fixture = setup();
    try {
        fixture.readDisk.mockRejectedValue(new Error('Indisponível'));
        await fixture.monitor.refreshDisk();
        fixture.monitor.sample();
        expect(fixture.collector.getSnapshot().operational!.disk).toMatchObject({
            unavailableDestinations: 1,
            minimumFreeBytes: null,
            minimumFreeRatio: null,
        });
        fixture.loopSampler.read.mockImplementationOnce(() => {
            throw new Error('Falha de sondagem');
        });
        const before = fixture.collector.getSnapshot().series.length;
        fixture.monitor.sample();
        expect(fixture.collector.getSnapshot().collectionErrorCount).toBe(1);
        expect(fixture.collector.getSnapshot().series).toHaveLength(before);
    } finally {
        fixture.monitor.dispose();
    }
});

test('dispose remove listeners, timers e monitor nativo; resultados tardios não alteram métricas', async () => {
    jest.useFakeTimers();
    const fixture = setup([], false, false);
    try {
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(2);
        fixture.monitor.dispose();
        fixture.monitor.dispose();
        const before = fixture.collector.getSnapshot();
        jest.advanceTimersByTime(60000);
        fixture.update(item('a', { status: 'downloading' }));
        fixture.engine.emit('error', item().infoHash, new Error('Após dispose'));
        fixture.monitor.sample();
        await fixture.monitor.refreshDisk();
        expect(fixture.manager.listenerCount('update')).toBe(0);
        expect(fixture.manager.listenerCount('remove')).toBe(0);
        expect(fixture.engine.listenerCount('error')).toBe(1);
        expect(fixture.loopSampler.dispose).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
        expect(fixture.collector.getSnapshot().downloads).toEqual(before.downloads);
        expect(fixture.collector.getSnapshot().engineErrorCount).toBe(before.engineErrorCount);
        expect(fixture.collector.getSnapshot().series).toEqual(before.series);
    } finally {
        fixture.monitor.dispose();
        jest.useRealTimers();
    }
});

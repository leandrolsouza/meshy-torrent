import fs from 'fs';
import { createMetricsCollector } from '../../main/metrics';
import { classifyErrorCause, ERROR_CAUSES } from '../../main/metricErrorCause';
import { ErrorCodes } from '../../shared/errorCodes';
import type { OperationalGauges } from '../../main/operationalMetricTypes';
import { emptyStateCounts } from '../../main/operationalMetricTypes';

function gauges(): OperationalGauges {
    return {
        states: emptyStateCounts(),
        queue: {
            activeDownloads: 1,
            pendingAdds: 1,
            occupiedSlots: 2,
            maxConcurrentDownloads: 3,
            queuedDownloads: 2,
            activeSeeders: 1,
            slotUtilization: 2 / 3,
        },
        eventLoop: { utilization: 0.4, p50Ms: 20, p95Ms: 40, p99Ms: 50, maxMs: 80, meanMs: 25 },
        disk: {
            sampledAt: 1000,
            destinationsChecked: 1,
            unavailableDestinations: 0,
            lowSpaceDestinations: 0,
            minimumFreeBytes: 1000000000,
            minimumFreeRatio: 0.5,
        },
        diagnostics: {
            metadata: 1,
            'metadata-failed': 0,
            queued: 2,
            'disk-space': 0,
            'folder-unavailable': 0,
            'trackers-error': 0,
            'no-peers': 1,
            'no-selection': 0,
            stalled: 0,
        },
    };
}

test('tráfego e taxas usam deltas reais e relógio monotônico, com baseline explícito', () => {
    let clock = 0;
    const collector = createMetricsCollector({ clock: () => clock, now: () => 1000 + clock });
    collector.recordTransfer('download', 5000);
    collector.recordOperationalSample(gauges());
    expect(collector.getSnapshot().operational).toMatchObject({
        elapsedMs: null,
        downloadBytesPerSecond: null,
    });
    clock = 10000;
    collector.recordTransfer('download', 1000);
    collector.recordTransfer('upload', 500);
    for (const invalid of [0, -100, NaN, Infinity]) collector.recordTransfer('download', invalid);
    collector.recordIpcCall('torrent:pause', 25, 'success');
    collector.recordIpcCall('torrent:pause', 10000, 'exception', 'timeout');
    collector.recordDownload('started');
    collector.recordDownload('completed');
    collector.recordOperationalSample(gauges());
    const snapshot = collector.getSnapshot();
    expect(snapshot.traffic).toEqual({ downloadedBytes: 6000, uploadedBytes: 500 });
    expect(snapshot.operational).toMatchObject({
        timestamp: 11000,
        elapsedMs: 10000,
        downloadedBytes: 6000,
        downloadBytesPerSecond: 100,
        uploadBytesPerSecond: 50,
        ipcCallsPerSecond: 0.2,
        ipcErrorsPerSecond: 0.1,
        downloadsStarted: 1,
        downloadsCompleted: 1,
    });
    expect(snapshot.latency.ipcByChannel['torrent:pause']).toMatchObject({
        count: 2,
        p95Ms: 10000,
        p99Ms: 10000,
    });
    expect(snapshot.avgLatencyByChannel['torrent:pause']).toBe(5013);
    expect(snapshot.errorCauses.ipc.timeout).toBe(1);
});

test('históricos são limitados a 180 pontos e cópias não modificam gauges ou histogramas internos', () => {
    let clock = 0;
    const collector = createMetricsCollector({ clock: () => clock, now: () => clock });
    const input = gauges();
    collector.recordOperationalSample(input);
    input.queue.pendingAdds = 1000;
    for (let i = 1; i <= 200; i++) {
        clock = i * 10000;
        collector.recordOperationalSample(gauges());
    }
    collector.recordQueueWait(5000);
    collector.recordMetadataResolution('resolved', 1000);
    const saved = collector.getSnapshot();
    expect(saved.series).toHaveLength(180);
    expect(saved.series[0]!.timestamp).toBe(210000);
    saved.series[0]!.queue.pendingAdds = -1;
    saved.series[0]!.disk!.minimumFreeBytes = -1;
    saved.operational!.diagnostics.stalled = 1000;
    saved.latency.queueWaitMs.buckets[0]!.count = -1;
    saved.errorCauses.ipc.unknown = -1;
    const fresh = collector.getSnapshot();
    expect(fresh.series[0]!.queue.pendingAdds).toBe(1);
    expect(fresh.series[0]!.disk!.minimumFreeBytes).toBeGreaterThan(0);
    expect(fresh.operational!.diagnostics.stalled).toBe(0);
    expect(fresh.latency.queueWaitMs.buckets[0]!.count).toBe(0);
    expect(fresh.errorCauses.ipc.unknown).toBe(0);
});

test.each([
    [new Error(ErrorCodes.INVALID_PARAMS), 'validation'],
    [new Error(ErrorCodes.TORRENT_DUPLICATE), 'duplicate'],
    [Object.assign(new Error('Falha'), { code: 'ENOENT' }), 'not_found'],
    [Object.assign(new Error('Falha'), { code: 'ENOSPC' }), 'disk_space'],
    [Object.assign(new Error('Falha'), { code: 'EACCES' }), 'permission'],
    [Object.assign(new Error('Falha'), { code: 'EIO' }), 'filesystem'],
    [Object.assign(new Error('Falha'), { code: 'ECONNRESET' }), 'network'],
    [
        Object.assign(new Error('Falha'), { code: 'ERR_NETWORK_DESTINATION_BLOCKED' }),
        'network_policy',
    ],
    [Object.assign(new Error('Falha'), { code: 'ERR_REQUEST_TIMEOUT' }), 'timeout'],
    [new Error(ErrorCodes.PREPARATION_CANCELLED), 'cancelled'],
    [new Error(ErrorCodes.ENGINE_RESTARTING), 'engine_unavailable'],
    ['oom', 'out_of_memory'],
    [
        Object.assign(new Error('Invólucro'), {
            cause: Object.assign(new Error('Causa'), { code: 'ETIMEDOUT' }),
        }),
        'timeout',
    ],
    [{ message: 'Invólucro', errors: [{ code: 'ENOSPC' }] }, 'disk_space'],
    [{ code: 'SYNTHETIC_PRIVATE_TOKEN', message: 'Falha https://private.test/secret' }, 'unknown'],
] as const)(
    'classifica causas sem criar labels com códigos ou mensagens livres: %p',
    (error, expected) => {
        expect(classifyErrorCause(error)).toBe(expected);
    },
);

test('classes de erro particionam cada fonte e não retêm identificadores ou mensagens', () => {
    const collector = createMetricsCollector();
    collector.recordIpcCall('torrent:pause', 5, 'unauthorized');
    collector.recordIpcCall('torrent:pause', 5, 'rate_limited');
    collector.recordEngineError(
        Object.assign(new Error('SYNTHETIC_PRIVATE_TOKEN'), { code: 'ECONNRESET' }),
    );
    collector.recordRendererCrash('oom');
    collector.recordRendererError();
    collector.recordDownload('metadataFailed', ErrorCodes.METADATA_TIMEOUT);
    const snapshot = collector.getSnapshot();
    expect(snapshot.errorCauses.ipc).toMatchObject({ unauthorized: 1, rate_limit: 1 });
    expect(snapshot.errorCauses.engine.network).toBe(1);
    expect(snapshot.errorCauses.renderer).toMatchObject({ out_of_memory: 1, unknown: 1 });
    expect(snapshot.errorCauses.downloads.timeout).toBe(1);
    expect(Object.keys(snapshot.errorCauses.engine)).toEqual([...ERROR_CAUSES]);
    expect(Object.values(snapshot.errorCauses.ipc).reduce((a, b) => a + b, 0)).toBe(
        snapshot.ipcErrorCount,
    );
    expect(JSON.stringify(snapshot)).not.toContain('SYNTHETIC_PRIVATE_TOKEN');
});

test('uptime independe de ajustes da data do sistema', () => {
    let wall = 1000;
    let clock = 0;
    const collector = createMetricsCollector({ now: () => wall, clock: () => clock });
    wall = -1000;
    clock = 200;
    expect(collector.getSnapshot()).toMatchObject({ startedAt: 1000, uptimeMs: 200 });
});

test('snapshots persistidos incluem séries e distribuições; reativar persistência não duplica timers', async () => {
    jest.useFakeTimers();
    const logsDir = fs.mkdtempSync(`${process.env['TEMP'] ?? '/tmp'}/metrics-test-`);
    const collector = createMetricsCollector();
    try {
        collector.enablePersistence(logsDir);
        collector.enablePersistence(logsDir);
        expect(jest.getTimerCount()).toBe(1);
        collector.recordTransfer('upload', 42);
        collector.recordOperationalSample(gauges());
        await collector.persistSnapshot();
        const [entry] = await collector.readPersistedSnapshots();
        expect(entry).toBeDefined();
        expect(entry!.snapshot.traffic.uploadedBytes).toBe(42);
        expect(entry!.snapshot.series).toHaveLength(1);
        expect(entry!.snapshot.latency.queueWaitMs.p99Ms).toBeNull();
    } finally {
        collector.disablePersistence();
        fs.rmSync(logsDir, { recursive: true, force: true });
        expect(jest.getTimerCount()).toBe(0);
        jest.useRealTimers();
    }
});

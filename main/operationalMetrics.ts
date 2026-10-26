import { statfs } from 'node:fs/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { ErrorCodes } from '../shared/errorCodes';
import type { DownloadItem, TorrentStatus } from '../shared/types';
import type { DownloadManager } from './downloadManager';
import type { TorrentErrorEventSource } from './enginePorts';
import type { SettingsManager } from './settingsManager';
import type { DownloadDiagnostics } from './downloadDiagnostics';
import { DISK_SAFETY_MARGIN_BYTES } from './diskSpace';
import { metrics } from './metrics';
import type { createMetricsCollector } from './metrics';
import type { DiskMetrics, EventLoopMetrics } from './operationalMetricTypes';
import { emptyDiagnosticCounts, emptyStateCounts } from './operationalMetricTypes';

function createEventLoopSampler() {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    let previous = performance.eventLoopUtilization();
    return {
        read(): EventLoopMetrics {
            const current = performance.eventLoopUtilization();
            const delta = performance.eventLoopUtilization(current, previous);
            previous = current;
            const ms = (value: number): number | null =>
                histogram.count && Number.isFinite(value) ? value / 1e6 : null;
            const result = {
                utilization: delta.active + delta.idle > 0 ? delta.utilization : null,
                p50Ms: ms(histogram.percentile(50)),
                p95Ms: ms(histogram.percentile(95)),
                p99Ms: ms(histogram.percentile(99)),
                maxMs: ms(histogram.max),
                meanMs: ms(histogram.mean),
            };
            histogram.reset();
            return result;
        },
        dispose(): void {
            histogram.disable();
        },
    };
}

const isActive = (status: TorrentStatus): boolean =>
    status === 'downloading' || status === 'resolving-metadata';
const isComplete = (status: TorrentStatus): boolean =>
    status === 'completed' || status === 'seeding';
interface ItemObservation {
    status: TorrentStatus;
    started: boolean;
    completed: boolean;
    queuedAt?: number;
    metadataAt?: number;
}

/** Coleta independente de janelas; somente DTOs numéricos saem deste observador. */
export function createOperationalMetrics(options: {
    manager: Pick<DownloadManager, 'getAll' | 'getOperationalState' | 'on' | 'removeListener'>;
    engine: TorrentErrorEventSource;
    settings: Pick<SettingsManager, 'get'>;
    diagnostics?: Pick<DownloadDiagnostics, 'enrich'>;
    collector?: ReturnType<typeof createMetricsCollector>;
    clock?: () => number;
    now?: () => number;
    loopSampler?: { read(): EventLoopMetrics; dispose(): void };
    readDisk?: (folder: string) => Promise<{ freeBytes: number; totalBytes: number }>;
    /** Lê métricas do Electron uma vez por amostra para manter intervalos de CPU consistentes. */
    readProcessMetrics?: () => Electron.ProcessMetric[];
    /** Retorna null até o Chromium disponibilizar as informações da GPU. */
    readGpuStatus?: () => {
        hardwareAccelerationEnabled: boolean;
        features: Record<string, string>;
    } | null;
    deferLifecycle?: boolean;
    disableTimers?: boolean;
}) {
    const collector = options.collector ?? metrics;
    const clock = options.clock ?? (() => performance.now());
    const now = options.now ?? (() => Date.now());
    const loop = options.loopSampler ?? createEventLoopSampler();
    const readDisk =
        options.readDisk ??
        (async (folder: string) => {
            const space = await statfs(folder, { bigint: true });
            return {
                freeBytes: Number(space.bavail * space.bsize),
                totalBytes: Number(space.blocks * space.bsize),
            };
        });
    const items = new Map<string, ItemObservation>();
    let ready = false;
    let lifecycleRequested = false;
    let disposed = false;
    let checkingDisk = false;
    let disk: DiskMetrics | null = null;

    const onUpdate = (item: DownloadItem): void => {
        if (!ready || disposed) return;
        try {
            const time = clock();
            const previous = items.get(item.infoHash);
            const state: ItemObservation = previous ?? {
                status: item.status,
                started: false,
                completed: false,
            };
            if (!previous) collector.recordDownload('added');
            if (!state.started && isActive(item.status)) {
                collector.recordDownload('started');
                state.started = true;
            }
            if (!state.completed && isComplete(item.status)) {
                if (previous && state.started) collector.recordDownload('completed');
                state.completed = true;
            }
            if (previous?.status !== item.status) {
                if (item.status === 'metadata-failed')
                    collector.recordDownload('metadataFailed', ErrorCodes.METADATA_TIMEOUT);
                else if (item.status === 'error' || item.status === 'files-not-found')
                    collector.recordDownload(
                        'failed',
                        item.status === 'files-not-found'
                            ? ErrorCodes.FILE_SOURCE_MISSING
                            : item.errorMessage,
                    );
            }
            if (state.queuedAt !== undefined && item.status !== 'queued') {
                if (isActive(item.status))
                    collector.recordQueueWait(Math.max(0, time - state.queuedAt));
                delete state.queuedAt;
            }
            if (state.metadataAt !== undefined && item.status !== 'resolving-metadata') {
                const outcome =
                    item.status === 'downloading' || isComplete(item.status)
                        ? 'resolved'
                        : ['error', 'metadata-failed', 'files-not-found'].includes(item.status)
                          ? 'failed'
                          : 'cancelled';
                collector.recordMetadataResolution(outcome, Math.max(0, time - state.metadataAt));
                delete state.metadataAt;
            }
            if (item.status === 'queued' && state.queuedAt === undefined) state.queuedAt = time;
            if (item.status === 'resolving-metadata' && state.metadataAt === undefined)
                state.metadataAt = time;
            state.status = item.status;
            items.set(item.infoHash, state);
        } catch {
            collector.recordCollectionError();
        }
    };
    const onRemove = (hash: string): void => {
        if (disposed) return;
        const state = items.get(hash);
        if (state?.metadataAt !== undefined)
            collector.recordMetadataResolution(
                'cancelled',
                Math.max(0, clock() - state.metadataAt),
            );
        items.delete(hash);
    };
    const onEngineError = (_hash: string, error: Error): void => {
        if (!disposed) collector.recordEngineError(error);
    };

    const startLifecycleTracking = (): void => {
        if (ready || disposed) return;
        lifecycleRequested = true;
        try {
            const time = clock();
            for (const item of options.manager.getAll())
                items.set(item.infoHash, {
                    status: item.status,
                    started: isActive(item.status) || isComplete(item.status),
                    completed: isComplete(item.status),
                    ...(item.status === 'queued' ? { queuedAt: time } : {}),
                    ...(item.status === 'resolving-metadata' ? { metadataAt: time } : {}),
                });
            ready = true;
        } catch {
            collector.recordCollectionError();
        }
    };

    const sample = (): void => {
        if (disposed) return;
        if (options.readProcessMetrics) {
            try {
                collector.recordProcessResources(
                    options.readProcessMetrics().map((processMetric) => ({
                        pid: processMetric.pid,
                        creationTime: processMetric.creationTime,
                        type: processMetric.type,
                        serviceName: processMetric.serviceName ?? processMetric.name ?? null,
                        cpuPercent: processMetric.cpu.percentCPUUsage,
                        idleWakeupsPerSecond: processMetric.cpu.idleWakeupsPerSecond,
                        cumulativeCpuSeconds: processMetric.cpu.cumulativeCPUUsage ?? null,
                        memory: {
                            workingSetKb: processMetric.memory.workingSetSize,
                            peakWorkingSetKb: processMetric.memory.peakWorkingSetSize,
                            privateBytesKb: processMetric.memory.privateBytes ?? null,
                        },
                    })),
                );
            } catch {
                collector.recordCollectionError();
            }
        }
        if (options.readGpuStatus) {
            try {
                const gpuStatus = options.readGpuStatus();
                if (gpuStatus) collector.recordGpuStatus({ ...gpuStatus, sampledAt: now() });
            } catch {
                collector.recordCollectionError();
            }
        }
        try {
            if (lifecycleRequested && !ready) startLifecycleTracking();
            const snapshot = options.manager.getAll();
            const enriched = options.diagnostics?.enrich(snapshot) ?? snapshot;
            const diagnostics = emptyDiagnosticCounts();
            const states = emptyStateCounts();
            for (const item of snapshot)
                if (Object.prototype.hasOwnProperty.call(states, item.status))
                    states[item.status]++;
            for (const item of enriched)
                if (
                    item.diagnostic &&
                    Object.prototype.hasOwnProperty.call(diagnostics, item.diagnostic)
                )
                    diagnostics[item.diagnostic]++;
            collector.recordOperationalSample({
                queue: options.manager.getOperationalState(),
                eventLoop: loop.read(),
                disk,
                diagnostics,
                states,
            });
        } catch {
            collector.recordCollectionError();
        }
    };

    const refreshDisk = async (): Promise<void> => {
        if (checkingDisk || disposed) return;
        checkingDisk = true;
        try {
            const folders = [
                ...new Set([
                    options.settings.get().destinationFolder,
                    ...options.manager.getAll().map((item) => item.destinationFolder),
                ]),
            ].filter(Boolean);
            const result: DiskMetrics = {
                sampledAt: now(),
                destinationsChecked: folders.length,
                unavailableDestinations: 0,
                lowSpaceDestinations: 0,
                minimumFreeBytes: null,
                minimumFreeRatio: null,
            };
            // Limitar concorrência de IO; não resolver volumes de forma síncrona no event loop.
            for (let offset = 0; offset < folders.length && !disposed; offset += 4)
                await Promise.all(
                    folders.slice(offset, offset + 4).map(async (folder) => {
                        try {
                            const space = await readDisk(folder);
                            if (
                                !Number.isFinite(space.freeBytes) ||
                                space.freeBytes < 0 ||
                                !Number.isFinite(space.totalBytes) ||
                                space.totalBytes <= 0
                            )
                                throw new Error('Espaço indisponível');
                            result.minimumFreeBytes = Math.min(
                                result.minimumFreeBytes ?? Infinity,
                                space.freeBytes,
                            );
                            result.minimumFreeRatio = Math.min(
                                result.minimumFreeRatio ?? 1,
                                Math.min(1, space.freeBytes / space.totalBytes),
                            );
                            if (space.freeBytes < DISK_SAFETY_MARGIN_BYTES)
                                result.lowSpaceDestinations++;
                        } catch {
                            result.unavailableDestinations++;
                        }
                    }),
                );
            if (!disposed) {
                result.sampledAt = now();
                disk = result;
            }
        } catch {
            if (!disposed) collector.recordCollectionError();
        } finally {
            checkingDisk = false;
        }
    };

    options.manager.on('update', onUpdate);
    options.manager.on('remove', onRemove);
    options.engine.on('error', onEngineError);
    if (!options.deferLifecycle) startLifecycleTracking();
    sample();
    const sampleTimer = options.disableTimers ? undefined : setInterval(sample, 10000);
    const diskTimer = options.disableTimers
        ? undefined
        : setInterval(() => void refreshDisk(), 30000);
    sampleTimer?.unref();
    diskTimer?.unref();
    if (!options.disableTimers) void refreshDisk();
    return {
        sample,
        refreshDisk,
        startLifecycleTracking,
        dispose(): void {
            if (disposed) return;
            disposed = true;
            clearInterval(sampleTimer);
            clearInterval(diskTimer);
            options.manager.removeListener('update', onUpdate);
            options.manager.removeListener('remove', onRemove);
            options.engine.removeListener('error', onEngineError);
            loop.dispose();
            items.clear();
        },
    };
}

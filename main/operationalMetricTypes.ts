import type { DownloadDiagnostic, TorrentStatus } from '../shared/types';
import type { DownloadQueueStats } from './downloadManager';

export const METRIC_DIAGNOSTICS: readonly DownloadDiagnostic[] = [
    'metadata',
    'metadata-failed',
    'queued',
    'disk-space',
    'folder-unavailable',
    'trackers-error',
    'no-peers',
    'no-selection',
    'stalled',
];
export function emptyDiagnosticCounts(): Record<DownloadDiagnostic, number> {
    return Object.fromEntries(METRIC_DIAGNOSTICS.map((key) => [key, 0])) as Record<
        DownloadDiagnostic,
        number
    >;
}

export const METRIC_STATES: readonly TorrentStatus[] = [
    'queued',
    'resolving-metadata',
    'downloading',
    'paused',
    'completed',
    'seeding',
    'error',
    'metadata-failed',
    'files-not-found',
];
export function emptyStateCounts(): Record<TorrentStatus, number> {
    return Object.fromEntries(METRIC_STATES.map((key) => [key, 0])) as Record<
        TorrentStatus,
        number
    >;
}

export interface EventLoopMetrics {
    utilization: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
    meanMs: number | null;
}

export interface DiskMetrics {
    sampledAt: number;
    destinationsChecked: number;
    unavailableDestinations: number;
    lowSpaceDestinations: number;
    minimumFreeBytes: number | null;
    minimumFreeRatio: number | null;
}

export interface OperationalGauges {
    queue: DownloadQueueStats;
    eventLoop: EventLoopMetrics;
    disk: DiskMetrics | null;
    diagnostics: Record<DownloadDiagnostic, number>;
    states: Record<TorrentStatus, number>;
}

export interface OperationalMetricPoint extends OperationalGauges {
    timestamp: number;
    elapsedMs: number | null;
    downloadedBytes: number;
    uploadedBytes: number;
    downloadBytesPerSecond: number | null;
    uploadBytesPerSecond: number | null;
    ipcCallsPerSecond: number | null;
    ipcErrorsPerSecond: number | null;
    downloadsStarted: number;
    downloadsCompleted: number;
}

// ─── Métricas de operação ─────────────────────────────────────────────────────
//
// Coleta métricas in-memory sobre a operação do Meshy Torrent: contadores de erro,
// latência de chamadas IPC, uptime, e contadores de operações.
//
// Persiste snapshots periódicos em disco (a cada 5 minutos) para análise
// post-mortem. O arquivo de métricas usa rotating com tamanho máximo de 1MB.
//
// Acessível via IPC `app:get-metrics` para exibição no renderer (debugging).

import { writeFileSync, readFileSync, statSync, renameSync } from 'fs';
import { join } from 'path';
import { performance } from 'node:perf_hooks';
import { createMetricHistogram } from './metricHistogram';
import type { HistogramSnapshot } from './metricHistogram';
import { classifyErrorCause, emptyErrorCauses } from './metricErrorCause';
import type { ErrorCause, ErrorCauseCounts } from './metricErrorCause';
import type { OperationalGauges, OperationalMetricPoint } from './operationalMetricTypes';
import {
    emptyDiagnosticCounts,
    emptyStateCounts,
    METRIC_DIAGNOSTICS,
    METRIC_STATES,
} from './operationalMetricTypes';
import type { TorrentSource } from '../shared/types';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Classes fixas: nenhum payload, mensagem de erro ou identificador vira label. */
export type IpcOutcome = 'success' | 'error' | 'exception' | 'rate_limited' | 'unauthorized';
export type IpcOutcomeCounts = Record<IpcOutcome, number>;
export type DownloadMetric = 'added' | 'started' | 'completed' | 'failed' | 'metadataFailed';
export type MetadataOutcome = 'resolved' | 'failed' | 'cancelled';
export interface TransferMetrics {
    recordTransfer(direction: 'download' | 'upload', bytes: number): void;
}

function copyGauges(gauges: OperationalGauges): OperationalGauges {
    const { queue, eventLoop, disk } = gauges;
    const diagnostics = emptyDiagnosticCounts();
    for (const key of METRIC_DIAGNOSTICS) diagnostics[key] = gauges.diagnostics[key];
    const states = emptyStateCounts();
    for (const key of METRIC_STATES) states[key] = gauges.states[key];
    // Seleção explícita: campos futuros do domínio não entram nas métricas por spread.
    return {
        queue: {
            activeDownloads: queue.activeDownloads,
            pendingAdds: queue.pendingAdds,
            occupiedSlots: queue.occupiedSlots,
            maxConcurrentDownloads: queue.maxConcurrentDownloads,
            queuedDownloads: queue.queuedDownloads,
            activeSeeders: queue.activeSeeders,
            slotUtilization: queue.slotUtilization,
        },
        eventLoop: {
            utilization: eventLoop.utilization,
            p50Ms: eventLoop.p50Ms,
            p95Ms: eventLoop.p95Ms,
            p99Ms: eventLoop.p99Ms,
            maxMs: eventLoop.maxMs,
            meanMs: eventLoop.meanMs,
        },
        disk: disk
            ? {
                  sampledAt: disk.sampledAt,
                  destinationsChecked: disk.destinationsChecked,
                  unavailableDestinations: disk.unavailableDestinations,
                  lowSpaceDestinations: disk.lowSpaceDestinations,
                  minimumFreeBytes: disk.minimumFreeBytes,
                  minimumFreeRatio: disk.minimumFreeRatio,
              }
            : null,
        diagnostics,
        states,
    };
}

function clonePoint(point: OperationalMetricPoint): OperationalMetricPoint {
    return {
        ...copyGauges(point),
        timestamp: point.timestamp,
        elapsedMs: point.elapsedMs,
        downloadedBytes: point.downloadedBytes,
        uploadedBytes: point.uploadedBytes,
        downloadBytesPerSecond: point.downloadBytesPerSecond,
        uploadBytesPerSecond: point.uploadBytesPerSecond,
        ipcCallsPerSecond: point.ipcCallsPerSecond,
        ipcErrorsPerSecond: point.ipcErrorsPerSecond,
        downloadsStarted: point.downloadsStarted,
        downloadsCompleted: point.downloadsCompleted,
    };
}

function emptyOutcomeCounts(): IpcOutcomeCounts {
    return { success: 0, error: 0, exception: 0, rate_limited: 0, unauthorized: 0 };
}

function metadataHistograms() {
    return {
        resolved: createMetricHistogram(),
        failed: createMetricHistogram(),
        cancelled: createMetricHistogram(),
    };
}

/** Snapshot das métricas coletadas */
export interface MetricsSnapshot {
    /** Timestamp de quando o app foi iniciado (ms desde epoch) */
    startedAt: number;
    /** Uptime do app em milissegundos */
    uptimeMs: number;
    /** Total de chamadas nos canais IPC registrados, incluindo bloqueios */
    ipcCallCount: number;
    /** Total de desfechos IPC diferentes de success */
    ipcErrorCount: number;
    /** Contadores mutuamente exclusivos por classe de resultado */
    ipcOutcomes: IpcOutcomeCounts;
    /** Resultados por canal IPC registrado */
    outcomesByChannel: Record<string, IpcOutcomeCounts>;
    /** Contadores de erro por canal IPC */
    errorsByChannel: Record<string, number>;
    /** Latência média por canal IPC (ms) */
    avgLatencyByChannel: Record<string, number>;
    /** Contadores de chamadas por canal IPC */
    callsByChannel: Record<string, number>;
    latency: {
        ipcByChannel: Record<string, HistogramSnapshot>;
        queueWaitMs: HistogramSnapshot;
        metadataResolutionMs: Record<MetadataOutcome, HistogramSnapshot>;
        metadataPreparationMs: Record<
            TorrentSource['kind'],
            Record<MetadataOutcome, HistogramSnapshot>
        >;
    };
    traffic: { downloadedBytes: number; uploadedBytes: number };
    downloads: Record<DownloadMetric, number>;
    errorCauses: Record<'ipc' | 'engine' | 'renderer' | 'downloads', ErrorCauseCounts>;
    /** Última amostra e até 180 pontos; null antes de iniciar a coleta operacional. */
    operational: OperationalMetricPoint | null;
    series: OperationalMetricPoint[];
    /** Falhas de sondagem, separadas de erros do aplicativo. */
    collectionErrorCount: number;
    /** Total de erros do torrent engine */
    engineErrorCount: number;
    /** Total de crashes do renderer detectados */
    rendererCrashCount: number;
    /** Total de erros reportados pelo renderer */
    rendererErrorCount: number;
    /** Uso de memória do processo principal (bytes) */
    memoryUsage: {
        heapUsed: number;
        heapTotal: number;
        rss: number;
    };
}

/** Entrada persistida no arquivo de métricas */
interface PersistedMetricsEntry {
    timestamp: string; // ISO 8601
    snapshot: MetricsSnapshot;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Intervalo de persistência de métricas (5 minutos) */
const PERSIST_INTERVAL_MS = 5 * 60 * 1_000;

/** Tamanho máximo do arquivo de métricas antes de rotacionar (1 MB) */
const MAX_METRICS_FILE_SIZE = 1_024 * 1_024;

// ─── Implementation ───────────────────────────────────────────────────────────

class MetricsCollector {
    private readonly startedAt: number;
    private readonly startedClock: number;
    private readonly now: () => number;
    private readonly clock: () => number;
    private ipcCallCount = 0;
    private ipcErrorCount = 0;
    private engineErrorCount = 0;
    private rendererCrashCount = 0;
    private rendererErrorCount = 0;
    private collectionErrorCount = 0;

    /** Contadores de erro por canal */
    private readonly errorsByChannel = new Map<string, number>();
    /** Soma de latências por canal (para calcular média) */
    private readonly latencySumByChannel = new Map<string, number>();
    /** Contadores de chamadas por canal */
    private readonly callsByChannel = new Map<string, number>();
    private readonly ipcOutcomes = emptyOutcomeCounts();
    private readonly outcomesByChannel = new Map<string, IpcOutcomeCounts>();
    private readonly ipcLatency = new Map<string, ReturnType<typeof createMetricHistogram>>();
    private readonly queueWait = createMetricHistogram();
    private readonly metadata = metadataHistograms();
    private readonly preparation = {
        magnet: metadataHistograms(),
        file: metadataHistograms(),
        buffer: metadataHistograms(),
    };
    private readonly traffic = { downloadedBytes: 0, uploadedBytes: 0 };
    private readonly downloads: Record<DownloadMetric, number> = {
        added: 0,
        started: 0,
        completed: 0,
        failed: 0,
        metadataFailed: 0,
    };
    private readonly errorCauses = {
        ipc: emptyErrorCauses(),
        engine: emptyErrorCauses(),
        renderer: emptyErrorCauses(),
        downloads: emptyErrorCauses(),
    };
    private readonly series: OperationalMetricPoint[] = [];
    private previousSample: {
        clock: number;
        downloaded: number;
        uploaded: number;
        calls: number;
        errors: number;
    } | null = null;

    /** Caminho do arquivo de métricas (definido via enablePersistence) */
    private metricsFilePath: string | null = null;
    /** Timer de persistência periódica */
    private persistTimer: ReturnType<typeof setInterval> | null = null;

    constructor(options: { now?: () => number; clock?: () => number } = {}) {
        this.now = options.now ?? (() => Date.now());
        this.clock = options.clock ?? (() => performance.now());
        this.startedAt = this.now();
        this.startedClock = this.clock();
    }

    // ── IPC ───────────────────────────────────────────────────────────────────

    /** Registra uma chamada IPC com sua duração e resultado */
    recordIpcCall(
        channel: string,
        durationMs: number,
        outcome: IpcOutcome,
        cause: ErrorCause = 'unknown',
    ): void {
        durationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
        const latency = this.ipcLatency.get(channel) ?? createMetricHistogram();
        latency.observe(durationMs);
        this.ipcLatency.set(channel, latency);
        this.ipcCallCount++;
        this.ipcOutcomes[outcome]++;
        const channelOutcomes = this.outcomesByChannel.get(channel) ?? emptyOutcomeCounts();
        channelOutcomes[outcome]++;
        this.outcomesByChannel.set(channel, channelOutcomes);
        this.callsByChannel.set(channel, (this.callsByChannel.get(channel) ?? 0) + 1);
        this.latencySumByChannel.set(
            channel,
            (this.latencySumByChannel.get(channel) ?? 0) + durationMs,
        );

        if (outcome !== 'success') {
            this.ipcErrorCount++;
            this.errorCauses.ipc[
                outcome === 'unauthorized'
                    ? 'unauthorized'
                    : outcome === 'rate_limited'
                      ? 'rate_limit'
                      : cause
            ]++;
            this.errorsByChannel.set(channel, (this.errorsByChannel.get(channel) ?? 0) + 1);
        }
    }

    // ── Engine ────────────────────────────────────────────────────────────────

    /** Registra um erro do torrent engine */
    recordEngineError(error?: unknown): void {
        this.engineErrorCount++;
        this.errorCauses.engine[classifyErrorCause(error)]++;
    }

    // ── Renderer ──────────────────────────────────────────────────────────────

    /** Registra um crash do renderer process */
    recordRendererCrash(reason?: string): void {
        this.rendererCrashCount++;
        this.errorCauses.renderer[classifyErrorCause(reason)]++;
    }

    /** Registra um erro reportado pelo renderer */
    recordRendererError(error?: unknown): void {
        this.rendererErrorCount++;
        this.errorCauses.renderer[classifyErrorCause(error)]++;
    }

    recordTransfer(direction: 'download' | 'upload', bytes: number): void {
        if (!Number.isFinite(bytes) || bytes <= 0) return;
        this.traffic[direction === 'download' ? 'downloadedBytes' : 'uploadedBytes'] +=
            Math.trunc(bytes);
    }

    recordDownload(event: DownloadMetric, error?: unknown): void {
        this.downloads[event]++;
        if (event === 'failed' || event === 'metadataFailed')
            this.errorCauses.downloads[classifyErrorCause(error)]++;
    }

    recordQueueWait(durationMs: number): void {
        this.queueWait.observe(durationMs);
    }
    recordMetadataResolution(outcome: MetadataOutcome, durationMs: number): void {
        this.metadata[outcome].observe(durationMs);
    }
    recordMetadataPreparation(
        kind: TorrentSource['kind'],
        outcome: MetadataOutcome,
        durationMs: number,
    ): void {
        this.preparation[kind][outcome].observe(durationMs);
    }
    recordCollectionError(): void {
        this.collectionErrorCount++;
    }

    recordOperationalSample(gauges: OperationalGauges): void {
        const clock = this.clock();
        const previous = this.previousSample;
        const elapsedMs = previous ? Math.max(0, clock - previous.clock) : null;
        const rate = (value: number, before: number): number | null =>
            elapsedMs && elapsedMs > 0 ? ((value - before) * 1000) / elapsedMs : null;
        const point: OperationalMetricPoint = {
            ...copyGauges(gauges),
            timestamp: this.now(),
            elapsedMs,
            downloadedBytes: this.traffic.downloadedBytes,
            uploadedBytes: this.traffic.uploadedBytes,
            downloadBytesPerSecond: rate(this.traffic.downloadedBytes, previous?.downloaded ?? 0),
            uploadBytesPerSecond: rate(this.traffic.uploadedBytes, previous?.uploaded ?? 0),
            ipcCallsPerSecond: rate(this.ipcCallCount, previous?.calls ?? 0),
            ipcErrorsPerSecond: rate(this.ipcErrorCount, previous?.errors ?? 0),
            downloadsStarted: this.downloads.started,
            downloadsCompleted: this.downloads.completed,
        };
        this.series.push(point);
        if (this.series.length > 180) this.series.shift();
        this.previousSample = {
            clock,
            downloaded: this.traffic.downloadedBytes,
            uploaded: this.traffic.uploadedBytes,
            calls: this.ipcCallCount,
            errors: this.ipcErrorCount,
        };
    }

    // ── Snapshot ──────────────────────────────────────────────────────────────

    /** Retorna um snapshot imutável das métricas atuais */
    getSnapshot(): MetricsSnapshot {
        const mem = process.memoryUsage();

        const avgLatencyByChannel: Record<string, number> = {};
        for (const [channel, sum] of this.latencySumByChannel.entries()) {
            const count = this.callsByChannel.get(channel) ?? 1;
            avgLatencyByChannel[channel] = Math.round(sum / count);
        }

        return {
            startedAt: this.startedAt,
            uptimeMs: Math.max(0, this.clock() - this.startedClock),
            ipcCallCount: this.ipcCallCount,
            ipcErrorCount: this.ipcErrorCount,
            ipcOutcomes: { ...this.ipcOutcomes },
            outcomesByChannel: Object.fromEntries(
                [...this.outcomesByChannel].map(([channel, outcomes]) => [
                    channel,
                    { ...outcomes },
                ]),
            ),
            errorsByChannel: Object.fromEntries(this.errorsByChannel),
            avgLatencyByChannel,
            callsByChannel: Object.fromEntries(this.callsByChannel),
            latency: {
                ipcByChannel: Object.fromEntries(
                    [...this.ipcLatency].map(([channel, histogram]) => [
                        channel,
                        histogram.snapshot(),
                    ]),
                ),
                queueWaitMs: this.queueWait.snapshot(),
                metadataResolutionMs: {
                    resolved: this.metadata.resolved.snapshot(),
                    failed: this.metadata.failed.snapshot(),
                    cancelled: this.metadata.cancelled.snapshot(),
                },
                metadataPreparationMs: Object.fromEntries(
                    Object.entries(this.preparation).map(([kind, histograms]) => [
                        kind,
                        {
                            resolved: histograms.resolved.snapshot(),
                            failed: histograms.failed.snapshot(),
                            cancelled: histograms.cancelled.snapshot(),
                        },
                    ]),
                ) as MetricsSnapshot['latency']['metadataPreparationMs'],
            },
            traffic: { ...this.traffic },
            downloads: { ...this.downloads },
            errorCauses: {
                ipc: { ...this.errorCauses.ipc },
                engine: { ...this.errorCauses.engine },
                renderer: { ...this.errorCauses.renderer },
                downloads: { ...this.errorCauses.downloads },
            },
            operational: this.series.length
                ? clonePoint(this.series[this.series.length - 1]!)
                : null,
            series: this.series.map(clonePoint),
            collectionErrorCount: this.collectionErrorCount,
            engineErrorCount: this.engineErrorCount,
            rendererCrashCount: this.rendererCrashCount,
            rendererErrorCount: this.rendererErrorCount,
            memoryUsage: {
                heapUsed: mem.heapUsed,
                heapTotal: mem.heapTotal,
                rss: mem.rss,
            },
        };
    }

    // ── Persistência ──────────────────────────────────────────────────────────

    /**
     * Habilita persistência periódica de métricas em disco.
     * Grava um snapshot a cada 5 minutos em formato NDJSON (uma linha JSON por entry).
     * Rotaciona o arquivo quando ultrapassa 1MB.
     *
     * @param logsDir Diretório onde o arquivo `metrics.ndjson` será criado.
     */
    enablePersistence(logsDir: string): void {
        this.disablePersistence();
        this.metricsFilePath = join(logsDir, 'metrics.ndjson');

        this.persistTimer = setInterval(() => {
            this.persistSnapshot();
        }, PERSIST_INTERVAL_MS);
        this.persistTimer.unref();
    }

    disablePersistence(): void {
        if (this.persistTimer) clearInterval(this.persistTimer);
        this.persistTimer = null;
    }

    /**
     * Persiste o snapshot atual em disco. Chamado periodicamente e também
     * pode ser chamado manualmente (ex: antes de um crash).
     */
    persistSnapshot(): void {
        if (!this.metricsFilePath) return;

        try {
            // Rotacionar se necessário
            this._rotateIfNeeded();

            const entry: PersistedMetricsEntry = {
                timestamp: new Date().toISOString(),
                snapshot: this.getSnapshot(),
            };

            const line = JSON.stringify(entry) + '\n';
            writeFileSync(this.metricsFilePath, line, { flag: 'a' });
        } catch {
            // Falha silenciosa — métricas não devem impedir o funcionamento do app
        }
    }

    /**
     * Lê os snapshots persistidos do arquivo de métricas.
     * Retorna array vazio se o arquivo não existir ou estiver corrompido.
     */
    readPersistedSnapshots(): PersistedMetricsEntry[] {
        if (!this.metricsFilePath) return [];

        try {
            const content = readFileSync(this.metricsFilePath, 'utf-8');
            const lines = content
                .trim()
                .split('\n')
                .filter((l) => l.length > 0);
            const entries: PersistedMetricsEntry[] = [];

            for (const line of lines) {
                try {
                    entries.push(JSON.parse(line) as PersistedMetricsEntry);
                } catch {
                    // Linha corrompida — pular
                }
            }

            return entries;
        } catch {
            return [];
        }
    }

    /** Rotaciona o arquivo de métricas se ultrapassar o tamanho máximo */
    private _rotateIfNeeded(): void {
        if (!this.metricsFilePath) return;

        try {
            const stats = statSync(this.metricsFilePath);
            if (stats.size >= MAX_METRICS_FILE_SIZE) {
                const backupPath = this.metricsFilePath + '.old';
                renameSync(this.metricsFilePath, backupPath);
            }
        } catch {
            // Arquivo não existe ainda — ok
        }
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/** Instância global do coletor de métricas */
export function createMetricsCollector(options: { now?: () => number; clock?: () => number } = {}) {
    return new MetricsCollector(options);
}

export const metrics = createMetricsCollector();

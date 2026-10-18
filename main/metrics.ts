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

// ─── Types ────────────────────────────────────────────────────────────────────

/** Snapshot das métricas coletadas */
export interface MetricsSnapshot {
    /** Timestamp de quando o app foi iniciado (ms desde epoch) */
    startedAt: number;
    /** Uptime do app em milissegundos */
    uptimeMs: number;
    /** Total de chamadas IPC processadas */
    ipcCallCount: number;
    /** Total de erros IPC (chamadas que retornaram success: false) */
    ipcErrorCount: number;
    /** Contadores de erro por canal IPC */
    errorsByChannel: Record<string, number>;
    /** Latência média por canal IPC (ms) */
    avgLatencyByChannel: Record<string, number>;
    /** Contadores de chamadas por canal IPC */
    callsByChannel: Record<string, number>;
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
    private readonly startedAt = Date.now();
    private ipcCallCount = 0;
    private ipcErrorCount = 0;
    private engineErrorCount = 0;
    private rendererCrashCount = 0;
    private rendererErrorCount = 0;

    /** Contadores de erro por canal */
    private readonly errorsByChannel = new Map<string, number>();
    /** Soma de latências por canal (para calcular média) */
    private readonly latencySumByChannel = new Map<string, number>();
    /** Contadores de chamadas por canal */
    private readonly callsByChannel = new Map<string, number>();

    /** Caminho do arquivo de métricas (definido via enablePersistence) */
    private metricsFilePath: string | null = null;
    /** Timer de persistência periódica */
    private persistTimer: ReturnType<typeof setInterval> | null = null;

    // ── IPC ───────────────────────────────────────────────────────────────────

    /** Registra uma chamada IPC com sua duração e resultado */
    recordIpcCall(channel: string, durationMs: number, success: boolean): void {
        this.ipcCallCount++;
        this.callsByChannel.set(channel, (this.callsByChannel.get(channel) ?? 0) + 1);
        this.latencySumByChannel.set(
            channel,
            (this.latencySumByChannel.get(channel) ?? 0) + durationMs,
        );

        if (!success) {
            this.ipcErrorCount++;
            this.errorsByChannel.set(channel, (this.errorsByChannel.get(channel) ?? 0) + 1);
        }
    }

    // ── Engine ────────────────────────────────────────────────────────────────

    /** Registra um erro do torrent engine */
    recordEngineError(): void {
        this.engineErrorCount++;
    }

    // ── Renderer ──────────────────────────────────────────────────────────────

    /** Registra um crash do renderer process */
    recordRendererCrash(): void {
        this.rendererCrashCount++;
    }

    /** Registra um erro reportado pelo renderer */
    recordRendererError(): void {
        this.rendererErrorCount++;
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
            uptimeMs: Date.now() - this.startedAt,
            ipcCallCount: this.ipcCallCount,
            ipcErrorCount: this.ipcErrorCount,
            errorsByChannel: Object.fromEntries(this.errorsByChannel),
            avgLatencyByChannel,
            callsByChannel: Object.fromEntries(this.callsByChannel),
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
        this.metricsFilePath = join(logsDir, 'metrics.ndjson');

        this.persistTimer = setInterval(() => {
            this.persistSnapshot();
        }, PERSIST_INTERVAL_MS);
        this.persistTimer.unref();
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
            const lines = content.trim().split('\n').filter((l) => l.length > 0);
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
export const metrics = new MetricsCollector();

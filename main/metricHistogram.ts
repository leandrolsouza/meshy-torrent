/** Faixas fixas em ms; memória constante e nenhuma amostra individual retida. */
const BOUNDS_MS = [
    1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000, 900000, 3600000,
];

export interface HistogramSnapshot {
    count: number;
    sumMs: number;
    minMs: number | null;
    maxMs: number | null;
    /** Percentis aproximados pelo limite superior da faixa; null sem observações. */
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    buckets: { upperBoundMs: number | 'Infinity'; count: number }[];
}

export function createMetricHistogram() {
    const counts = Array<number>(BOUNDS_MS.length + 1).fill(0);
    let count = 0;
    let sumMs = 0;
    let minMs = Infinity;
    let maxMs = 0;
    return {
        observe(durationMs: number): void {
            if (!Number.isFinite(durationMs) || durationMs < 0) return;
            const found = BOUNDS_MS.findIndex((bound) => durationMs <= bound);
            counts[found === -1 ? BOUNDS_MS.length : found]!++;
            count++;
            sumMs += durationMs;
            minMs = Math.min(minMs, durationMs);
            maxMs = Math.max(maxMs, durationMs);
        },
        snapshot(): HistogramSnapshot {
            const percentile = (quantile: number): number | null => {
                if (!count) return null;
                const rank = Math.ceil(count * quantile);
                let accumulated = 0;
                for (let i = 0; i < counts.length; i++) {
                    accumulated += counts[i]!;
                    if (accumulated >= rank) return Math.min(BOUNDS_MS[i] ?? maxMs, maxMs);
                }
                return maxMs;
            };
            let cumulative = 0;
            return {
                count,
                sumMs,
                minMs: count ? minMs : null,
                maxMs: count ? maxMs : null,
                p50Ms: percentile(0.5),
                p95Ms: percentile(0.95),
                p99Ms: percentile(0.99),
                buckets: counts.map((value, index) => {
                    cumulative += value;
                    return { upperBoundMs: BOUNDS_MS[index] ?? 'Infinity', count: cumulative };
                }),
            };
        },
    };
}

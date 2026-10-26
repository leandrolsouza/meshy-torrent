import { createMetricHistogram } from '../../main/metricHistogram';

test('sem observações percentis e extremos são desconhecidos, sem fingir latência zero', () => {
    const snapshot = createMetricHistogram().snapshot();
    expect(snapshot).toMatchObject({
        count: 0,
        sumMs: 0,
        minMs: null,
        maxMs: null,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
    });
    expect(snapshot.buckets.every((bucket) => bucket.count === 0)).toBe(true);
});

test('distribuição cumulativa e percentis detectam cauda lenta que a média esconderia', () => {
    const histogram = createMetricHistogram();
    for (let i = 0; i < 94; i++) histogram.observe(1);
    for (let i = 0; i < 6; i++) histogram.observe(10000);
    const snapshot = histogram.snapshot();
    expect(snapshot).toMatchObject({
        count: 100,
        sumMs: 60094,
        minMs: 1,
        maxMs: 10000,
        p50Ms: 1,
        p95Ms: 10000,
        p99Ms: 10000,
    });
    expect(snapshot.buckets.find((bucket) => bucket.upperBoundMs === 1)!.count).toBe(94);
    expect(snapshot.buckets[snapshot.buckets.length - 1]).toEqual({
        upperBoundMs: 'Infinity',
        count: 100,
    });
});

test('limites incluem a borda, último bucket aceita cauda longa e observações inválidas são ignoradas', () => {
    const histogram = createMetricHistogram();
    for (const value of [0, 5, 6, 7200000, -1, NaN, Infinity]) histogram.observe(value);
    const snapshot = histogram.snapshot();
    expect(snapshot.count).toBe(4);
    expect(snapshot.buckets.find((bucket) => bucket.upperBoundMs === 5)!.count).toBe(2);
    expect(snapshot.p99Ms).toBe(7200000);
    expect(snapshot.maxMs).toBe(7200000);
    expect(JSON.parse(JSON.stringify(snapshot)).buckets.at(-1).count).toBe(4);
});

test('memória independe da quantidade de observações e snapshots não alteram contadores', () => {
    const histogram = createMetricHistogram();
    const size = histogram.snapshot().buckets.length;
    for (let i = 0; i < 10000; i++) histogram.observe(i);
    const saved = histogram.snapshot();
    saved.buckets[0]!.count = -100;
    histogram.observe(10);
    const next = histogram.snapshot();
    expect(next.buckets).toHaveLength(size);
    expect(next.count).toBe(10001);
    expect(next.buckets[0]!.count).toBeGreaterThanOrEqual(0);
    expect(saved.count).toBe(10000);
});

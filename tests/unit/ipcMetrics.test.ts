import { performance } from 'node:perf_hooks';
import type { IPCResponse } from '../../shared/types';
import { metrics } from '../../main/metrics';
import type { IpcOutcome } from '../../main/metrics';
import { markIpcOutcome, withIpcMetrics } from '../../main/ipcMetrics';

const failure = new Error('Falha sintética');
const response: IPCResponse<void> = { success: false, error: 'error.operation.failed' };

test.each<{
    name: string;
    run: () => IPCResponse<void> | Promise<IPCResponse<void>>;
    outcome: IpcOutcome;
    throws?: boolean;
}>([
    {
        name: 'sucesso síncrono',
        run: () => ({ success: true, data: undefined }),
        outcome: 'success',
    },
    {
        name: 'sucesso assíncrono',
        run: async () => ({ success: true, data: undefined }),
        outcome: 'success',
    },
    { name: 'erro retornado', run: () => response, outcome: 'error' },
    {
        name: 'exceção síncrona',
        run: () => {
            throw failure;
        },
        outcome: 'exception',
        throws: true,
    },
    {
        name: 'promise rejeitada',
        run: () => Promise.reject(failure),
        outcome: 'exception',
        throws: true,
    },
])(
    'contabiliza $name exatamente uma vez e preserva o retorno/rejeição',
    async ({ run, outcome, throws }) => {
        const channel = 'test:metrics';
        const before = metrics.getSnapshot();
        const pending = withIpcMetrics(channel, run);
        if (throws) await expect(pending).rejects.toBe(failure);
        else await expect(pending).resolves.toMatchObject({ success: outcome === 'success' });
        const after = metrics.getSnapshot();
        expect(after.ipcCallCount - before.ipcCallCount).toBe(1);
        expect(after.ipcErrorCount - before.ipcErrorCount).toBe(outcome === 'success' ? 0 : 1);
        expect(after.callsByChannel[channel]! - (before.callsByChannel[channel] ?? 0)).toBe(1);
        expect((after.errorsByChannel[channel] ?? 0) - (before.errorsByChannel[channel] ?? 0)).toBe(
            outcome === 'success' ? 0 : 1,
        );
        for (const category of Object.keys(after.ipcOutcomes) as IpcOutcome[]) {
            const expected = category === outcome ? 1 : 0;
            expect(after.ipcOutcomes[category] - before.ipcOutcomes[category]).toBe(expected);
            expect(
                after.outcomesByChannel[channel]![category] -
                    (before.outcomesByChannel[channel]?.[category] ?? 0),
            ).toBe(expected);
        }
        expect(Object.values(after.ipcOutcomes).reduce((sum, count) => sum + count, 0)).toBe(
            after.ipcCallCount,
        );
        expect(after.ipcCallCount - after.ipcOutcomes.success).toBe(after.ipcErrorCount);
    },
);

test('classificações concorrentes e aninhadas não contaminam outra chamada', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const before = metrics.getSnapshot();
    const first = withIpcMetrics('test:concurrent-first', async () => {
        await gate;
        markIpcOutcome('exception');
        return response;
    });
    await withIpcMetrics('test:concurrent-second', async () => {
        markIpcOutcome('rate_limited');
        await Promise.resolve();
        return response;
    });
    release();
    await first;
    await withIpcMetrics('test:parent', async () => {
        await withIpcMetrics('test:child', () => {
            markIpcOutcome('unauthorized');
            return response;
        });
        return { success: true, data: undefined };
    });
    markIpcOutcome('exception');
    await withIpcMetrics('test:after', () => response);
    const after = metrics.getSnapshot();
    expect(after.ipcCallCount - before.ipcCallCount).toBe(5);
    expect(after.outcomesByChannel['test:concurrent-first']!.exception).toBe(1);
    expect(after.outcomesByChannel['test:concurrent-second']!.rate_limited).toBe(1);
    expect(after.outcomesByChannel['test:child']!.unauthorized).toBe(1);
    expect(after.outcomesByChannel['test:parent']!.success).toBe(1);
    expect(after.outcomesByChannel['test:after']!.error).toBe(1);
    for (const category of Object.keys(after.ipcOutcomes) as IpcOutcome[])
        expect(after.ipcOutcomes[category] - before.ipcOutcomes[category]).toBe(1);
});

test('latência usa relógio monotônico mesmo se a data do sistema retroceder', async () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(125);
    const date = jest.spyOn(Date, 'now').mockReturnValue(-1000);
    try {
        await withIpcMetrics('test:clock', async () => {
            return { success: true, data: undefined };
        });
        expect(metrics.getSnapshot().avgLatencyByChannel['test:clock']).toBe(25);
    } finally {
        clock.mockRestore();
        date.mockRestore();
    }
});

test('alterar um snapshot não modifica classificações atuais nem snapshots anteriores', async () => {
    await withIpcMetrics('test:snapshot', () => response);
    const saved = metrics.getSnapshot();
    const modified = metrics.getSnapshot();
    modified.ipcOutcomes.error = -100;
    modified.outcomesByChannel['test:snapshot']!.error = -100;
    expect(metrics.getSnapshot().ipcOutcomes).toEqual(saved.ipcOutcomes);
    expect(metrics.getSnapshot().outcomesByChannel).toEqual(saved.outcomesByChannel);
    await withIpcMetrics('test:snapshot', () => response);
    expect(saved.outcomesByChannel['test:snapshot']!.error).toBe(1);
});

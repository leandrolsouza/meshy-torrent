import { ipcMain } from 'electron';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { metrics } from '../../main/metrics';
import type { IpcOutcome } from '../../main/metrics';
import { isTrustedIpcSender } from '../../main/rendererSecurity';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import type { IPCResponse } from '../../shared/types';
import { ErrorCodes } from '../../shared/errorCodes';

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() } }));
jest.mock('../../main/rendererSecurity', () => ({ isTrustedIpcSender: jest.fn(() => true) }));

const payload = { infoHash: 'a'.repeat(40) };

function setup() {
    const manager = { pause: jest.fn(async () => {}), getAll: jest.fn(() => []) };
    registerIpcHandlers(manager as unknown as DownloadManager, {} as SettingsManager);
    const invoke = (channel: string, data: unknown = payload): Promise<IPCResponse<unknown>> =>
        jest
            .mocked(ipcMain.handle)
            .mock.calls.find(([name]) => name === channel)![1]({} as never, data);
    return { manager, invoke };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isTrustedIpcSender).mockReturnValue(true);
    _rateLimiter.reset();
});

afterEach(() => _rateLimiter.reset());

test.each<{
    scenario: string;
    outcome: IpcOutcome;
    channel: string;
}>([
    { scenario: 'sucesso', outcome: 'success', channel: 'torrent:pause' },
    { scenario: 'payload inválido', outcome: 'error', channel: 'torrent:pause' },
    { scenario: 'exceção síncrona do serviço', outcome: 'exception', channel: 'torrent:get-all' },
    { scenario: 'rejeição assíncrona do serviço', outcome: 'exception', channel: 'torrent:pause' },
    { scenario: 'rate limit', outcome: 'rate_limited', channel: 'torrent:pause' },
    { scenario: 'remetente bloqueado', outcome: 'unauthorized', channel: 'torrent:pause' },
])('IPC registra $scenario sem dupla contagem', async ({ scenario, outcome, channel }) => {
    const { manager, invoke } = setup();
    if (scenario === 'exceção síncrona do serviço')
        manager.getAll.mockImplementationOnce(() => {
            throw new Error('SYNTHETIC_PRIVATE_ERROR');
        });
    if (scenario === 'rejeição assíncrona do serviço')
        manager.pause.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_ERROR'));
    if (outcome === 'rate_limited') for (let i = 0; i < 500; i++) _rateLimiter.tryConsume(channel);
    if (outcome === 'unauthorized') jest.mocked(isTrustedIpcSender).mockReturnValueOnce(false);
    const before = metrics.getSnapshot();
    const response = await invoke(channel, scenario === 'payload inválido' ? {} : payload);
    const after = metrics.getSnapshot();
    expect(response.success).toBe(outcome === 'success');
    if (outcome === 'exception')
        expect(response).toEqual({ success: false, error: ErrorCodes.OPERATION_FAILED });
    if (outcome === 'rate_limited')
        expect(response).toEqual({ success: false, error: ErrorCodes.RATE_LIMITED });
    expect(after.ipcCallCount - before.ipcCallCount).toBe(1);
    expect(after.ipcErrorCount - before.ipcErrorCount).toBe(outcome === 'success' ? 0 : 1);
    expect(after.callsByChannel[channel]! - (before.callsByChannel[channel] ?? 0)).toBe(1);
    for (const category of Object.keys(after.ipcOutcomes) as IpcOutcome[]) {
        const expected = category === outcome ? 1 : 0;
        expect(after.ipcOutcomes[category] - before.ipcOutcomes[category]).toBe(expected);
        expect(
            after.outcomesByChannel[channel]![category] -
                (before.outcomesByChannel[channel]?.[category] ?? 0),
        ).toBe(expected);
    }
    expect(JSON.stringify(after)).not.toContain('SYNTHETIC_PRIVATE_ERROR');
    if (['error', 'rate_limited', 'unauthorized'].includes(outcome))
        expect(manager.pause).not.toHaveBeenCalled();
    if (outcome === 'unauthorized') {
        // Bloqueios entram nas métricas sem consumir a cota do remetente legítimo.
        for (let i = 0; i < 500; i++) expect(_rateLimiter.tryConsume(channel)).toBe(true);
    }
});

test('app:get-metrics expõe as classes e inclui sua própria chamada apenas no snapshot seguinte', async () => {
    const { invoke } = setup();
    await invoke('torrent:pause', {});
    const before = metrics.getSnapshot();
    const response = await invoke('app:get-metrics', undefined);
    expect(response.success).toBe(true);
    if (!response.success) throw new Error('Snapshot indisponível');
    expect(response.data).toMatchObject({
        ipcOutcomes: before.ipcOutcomes,
        outcomesByChannel: before.outcomesByChannel,
        ipcCallCount: before.ipcCallCount,
    });
    const after = metrics.getSnapshot();
    expect(after.ipcCallCount).toBe(before.ipcCallCount + 1);
    expect(after.ipcOutcomes.success).toBe(before.ipcOutcomes.success + 1);
});

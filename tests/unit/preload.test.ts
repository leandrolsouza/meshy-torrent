import { contextBridge, ipcRenderer } from 'electron';
import type { MeshyAPI } from '../../shared/types';
import { MAX_TORRENT_BYTES } from '../../shared/validators';
import { ErrorCodes } from '../../shared/errorCodes';
import { parseTraceContext } from '../../shared/traceContext';

const traceMetadata = expect.objectContaining({
    traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
    spanId: expect.stringMatching(/^[a-f0-9]{16}$/),
});

jest.mock('electron', () => ({
    contextBridge: { exposeInMainWorld: jest.fn() },
    ipcRenderer: {
        invoke: jest.fn(async () => ({ success: true })),
        on: jest.fn(),
        removeListener: jest.fn(),
    },
}));

import '../../electron/preload';

const api = (contextBridge.exposeInMainWorld as jest.Mock).mock.calls[0][1] as MeshyAPI;

test.each([true, false])('transporta o estado de seed desejado enabled=%s', async (enabled) => {
    jest.mocked(ipcRenderer.invoke).mockClear();
    await api.setSeedingEnabled('a'.repeat(40), enabled);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
        'torrent:set-seeding-enabled',
        { infoHash: 'a'.repeat(40), enabled },
        traceMetadata,
    );
});

test('expõe somente a ponte específica, com comandos em canais fixos', async () => {
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('meshy', api);
    for (const key of ['ipcRenderer', 'invoke', 'send', 'require', 'process'])
        expect(Object.prototype.hasOwnProperty.call(api, key)).toBe(false);
    await api.pause('a'.repeat(40));
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
        'torrent:pause',
        { infoHash: 'a'.repeat(40) },
        traceMetadata,
    );
});

test.each([
    ['onProgress', 'torrent:progress'],
    ['onError', 'torrent:error'],
    ['onExternalTorrentRequests', 'app:external-torrents'],
    ['onUpdateStatus', 'app:update-status'],
] as const)('%s entrega apenas payload e remove seu próprio listener', (method, channel) => {
    const callback = jest.fn();
    const cleanup = api[method](callback);
    const listener = (ipcRenderer.on as jest.Mock).mock.calls.find(([name]) => name === channel)[1];
    const payload = { test: true };
    listener({ sender: ipcRenderer }, payload);
    expect(callback).toHaveBeenCalledWith(payload);
    expect(callback.mock.calls[0]).toHaveLength(1);
    cleanup();
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
});

test('rejeita buffers grandes antes de copiá-los pelo IPC nos dois fluxos', async () => {
    jest.mocked(ipcRenderer.invoke).mockClear();
    const buffer = new Uint8Array(MAX_TORRENT_BYTES + 1);
    const error = { success: false, error: ErrorCodes.INVALID_FILE_PATH };
    expect(await api.addTorrentFileBuffer(buffer)).toEqual(error);
    expect(await api.prepareTorrent('request-123', { kind: 'buffer', buffer })).toEqual(error);
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    const valid = new Uint8Array([100, 101]);
    await api.addTorrentFileBuffer(valid);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
        'torrent:add-file-buffer',
        { buffer: valid },
        traceMetadata,
    );
    await api.prepareTorrent('request-123', { kind: 'buffer', buffer: valid });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
        'torrent:prepare',
        {
            requestId: 'request-123',
            source: { kind: 'buffer', buffer: valid },
        },
        traceMetadata,
    );
});

test('chamadas concorrentes têm IDs distintos e reports continuam somente a origem explícita', async () => {
    jest.mocked(ipcRenderer.invoke).mockClear();
    await Promise.all([api.pause('a'.repeat(40)), api.resume('b'.repeat(40))]);
    const first = parseTraceContext(jest.mocked(ipcRenderer.invoke).mock.calls[0]![2])!;
    const second = parseTraceContext(jest.mocked(ipcRenderer.invoke).mock.calls[1]![2])!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.traceId).not.toBe(second.traceId);
    api.reportError({ message: 'Falha tardia', source: 'test', traceContext: first });
    const report = jest.mocked(ipcRenderer.invoke).mock.calls[2]!;
    expect(report[1]).toEqual({ message: 'Falha tardia', source: 'test' });
    expect(report[2]).toMatchObject({ traceId: first.traceId, parentSpanId: first.spanId });
    api.reportError({ message: 'Erro sem origem', source: 'test' });
    const unrelated = parseTraceContext(jest.mocked(ipcRenderer.invoke).mock.calls[3]![2])!;
    expect(unrelated.traceId).not.toBe(first.traceId);
    expect(unrelated.traceId).not.toBe(second.traceId);
});

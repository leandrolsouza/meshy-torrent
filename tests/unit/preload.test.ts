import { contextBridge, ipcRenderer } from 'electron';
import type { MeshyAPI } from '../../shared/types';
import { MAX_TORRENT_BYTES } from '../../shared/validators';
import { ErrorCodes } from '../../shared/errorCodes';

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
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('torrent:set-seeding-enabled', {
        infoHash: 'a'.repeat(40),
        enabled,
    });
});

test('expõe somente a ponte específica, com comandos em canais fixos', async () => {
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('meshy', api);
    for (const key of ['ipcRenderer', 'invoke', 'send', 'require', 'process'])
        expect(Object.prototype.hasOwnProperty.call(api, key)).toBe(false);
    await api.pause('a'.repeat(40));
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('torrent:pause', { infoHash: 'a'.repeat(40) });
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
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('torrent:add-file-buffer', { buffer: valid });
    await api.prepareTorrent('request-123', { kind: 'buffer', buffer: valid });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('torrent:prepare', {
        requestId: 'request-123',
        source: { kind: 'buffer', buffer: valid },
    });
});

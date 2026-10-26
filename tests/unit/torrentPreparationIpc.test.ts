// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

jest.mock('fs/promises', () => ({
    ...jest.requireActual('fs/promises'),
    stat: jest.fn().mockResolvedValue({ isDirectory: () => true } as any),
    access: jest.fn().mockResolvedValue(undefined),
}));

import { ipcMain } from 'electron';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import type { PreparedTorrent, TorrentPreparation } from '../../main/torrentPreparation';
import type { IPCResponse } from '../../shared/types';
jest.mock('electron', () => ({
    ipcMain: { handle: jest.fn() },
    dialog: {},
    shell: {},
    BrowserWindow: {},
}));
const requestId = 'request-123';
const selection = { requestId, destinationFolder: process.cwd(), selectedIndices: [0] };
const draft: PreparedTorrent = {
    buffer: Buffer.from('de'),
    magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    preview: {
        requestId,
        infoHash: 'a'.repeat(40),
        name: 'Archive',
        files: [
            { index: 0, name: 'a.bin', path: 'a.bin', length: 100, downloaded: 0, selected: true },
        ],
    },
};
const event = { sender: { id: 1 } } as Electron.IpcMainInvokeEvent;
function setup() {
    jest.clearAllMocks();
    _rateLimiter.reset();
    const drafts = new Map<string, PreparedTorrent>();
    const preparation = {
        prepare: jest.fn(async (id: string) => {
            drafts.set(id, draft);
            return { ...draft.preview, requestId: id };
        }),
        get: jest.fn((id: string) => {
            const value = drafts.get(id);
            if (!value) throw new Error('error.torrent.preparationExpired');
            return value;
        }),
        cancel: jest.fn((id: string) => {
            drafts.delete(id);
        }),
        dispose: jest.fn(),
    } satisfies TorrentPreparation;
    const manager = {
        getAll: jest.fn(() => []),
        addPreparedTorrent: jest.fn(async () => ({ infoHash: 'a'.repeat(40) })),
        getDiskSpace: jest.fn(async () => ({ sufficient: true, selectedBytes: 100 })),
    };
    registerIpcHandlers(
        manager as unknown as DownloadManager,
        {} as SettingsManager,
        undefined,
        preparation,
    );
    const handler = (name: string) =>
        (ipcMain.handle as jest.Mock).mock.calls.find(
            (call: unknown[]) => call[0] === name,
        )![1] as (
            event: Electron.IpcMainInvokeEvent,
            payload: unknown,
        ) => Promise<IPCResponse<unknown>>;
    const prepare = () =>
        handler('torrent:prepare')(event, {
            requestId,
            source: { kind: 'buffer', buffer: new Uint8Array([100, 101]) },
        });
    return { manager, preparation, handler, prepare };
}
test('preparação não adiciona o download; confirmação usa somente os metadados mantidos no main', async () => {
    const { manager, handler, prepare, preparation } = setup();
    expect(await prepare()).toMatchObject({ success: true, data: { requestId } });
    expect(manager.addPreparedTorrent).not.toHaveBeenCalled();
    expect(await handler('torrent:disk-space')(event, selection)).toMatchObject({ success: true });
    expect(manager.getDiskSpace).toHaveBeenCalledWith(process.cwd(), 100, draft.preview.infoHash);
    expect(await handler('torrent:confirm')(event, selection)).toMatchObject({ success: true });
    expect(manager.addPreparedTorrent).toHaveBeenCalledWith(draft, process.cwd(), [0]);
    expect(preparation.cancel).toHaveBeenCalledWith('1-request-123');
});
test('rejeita fontes, índices e IDs inválidos sem transferir conteúdo', async () => {
    const { manager, handler, prepare } = setup();
    expect(
        await handler('torrent:prepare')(event, {
            requestId,
            source: { kind: 'file', filePath: 42 },
        }),
    ).toMatchObject({ success: false });
    await prepare();
    for (const selectedIndices of [[-1], [1], ['0'], [0.5], null])
        expect(
            await handler('torrent:confirm')(event, { ...selection, selectedIndices }),
        ).toMatchObject({ success: false });
    expect(
        await handler('torrent:confirm')(event, { ...selection, selectedIndices: [] }),
    ).toMatchObject({ success: false, error: 'error.files.selectionEmpty' });
    expect(manager.addPreparedTorrent).not.toHaveBeenCalled();
});
test('outro renderer não pode consultar nem confirmar o rascunho e cancelar invalida a revisão', async () => {
    const { handler, prepare, manager } = setup();
    await prepare();
    const other = { sender: { id: 2 } } as Electron.IpcMainInvokeEvent;
    expect(await handler('torrent:confirm')(other, selection)).toMatchObject({
        success: false,
        error: 'error.torrent.preparationExpired',
    });
    await handler('torrent:cancel-preparation')(event, { requestId });
    expect(await handler('torrent:confirm')(event, selection)).toMatchObject({ success: false });
    expect(manager.addPreparedTorrent).not.toHaveBeenCalled();
});
test('cliques duplicados mantêm o bloqueio da primeira confirmação até ela terminar', async () => {
    const { handler, prepare, manager } = setup();
    await prepare();
    let finish!: (value: { infoHash: string }) => void;
    manager.addPreparedTorrent.mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const first = handler('torrent:confirm')(event, selection);
    expect(await handler('torrent:confirm')(event, selection)).toMatchObject({ success: false });
    expect(await handler('torrent:confirm')(event, selection)).toMatchObject({ success: false });
    expect(manager.addPreparedTorrent).toHaveBeenCalledTimes(1);
    finish({ infoHash: 'a'.repeat(40) });
    expect(await first).toMatchObject({ success: true });
});

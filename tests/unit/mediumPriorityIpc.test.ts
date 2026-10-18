// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

import { ipcMain, dialog } from 'electron';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { createDefaultBandwidthSettings } from '../../shared/bandwidth';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import type { TorrentEngine } from '../../main/torrentEngine';
import type { AppSettings, DownloadItem } from '../../shared/types';

jest.mock('electron', () => ({
    ipcMain: { handle: jest.fn() },
    dialog: { showOpenDialog: jest.fn() },
    shell: {},
    BrowserWindow: {},
}));
function setup() {
    jest.clearAllMocks();
    _rateLimiter.reset();
    let config = {
        downloadSpeedLimit: 0,
        uploadSpeedLimit: 0,
        dhtEnabled: true,
        pexEnabled: true,
        utpEnabled: true,
        bandwidth: createDefaultBandwidthSettings(),
    } as AppSettings;
    const settings = {
        get: () => config,
        set: jest.fn((partial: Partial<AppSettings>) => {
            config = { ...config, ...partial };
        }),
    };
    const engine = {
        on: jest.fn(),
        isRestarting: () => false,
        setDownloadSpeedLimit: jest.fn(),
        setUploadSpeedLimit: jest.fn(),
    };
    const manager = {
        getAll: jest.fn(
            () => [{ infoHash: 'a'.repeat(40), name: 'A', status: 'paused' }] as DownloadItem[],
        ),
        pause: jest.fn(async () => {}),
        resume: jest.fn(async () => {}),
        remove: jest.fn(async () => {}),
        persistSession: jest.fn(),
    };
    registerIpcHandlers(
        manager as unknown as DownloadManager,
        settings as unknown as SettingsManager,
        engine as unknown as TorrentEngine,
    );
    const handler = (channel: string) =>
        (ipcMain.handle as jest.Mock).mock.calls.find(([name]) => name === channel)![1] as (
            _event: unknown,
            payload?: unknown,
        ) => Promise<{ success: boolean; error?: string; data?: unknown }>;
    return { handler, manager, settings, engine };
}
test('limites salvos são aplicados imediatamente; modo manual restaura os normais', async () => {
    const { handler, engine, settings } = setup();
    expect(
        await handler('settings:set')(null, { downloadSpeedLimit: 256, uploadSpeedLimit: 64 }),
    ).toMatchObject({ success: true });
    expect(engine.setDownloadSpeedLimit).toHaveBeenLastCalledWith(256);
    expect(engine.setUploadSpeedLimit).toHaveBeenLastCalledWith(64);
    expect(await handler('bandwidth:set-light')(null, { enabled: true })).toMatchObject({
        success: true,
        data: { mode: 'manual', downloadLimit: 128, uploadLimit: 32 },
    });
    expect(settings.get().downloadSpeedLimit).toBe(256);
    expect(engine.setDownloadSpeedLimit).toHaveBeenLastCalledWith(128);
    await handler('bandwidth:set-light')(null, { enabled: false });
    expect(engine.setDownloadSpeedLimit).toHaveBeenLastCalledWith(256);
});
test('bandwidth rejeita tipo inválido e horários inválidos antes de persistir', async () => {
    const { handler, settings } = setup();
    expect(await handler('bandwidth:set-light')(null, { enabled: 'yes' })).toMatchObject({
        success: false,
    });
    expect(
        await handler('settings:set')(null, {
            bandwidth: { ...createDefaultBandwidthSettings(), days: [] },
        }),
    ).toMatchObject({ success: false });
    expect(settings.set).not.toHaveBeenCalled();
});
test('lote rejeita payload completo inválido antes de tocar qualquer torrent', async () => {
    const { handler, manager } = setup();
    for (const payload of [
        null,
        {},
        { infoHashes: ['bad'], operation: 'pause' },
        { infoHashes: ['a'.repeat(40)], operation: 'remove' },
        { infoHashes: ['a'.repeat(40), 'a'.repeat(40)], operation: 'resume' },
        { infoHashes: ['a'.repeat(40)], operation: 'delete' },
        { infoHashes: Array(201).fill('a'.repeat(40)), operation: 'pause' },
    ]) {
        expect(await handler('torrent:batch-action')(null, payload)).toMatchObject({
            success: false,
        });
    }
    expect(manager.pause).not.toHaveBeenCalled();
    expect(manager.remove).not.toHaveBeenCalled();
    expect(
        await handler('torrent:batch-action')(null, {
            infoHashes: ['a'.repeat(40)],
            operation: 'resume',
        }),
    ).toMatchObject({ success: true, data: [{ name: 'A', success: true }] });
});
test('remoção em lote não exclui arquivos sem escolha explícita', async () => {
    const { handler, manager } = setup();
    await handler('torrent:batch-action')(null, {
        infoHashes: ['a'.repeat(40)],
        operation: 'remove',
        deleteFiles: false,
    });
    expect(manager.remove).toHaveBeenCalledWith('a'.repeat(40), false);
});
test('seletor nativo permite múltiplos arquivos; cancelar mantém resposta de cancelamento', async () => {
    const { handler } = setup();
    (dialog.showOpenDialog as jest.Mock).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/a.torrent', '/b.torrent'],
    });
    expect(await handler('dialog:select-torrent-files')(null)).toMatchObject({
        success: true,
        data: ['/a.torrent', '/b.torrent'],
    });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ properties: ['openFile', 'multiSelections'] }),
    );
    (dialog.showOpenDialog as jest.Mock).mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await handler('dialog:select-torrent-files')(null)).toMatchObject({
        success: false,
        error: 'error.files.noFileSelected',
    });
});

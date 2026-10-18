// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

import { ipcMain } from 'electron';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { createExternalTorrentInbox } from '../../main/externalTorrents';
import { validateSettingsPayload } from '../../main/settingsValidator';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import type { TorrentEngine } from '../../main/torrentEngine';
import type { DownloadItem } from '../../shared/types';
jest.mock('electron', () => ({
    ipcMain: { handle: jest.fn() },
    dialog: {},
    shell: {},
    BrowserWindow: {},
}));
function setup() {
    jest.clearAllMocks();
    _rateLimiter.reset();
    const manager = {
        getAll: jest.fn((): DownloadItem[] => []),
        manageFiles: jest.fn(async () => ({ status: 'paused' })),
        getFiles: jest.fn(() => []),
    };
    const inbox = createExternalTorrentInbox(jest.fn());
    const registerMagnetHandler = jest.fn(async () => ({
        isDefault: false,
        canOpenDefaultApps: true,
        applicationName: 'Meshy (Dev)',
    }));
    const getMagnetHandlerStatus = jest.fn(async () => ({
        isDefault: true,
        canOpenDefaultApps: true,
        applicationName: 'Meshy (Dev)',
    }));
    const openMagnetDefaultApps = jest.fn(async () => {});
    const settings = {
        get: jest.fn(() => ({ dhtEnabled: true, pexEnabled: true, utpEnabled: true })),
        set: jest.fn(),
    };
    const engine = { isRestarting: jest.fn(() => false), restart: jest.fn(), on: jest.fn() };
    registerIpcHandlers(
        manager as unknown as DownloadManager,
        settings as unknown as SettingsManager,
        engine as unknown as TorrentEngine,
        undefined,
        { inbox, registerMagnetHandler, getMagnetHandlerStatus, openMagnetDefaultApps },
    );
    const handler = (name: string) =>
        (ipcMain.handle as jest.Mock).mock.calls.find(([channel]) => channel === name)![1] as (
            _event: unknown,
            payload?: unknown,
        ) => Promise<{ success: boolean; error?: string; data?: unknown }>;
    return {
        manager,
        settings,
        engine,
        inbox,
        registerMagnetHandler,
        getMagnetHandlerStatus,
        openMagnetDefaultApps,
        handler,
    };
}
test('operações de arquivos validam hash, modo e destino antes de chamar o manager', async () => {
    const { manager, handler } = setup();
    const manage = handler('torrent:manage-files');
    for (const payload of [
        null,
        {},
        { infoHash: 'bad', operation: 'verify' },
        { infoHash: 'a'.repeat(40), operation: 'delete' },
        { infoHash: 'a'.repeat(40), operation: 'move', destinationFolder: '' },
    ])
        expect(await manage(null, payload)).toMatchObject({ success: false });
    expect(manager.manageFiles).not.toHaveBeenCalled();
    expect(await manage(null, { infoHash: 'a'.repeat(40), operation: 'verify' })).toMatchObject({
        success: true,
    });
    expect(manager.manageFiles).toHaveBeenCalledWith('a'.repeat(40), 'verify', undefined);
});
test('entradas externas não são consumidas por leitura e só saem mediante acknowledgement', async () => {
    const { inbox, handler } = setup();
    inbox.enqueueArguments([`magnet:?xt=urn:btih:${'a'.repeat(40)}`]);
    const pending = inbox.getPending();
    expect(await handler('app:get-external-torrents')(null)).toMatchObject({
        success: true,
        data: pending,
    });
    expect(inbox.getPending()).toEqual(pending);
    expect(await handler('app:acknowledge-external-torrent')(null, { id: 123 })).toMatchObject({
        success: false,
    });
    await handler('app:acknowledge-external-torrent')(null, { id: pending[0]!.id });
    expect(inbox.getPending()).toEqual([]);
});
test('falha ao registrar protocolo retorna erro e não apresenta sucesso', async () => {
    const { handler, registerMagnetHandler } = setup();
    registerMagnetHandler.mockRejectedValueOnce(new Error('error.system.protocolRegistration'));
    expect(await handler('app:register-magnet-handler')(null)).toMatchObject({
        success: false,
        error: 'error.system.protocolRegistration',
    });
});
test('preferência de bandeja aceita apenas booleano', () => {
    expect(validateSettingsPayload({ closeToTray: true })).toBeNull();
    expect(
        validateSettingsPayload({ closeToTray: 'yes' } as unknown as Parameters<
            typeof validateSettingsPayload
        >[0]),
    ).toBe('error.params.invalid');
});

test('IPC distingue registro de padrão e abre apenas as configurações de associação', async () => {
    const { handler, openMagnetDefaultApps } = setup();
    expect(await handler('app:register-magnet-handler')(null)).toMatchObject({
        success: true,
        data: { isDefault: false, canOpenDefaultApps: true },
    });
    expect(await handler('app:get-magnet-handler-status')(null)).toMatchObject({
        success: true,
        data: { isDefault: true },
    });
    expect(await handler('app:open-magnet-default-apps')(null)).toMatchObject({ success: true });
    expect(openMagnetDefaultApps).toHaveBeenCalledTimes(1);
});

test('mudança de rede não interrompe arquivos em recuperação nem persiste antes de rejeitar', async () => {
    const { manager, settings, engine, handler } = setup();
    manager.getAll.mockReturnValue([
        { infoHash: 'a'.repeat(40), fileOperation: 'move' } as DownloadItem,
    ]);
    expect(await handler('settings:set')(null, { dhtEnabled: false })).toMatchObject({
        success: false,
        error: 'error.files.busy',
    });
    expect(settings.set).not.toHaveBeenCalled();
    expect(engine.restart).not.toHaveBeenCalled();
    expect(await handler('settings:set')(null, { closeToTray: true })).toMatchObject({
        success: true,
    });
    expect(settings.set).toHaveBeenCalledWith({ closeToTray: true });
});

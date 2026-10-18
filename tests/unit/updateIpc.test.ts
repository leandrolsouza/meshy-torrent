import { ipcMain } from 'electron';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { isTrustedIpcSender } from '../../main/rendererSecurity';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import type { AppUpdateStatus, IPCResponse } from '../../shared/types';
import { ErrorCodes } from '../../shared/errorCodes';
import type { ExternalTorrentInbox } from '../../main/externalTorrents';

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() }, dialog: {}, shell: {} }));
jest.mock('../../main/rendererSecurity', () => ({ isTrustedIpcSender: jest.fn(() => true) }));

const channels = ['app:update-status', 'app:check-updates', 'app:install-update'] as const;
function setup() {
    const status: AppUpdateStatus = { revision: 0, currentVersion: '0.1.0-beta.1', phase: 'idle' };
    const updates = {
        getStatus: jest.fn(() => status),
        check: jest.fn(() => status),
        install: jest.fn(async () => status),
        start: jest.fn(),
        dispose: jest.fn(),
    };
    const association = async () => ({
        isDefault: false,
        canOpenDefaultApps: false,
        applicationName: '',
    });
    const desktop = {
        updates,
        inbox: {} as ExternalTorrentInbox,
        registerMagnetHandler: association,
        getMagnetHandlerStatus: association,
        openMagnetDefaultApps: async () => {},
    };
    registerIpcHandlers(
        {} as DownloadManager,
        {} as SettingsManager,
        undefined,
        undefined,
        desktop,
    );
    const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>(
        jest.mocked(ipcMain.handle).mock.calls.map(([channel, handler]) => [channel, handler]),
    );
    const invoke = (channel: string, payload?: unknown) =>
        handlers.get(channel)!({} as Electron.IpcMainInvokeEvent, payload) as Promise<
            IPCResponse<unknown>
        >;
    return { updates, invoke, status };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(isTrustedIpcSender).mockReturnValue(true);
    _rateLimiter.reset();
});

test('encaminha comandos específicos e devolve snapshots serializáveis', async () => {
    const { updates, invoke, status } = setup();
    for (const channel of channels)
        expect(await invoke(channel)).toEqual({ success: true, data: status });
    expect(updates.check).toHaveBeenCalledTimes(1);
    expect(updates.install).toHaveBeenCalledTimes(1);
});

test('rejeita argumentos arbitrários sem consultar ou instalar atualizações', async () => {
    const { updates, invoke } = setup();
    for (const channel of channels)
        expect(await invoke(channel, { url: 'https://example.com/installer.exe' })).toEqual({
            success: false,
            error: ErrorCodes.INVALID_PARAMS,
        });
    expect(updates.getStatus).not.toHaveBeenCalled();
    expect(updates.check).not.toHaveBeenCalled();
    expect(updates.install).not.toHaveBeenCalled();
});

test('rejeita remetentes não autorizados antes de verificar ou instalar', async () => {
    const { updates, invoke } = setup();
    jest.mocked(isTrustedIpcSender).mockReturnValue(false);
    for (const channel of channels) expect((await invoke(channel)).success).toBe(false);
    expect(updates.getStatus).not.toHaveBeenCalled();
    expect(updates.check).not.toHaveBeenCalled();
    expect(updates.install).not.toHaveBeenCalled();
});

test('preserva erro conhecido de persistência e não expõe detalhes internos', async () => {
    const { updates, invoke } = setup();
    updates.install.mockRejectedValueOnce(new Error(ErrorCodes.UPDATE_SESSION_FAILED));
    expect(await invoke('app:install-update')).toEqual({
        success: false,
        error: ErrorCodes.UPDATE_SESSION_FAILED,
    });
    updates.install.mockRejectedValueOnce(new Error('caminho privado'));
    expect(await invoke('app:install-update')).toEqual({
        success: false,
        error: ErrorCodes.OPERATION_FAILED,
    });
});

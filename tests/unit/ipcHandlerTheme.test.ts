// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Teste de propriedade para validação de tema inválido no handler IPC `settings:set`.
 *
 * Feature: theme-switcher, Property 5: Validação rejeita tema inválido no IPC
 *
 * **Valida: Requisito 5.3**
 */

import fc from 'fast-check';
import { registerIpcHandlers } from '../../main/ipcHandler';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import type { AppSettings, IPCResponse } from '../../shared/types';

// ─── Mock electron ────────────────────────────────────────────────────────────

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
    },
    dialog: {
        showOpenDialog: jest.fn(),
    },
}));

const { ipcMain: mockIpcMain } = require('electron') as {
    ipcMain: { handle: jest.Mock };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDownloadManager(): DownloadManager {
    return {
        addTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn(),
        addMagnetLink: jest.fn(),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        getAll: jest.fn().mockReturnValue([]),
        restoreSession: jest.fn().mockResolvedValue(undefined),
        persistSession: jest.fn(),
        setMaxConcurrentDownloads: jest.fn(),
        on: jest.fn(),
    } as unknown as DownloadManager;
}

function makeMockSettingsManager(): SettingsManager {
    const settings: AppSettings = {
        destinationFolder: '/downloads',
        downloadSpeedLimit: 0,
        uploadSpeedLimit: 0,
        maxConcurrentDownloads: 3,
        notificationsEnabled: true,
        theme: 'vs-code-dark',
        locale: 'pt-BR',
        globalTrackers: [],
        autoApplyGlobalTrackers: false,
        dhtEnabled: true,
        pexEnabled: true,
        utpEnabled: true,

        closeToTray: false,
    };
    return {
        get: jest.fn().mockReturnValue(settings),
        set: jest.fn(),
        getDefaultDownloadFolder: jest.fn().mockReturnValue('/downloads'),
    } as unknown as SettingsManager;
}

/**
 * Extrai a função handler registrada para um canal IPC específico.
 */
function getHandler(
    channel: string,
): ((_event: unknown, payload?: unknown) => Promise<unknown>) | undefined {
    const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    return call ? (call[1] as (_event: unknown, payload?: unknown) => Promise<unknown>) : undefined;
}

// ─── Teste de Propriedade ─────────────────────────────────────────────────────

describe('Feature: theme-switcher, Property 5: Validação rejeita tema inválido no IPC', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        const downloadManager = makeMockDownloadManager();
        const settingsManager = makeMockSettingsManager();
        registerIpcHandlers(downloadManager, settingsManager);
    });

    // Propriedade 5: Para todo valor explicitamente inválido (string vazia, null, número),
    // o handler `settings:set` deve retornar `{ success: false }`.
    // Nota: `undefined` significa "não alterar o campo" em Partial<AppSettings>,
    // portanto é tratado como ausência do campo e não como valor inválido.
    it('settings:set retorna { success: false } para qualquer valor de tema inválido', async () => {
        const handler = getHandler('settings:set')!;
        expect(handler).toBeDefined();

        await fc.assert(
            fc.asyncProperty(
                fc.oneof(fc.constant(''), fc.constant(null), fc.integer()),
                async (invalidTheme) => {
                    const response = (await handler(null, {
                        theme: invalidTheme,
                    })) as IPCResponse<AppSettings>;

                    expect(response.success).toBe(false);
                    expect(response).toHaveProperty('error');
                    expect(typeof (response as { error: string }).error).toBe('string');
                },
            ),
            { numRuns: 100 },
        );
    });

    // Caso complementar: `undefined` significa "não alterar o campo theme",
    // portanto o handler deve aceitar o payload normalmente.
    it('settings:set aceita { theme: undefined } como ausência de alteração', async () => {
        const handler = getHandler('settings:set')!;
        expect(handler).toBeDefined();

        const response = (await handler(null, { theme: undefined })) as IPCResponse<AppSettings>;
        expect(response.success).toBe(true);
    });
});

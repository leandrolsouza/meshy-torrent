// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Testes de integração para validação de payload IPC (Tarefas 6.1 e 6.2).
 *
 * Verifica que os handlers corrigidos rejeitam corretamente:
 * - Payloads sem campos obrigatórios (validação via validatePayload — Tarefa 6.1)
 * - filePath sem extensão .torrent (validação de caminho — Tarefa 6.2)
 * - destinationFolder inexistente ou sem permissão de escrita (Tarefa 6.2)
 *
 * **Validates: Requirements 4.1, 4.2, 4.6**
 */

import { registerIpcHandlers } from '../../main/ipcHandler';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../main/settingsManager';
import type { DownloadItem, IPCResponse } from '../../shared/types';
import { ErrorCodes } from '../../shared/errorCodes';

// ─── Mock electron ────────────────────────────────────────────────────────────

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
    },
    dialog: {
        showOpenDialog: jest.fn(),
    },
    shell: {
        openPath: jest.fn(),
        showItemInFolder: jest.fn(),
    },
}));

// ─── Mock fs ──────────────────────────────────────────────────────────────────

// Por padrão: todos os diretórios existem e têm permissão de escrita.
// Cada teste que precisar de comportamento diferente sobrescreve com mockReturnValueOnce
// ou mockImplementationOnce.
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn().mockReturnValue(true),
    accessSync: jest.fn(), // não lança = tem permissão W_OK
}));

const mockFs = require('fs') as {
    existsSync: jest.Mock;
    accessSync: jest.Mock;
};

const { ipcMain: mockIpcMain } = require('electron') as {
    ipcMain: { handle: jest.Mock };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSampleDownloadItem(): DownloadItem {
    return {
        infoHash: 'a'.repeat(40),
        name: 'Test Torrent',
        totalSize: 1_000_000,
        downloadedSize: 500_000,
        progress: 0.5,
        downloadSpeed: 100_000,
        uploadSpeed: 50_000,
        numPeers: 5,
        numSeeders: 3,
        timeRemaining: 60_000,
        status: 'downloading',
        destinationFolder: '/downloads',
        addedAt: Date.now(),
    };
}

function makeMockDownloadManager(): DownloadManager {
    const item = makeSampleDownloadItem();
    return {
        addTorrentFile: jest.fn().mockResolvedValue(item),
        addTorrentBuffer: jest.fn().mockResolvedValue(item),
        addMagnetLink: jest.fn().mockResolvedValue(item),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        getAll: jest.fn().mockReturnValue([item]),
        restoreSession: jest.fn().mockResolvedValue(undefined),
        persistSession: jest.fn(),
        setMaxConcurrentDownloads: jest.fn(),
        on: jest.fn(),
        reorderQueue: jest.fn().mockReturnValue([]),
        getQueueOrder: jest.fn().mockReturnValue([]),
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
        getGlobalTrackers: jest.fn().mockReturnValue([]),
        addGlobalTracker: jest.fn(),
        removeGlobalTracker: jest.fn(),
        setAutoApplyGlobalTrackers: jest.fn(),
    } as unknown as SettingsManager;
}

function makeMockTorrentEngine() {
    return {
        getTrackers: jest.fn().mockReturnValue([]),
        addTracker: jest.fn(),
        removeTracker: jest.fn(),
        getFiles: jest.fn().mockReturnValue([]),
        setFileSelection: jest.fn().mockReturnValue([]),
        restart: jest.fn().mockResolvedValue(undefined),
        isRestarting: jest.fn().mockReturnValue(false),
        healthCheck: jest.fn().mockReturnValue({
            healthy: true,
            restarting: false,
            activeTorrents: 0,
            totalPeers: 0,
            uptimeMs: 0,
        }),
        getMetadata: jest.fn().mockReturnValue({
            infoHash: 'a'.repeat(40),
            creator: null,
            comment: null,
            creationDate: null,
        }),
        getPeers: jest.fn().mockReturnValue([]),
        getPieces: jest.fn().mockReturnValue([]),
        on: jest.fn(),
        removeListener: jest.fn(),
    };
}

/** Extrai a função de handler registrada para um canal IPC. */
function getHandler(
    channel: string,
): ((_event: unknown, payload?: unknown) => Promise<unknown>) | undefined {
    const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    return call ? (call[1] as (_event: unknown, payload?: unknown) => Promise<unknown>) : undefined;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Integration: Validação de Payload IPC (Requirements 4.1, 4.2, 4.6)', () => {
    let downloadManager: DownloadManager;
    let settingsManager: SettingsManager;
    let torrentEngine: ReturnType<typeof makeMockTorrentEngine>;

    beforeEach(() => {
        jest.clearAllMocks();
        // Resetar fs mocks para o padrão: tudo existe e é gravável
        mockFs.existsSync.mockReturnValue(true);
        mockFs.accessSync.mockReturnValue(undefined);

        downloadManager = makeMockDownloadManager();
        settingsManager = makeMockSettingsManager();
        torrentEngine = makeMockTorrentEngine();
        registerIpcHandlers(downloadManager, settingsManager, torrentEngine as any);
    });

    // ── torrent:add-file: validação de extensão de filePath (Tarefa 6.2) ──────

    describe('torrent:add-file — filePath sem extensão .torrent (Req 4.2)', () => {
        /** Asserta que um filePath é rejeitado com response de erro estruturado. */
        async function expectFilepathRejected(filePath: string): Promise<void> {
            const handler = getHandler('torrent:add-file')!;
            const response = (await handler(null, { filePath })) as {
                success: boolean;
                error?: string;
            };
            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
            expect(response.error!.length).toBeGreaterThan(0);
            expect(downloadManager.addTorrentFile).not.toHaveBeenCalled();
        }

        it('rejeita filePath com extensão .zip', async () => {
            await expectFilepathRejected('/downloads/archive.zip');
        });

        it('rejeita filePath com extensão .rar', async () => {
            await expectFilepathRejected('/downloads/archive.rar');
        });

        it('rejeita filePath com extensão .mp4', async () => {
            await expectFilepathRejected('/downloads/video.mp4');
        });

        it('rejeita filePath sem extensão', async () => {
            await expectFilepathRejected('/downloads/noextension');
        });

        it('rejeita filePath com extensão .torrentx (.torrent como substring)', async () => {
            await expectFilepathRejected('/downloads/file.torrentx');
        });

        it('retorna ErrorCodes.INVALID_FILE_PATH para extensão incorreta', async () => {
            const handler = getHandler('torrent:add-file')!;
            const response = (await handler(null, { filePath: '/downloads/file.zip' })) as {
                success: boolean;
                error?: string;
            };
            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
        });

        it('aceita filePath com extensão .torrent minúscula', async () => {
            const handler = getHandler('torrent:add-file')!;
            const response = (await handler(null, {
                filePath: '/downloads/valid.torrent',
            })) as IPCResponse<DownloadItem>;
            expect(response.success).toBe(true);
            expect(downloadManager.addTorrentFile).toHaveBeenCalled();
        });

        it('aceita filePath com extensão .TORRENT maiúscula (case-insensitive)', async () => {
            const handler = getHandler('torrent:add-file')!;
            const response = (await handler(null, {
                filePath: '/downloads/VALID.TORRENT',
            })) as IPCResponse<DownloadItem>;
            expect(response.success).toBe(true);
        });
    });

    // ── torrent:add-file: campo obrigatório ausente (Tarefa 6.1) ─────────────

    describe('torrent:add-file — campo obrigatório filePath ausente (Req 4.1)', () => {
        it('rejeita payload sem campo filePath', async () => {
            const handler = getHandler('torrent:add-file')!;
            const response = (await handler(null, { otherField: '/file.torrent' })) as {
                success: boolean;
                error?: string;
            };
            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('rejeita objeto vazio (filePath ausente)', async () => {
            const handler = getHandler('torrent:add-file')!;
            const response = (await handler(null, {})) as { success: boolean };
            expect(response.success).toBe(false);
        });

        it('não chama downloadManager.addTorrentFile quando filePath está ausente', async () => {
            const handler = getHandler('torrent:add-file')!;
            await handler(null, {});
            expect(downloadManager.addTorrentFile).not.toHaveBeenCalled();
        });
    });

    // ── settings:set: validação de destinationFolder (Tarefa 6.2) ────────────

    describe('settings:set — destinationFolder inexistente (Req 4.2)', () => {
        it('rejeita destinationFolder quando o diretório não existe', async () => {
            mockFs.existsSync.mockReturnValue(false);

            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                destinationFolder: '/nonexistent/path',
            })) as { success: boolean; error?: string };

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
            expect(response.error!.length).toBeGreaterThan(0);
        });

        it('não persiste as configurações quando destinationFolder não existe', async () => {
            mockFs.existsSync.mockReturnValue(false);

            const handler = getHandler('settings:set')!;
            await handler(null, { destinationFolder: '/nonexistent/path' });

            expect(settingsManager.set).not.toHaveBeenCalled();
        });

        it('retorna ErrorCodes.INVALID_PARAMS para destinationFolder inexistente', async () => {
            mockFs.existsSync.mockReturnValue(false);

            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                destinationFolder: '/nonexistent/path',
            })) as { success: boolean; error?: string };

            expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
        });

        it('rejeita destinationFolder quando diretório existe mas sem permissão de escrita', async () => {
            mockFs.existsSync.mockReturnValue(true);
            mockFs.accessSync.mockImplementationOnce(() => {
                throw new Error("EACCES: permission denied, access '/readonly/path'");
            });

            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                destinationFolder: '/readonly/path',
            })) as { success: boolean; error?: string };

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('não persiste as configurações quando destinationFolder não tem permissão de escrita', async () => {
            mockFs.existsSync.mockReturnValue(true);
            mockFs.accessSync.mockImplementationOnce(() => {
                throw new Error('EACCES: permission denied');
            });

            const handler = getHandler('settings:set')!;
            await handler(null, { destinationFolder: '/readonly/path' });

            expect(settingsManager.set).not.toHaveBeenCalled();
        });

        it('aceita destinationFolder quando diretório existe e tem permissão de escrita', async () => {
            mockFs.existsSync.mockReturnValue(true);
            mockFs.accessSync.mockReturnValue(undefined); // sem lançamento = tem permissão

            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                destinationFolder: '/valid/writable/path',
            })) as { success: boolean };

            expect(response.success).toBe(true);
            expect(settingsManager.set).toHaveBeenCalled();
        });
    });

    // ── settings:set: campo obrigatório ausente / estrutura inválida (6.1) ────

    describe('settings:set — payload inválido (Req 4.1)', () => {
        it('rejeita payload null', async () => {
            const handler = getHandler('settings:set')!;
            const response = (await handler(null, null)) as {
                success: boolean;
                error?: string;
            };
            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('rejeita payload numérico', async () => {
            const handler = getHandler('settings:set')!;
            const response = (await handler(null, 42)) as { success: boolean };
            expect(response.success).toBe(false);
        });

        it('rejeita payload string', async () => {
            const handler = getHandler('settings:set')!;
            const response = (await handler(null, 'settings-string')) as { success: boolean };
            expect(response.success).toBe(false);
        });

        it('não chama settingsManager.set quando payload é inválido', async () => {
            const handler = getHandler('settings:set')!;
            await handler(null, null);
            expect(settingsManager.set).not.toHaveBeenCalled();
        });

        it('aceita objeto vazio (atualização parcial sem alterações)', async () => {
            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {})) as { success: boolean };
            expect(response.success).toBe(true);
        });
    });
});

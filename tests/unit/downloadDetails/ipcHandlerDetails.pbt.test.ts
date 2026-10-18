// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Testes de propriedade (PBT) para os handlers IPC do painel de detalhes.
 *
 * Propriedades testadas:
 *   - Property 13: IPC handlers reject unknown infoHash
 *
 * Usa fast-check 4 com mínimo de 100 iterações por propriedade.
 */

import * as fc from 'fast-check';
import { registerIpcHandlers, _rateLimiter } from '../../../main/ipcHandler';
import { ErrorCodes } from '../../../shared/errorCodes';
import type { DownloadManager } from '../../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../../main/settingsManager';

// ─── Mock electron ────────────────────────────────────────────────────────────

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
    },
    dialog: {
        showOpenDialog: jest.fn(),
    },
    BrowserWindow: jest.fn().mockImplementation(() => ({
        webContents: { send: jest.fn() },
        isDestroyed: jest.fn().mockReturnValue(false),
        on: jest.fn(),
    })),
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
        reorderQueue: jest.fn().mockReturnValue([]),
        getQueueOrder: jest.fn().mockReturnValue([]),
        on: jest.fn(),
    } as unknown as DownloadManager;
}

function makeMockSettingsManager(): SettingsManager {
    return {
        get: jest.fn().mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 3,
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            theme: 'vs-code-dark',
            locale: 'pt-BR',
            globalTrackers: [],
            autoApplyGlobalTrackers: false,
            dhtEnabled: true,
            pexEnabled: true,
            utpEnabled: true,

            closeToTray: false,
        } as AppSettings),
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
        getMetadata: jest.fn(),
        getPeers: jest.fn(),
        getPieces: jest.fn(),
        isRestarting: jest.fn().mockReturnValue(false),
        on: jest.fn(),
        removeListener: jest.fn(),
    };
}

function getHandler(
    channel: string,
): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
    const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    return call ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>) : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Property 13: IPC handlers reject unknown infoHash
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature: download-details-panel, Property 13: Unknown infoHash', () => {
    /**
     * Property 13: IPC handlers reject unknown infoHash
     *
     * Para qualquer string de 40 caracteres hexadecimais que não está presente
     * no conjunto de torrents gerenciados pelo DownloadManager, chamar
     * torrent:get-metadata, torrent:get-peers e torrent:get-pieces com esse
     * infoHash SHALL retornar { success: false, error } contendo o código de
     * erro TORRENT_NOT_FOUND.
     *
     * **Validates: Requirements 7.4**
     */

    let downloadManager: DownloadManager;

    beforeEach(() => {
        jest.clearAllMocks();
        _rateLimiter.reset();

        downloadManager = makeMockDownloadManager();
        const settingsManager = makeMockSettingsManager();
        const torrentEngine = makeMockTorrentEngine();

        // DownloadManager retorna lista vazia — qualquer infoHash será desconhecido
        (downloadManager.getAll as jest.Mock).mockReturnValue([]);

        registerIpcHandlers(downloadManager, settingsManager, torrentEngine as any);
    });

    const DETAIL_CHANNELS = [
        'torrent:get-metadata',
        'torrent:get-peers',
        'torrent:get-pieces',
    ] as const;

    it('todos os 3 handlers retornam { success: false } para qualquer infoHash de 40 hex chars não gerenciado', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                }),
                async (unknownInfoHash) => {
                    for (const channel of DETAIL_CHANNELS) {
                        const handler = getHandler(channel);
                        expect(handler).toBeDefined();

                        const response = (await handler!(null, {
                            infoHash: unknownInfoHash,
                        })) as {
                            success: boolean;
                            error?: string;
                        };

                        expect(response.success).toBe(false);
                        expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });

    it('get-metadata retorna TORRENT_NOT_FOUND para infoHash desconhecido', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                }),
                async (unknownInfoHash) => {
                    const handler = getHandler('torrent:get-metadata');
                    const response = (await handler!(null, {
                        infoHash: unknownInfoHash,
                    })) as {
                        success: boolean;
                        error?: string;
                    };

                    expect(response.success).toBe(false);
                    expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('get-peers retorna TORRENT_NOT_FOUND para infoHash desconhecido', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                }),
                async (unknownInfoHash) => {
                    const handler = getHandler('torrent:get-peers');
                    const response = (await handler!(null, {
                        infoHash: unknownInfoHash,
                    })) as {
                        success: boolean;
                        error?: string;
                    };

                    expect(response.success).toBe(false);
                    expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('get-pieces retorna TORRENT_NOT_FOUND para infoHash desconhecido', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                }),
                async (unknownInfoHash) => {
                    const handler = getHandler('torrent:get-pieces');
                    const response = (await handler!(null, {
                        infoHash: unknownInfoHash,
                    })) as {
                        success: boolean;
                        error?: string;
                    };

                    expect(response.success).toBe(false);
                    expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
                },
            ),
            { numRuns: 100 },
        );
    });
});

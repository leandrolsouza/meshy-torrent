// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Testes unitários para os handlers IPC de detalhes do download.
 *
 * Cobre:
 *   - Requirement 7.1: Canal torrent:get-metadata retorna TorrentMetadata
 *   - Requirement 7.2: Canal torrent:get-peers retorna PeerInfo[]
 *   - Requirement 7.3: Canal torrent:get-pieces retorna PieceStatus
 *   - Requirement 7.4: infoHash desconhecido retorna TORRENT_NOT_FOUND
 *   - Requirement 7.5: Engine indisponível/reiniciando retorna erro sem exceção
 *   - Requirement 7.6: Torrent em resolving-metadata retorna dados parciais
 */

import { registerIpcHandlers, _rateLimiter } from '../../../main/ipcHandler';
import { ErrorCodes } from '../../../shared/errorCodes';
import type { DownloadManager } from '../../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../../main/settingsManager';
import type { TorrentEngine } from '../../../main/torrentEngine';
import type { DownloadItem, TorrentMetadata, PeerInfo, PieceStatus } from '../../../shared/types';

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

const VALID_INFO_HASH = 'a'.repeat(40);

function makeMockDownloadManager(items: Partial<DownloadItem>[] = []): DownloadManager {
    return {
        addTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn(),
        addMagnetLink: jest.fn(),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        getAll: jest.fn().mockReturnValue(items),
        restoreSession: jest.fn().mockResolvedValue(undefined),
        persistSession: jest.fn(),
        setMaxConcurrentDownloads: jest.fn(),
        reorderQueue: jest.fn().mockReturnValue([]),
        getQueueOrder: jest.fn().mockReturnValue([]),
        getCachedMetadata: jest.fn().mockReturnValue(undefined),
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

function makeMockTorrentEngine(overrides: Partial<TorrentEngine> = {}): TorrentEngine {
    return {
        getTrackers: jest.fn().mockReturnValue([]),
        addTracker: jest.fn(),
        removeTracker: jest.fn(),
        getFiles: jest.fn().mockReturnValue([]),
        setFileSelection: jest.fn().mockReturnValue([]),
        isRestarting: jest.fn().mockReturnValue(false),
        getMetadata: jest.fn().mockReturnValue({
            infoHash: VALID_INFO_HASH,
            creator: 'TestCreator',
            comment: 'Test comment',
            creationDate: 1700000000000,
        } as TorrentMetadata),
        getPeers: jest.fn().mockReturnValue([
            {
                address: '192.168.1.1:6881',
                client: 'qBittorrent/4.5.0',
                downloadSpeed: 102400,
                progress: 0.75,
            },
        ] as PeerInfo[]),
        getPieces: jest.fn().mockReturnValue([true, true, false, true, false] as PieceStatus),
        on: jest.fn(),
        removeListener: jest.fn(),
        ...overrides,
    } as unknown as TorrentEngine;
}

function makeDownloadItem(overrides: Partial<DownloadItem> = {}): Partial<DownloadItem> {
    return {
        infoHash: VALID_INFO_HASH,
        status: 'downloading',
        name: 'Test Torrent',
        ...overrides,
    };
}

/**
 * Extrai o handler registrado para um canal IPC específico.
 */
function getHandler(
    channel: string,
): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
    const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    return call ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>) : undefined;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

afterEach(() => {
    _rateLimiter.reset();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IPC Detail Handlers — torrent:get-metadata', () => {
    describe('payload válido retorna dados com sucesso (Requirement 7.1)', () => {
        it('retorna metadados completos do torrent', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual({
                infoHash: VALID_INFO_HASH,
                creator: 'TestCreator',
                comment: 'Test comment',
                creationDate: 1700000000000,
            });
            expect(torrentEngine.getMetadata).toHaveBeenCalledWith(VALID_INFO_HASH);
        });
    });

    describe('torrent não encontrado (Requirement 7.4)', () => {
        it('retorna erro TORRENT_NOT_FOUND para infoHash desconhecido', async () => {
            jest.clearAllMocks();
            const downloadManager = makeMockDownloadManager([]); // nenhum item
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
        });
    });

    describe('engine indisponível (Requirement 7.5)', () => {
        it('retorna erro ENGINE_NOT_AVAILABLE quando torrentEngine é undefined', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const settingsManager = makeMockSettingsManager();

            // Registra sem torrentEngine (undefined)
            registerIpcHandlers(downloadManager, settingsManager, undefined);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
        });
    });

    describe('engine em reinício (Requirement 7.5)', () => {
        it('retorna erro ENGINE_RESTARTING quando engine está reiniciando', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const torrentEngine = makeMockTorrentEngine({
                isRestarting: jest.fn().mockReturnValue(true),
            } as any);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
        });
    });

    describe('torrent em resolving-metadata (Requirement 7.6)', () => {
        it('retorna metadados normalmente (get-metadata não tem tratamento especial para resolving-metadata)', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem({ status: 'resolving-metadata' });
            const downloadManager = makeMockDownloadManager([item]);
            const metadataWithNulls: TorrentMetadata = {
                infoHash: VALID_INFO_HASH,
                creator: null,
                comment: null,
                creationDate: null,
            };
            const torrentEngine = makeMockTorrentEngine({
                getMetadata: jest.fn().mockReturnValue(metadataWithNulls),
            } as any);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(metadataWithNulls);
        });
    });

    describe('usa cache quando engine lança (torrent completed após restart)', () => {
        it('usa cache quando engine.getMetadata lança (torrent completed após restart)', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem({ status: 'completed' });
            const cachedMeta: TorrentMetadata = {
                infoHash: VALID_INFO_HASH,
                creator: 'CachedCreator',
                comment: 'Cached comment',
                creationDate: 1700000000000,
            };
            const downloadManager = makeMockDownloadManager([item]);
            (downloadManager.getCachedMetadata as jest.Mock).mockReturnValue(cachedMeta);
            const torrentEngine = makeMockTorrentEngine({
                getMetadata: jest.fn().mockImplementation(() => {
                    throw new Error('Torrent not in engine');
                }),
            } as any);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(cachedMeta);
            expect(downloadManager.getCachedMetadata).toHaveBeenCalledWith(VALID_INFO_HASH);
        });

        it('retorna erro quando engine lança e cache está vazio', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem({ status: 'completed' });
            const downloadManager = makeMockDownloadManager([item]);
            (downloadManager.getCachedMetadata as jest.Mock).mockReturnValue(undefined);
            const torrentEngine = makeMockTorrentEngine({
                getMetadata: jest.fn().mockImplementation(() => {
                    throw new Error('Torrent not in engine');
                }),
            } as any);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
        });
    });

    describe('payload inválido (Requirement 7.11)', () => {
        it('retorna erro INVALID_PARAMS para payload null', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, null)) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
        });

        it('retorna erro INVALID_PARAMS para infoHash vazio', async () => {
            jest.clearAllMocks();
            const downloadManager = makeMockDownloadManager([makeDownloadItem()]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-metadata')!;
            const response = (await handler(null, { infoHash: '' })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
        });
    });
});

describe('IPC Detail Handlers — torrent:get-peers', () => {
    describe('payload válido retorna dados com sucesso (Requirement 7.2)', () => {
        it('retorna lista de peers do torrent', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const expectedPeers: PeerInfo[] = [
                {
                    address: '192.168.1.1:6881',
                    client: 'qBittorrent/4.5.0',
                    downloadSpeed: 102400,
                    progress: 0.75,
                },
            ];
            const torrentEngine = makeMockTorrentEngine({
                getPeers: jest.fn().mockReturnValue(expectedPeers),
            } as any);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-peers')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(expectedPeers);
            expect(torrentEngine.getPeers).toHaveBeenCalledWith(VALID_INFO_HASH);
        });
    });

    describe('torrent não encontrado (Requirement 7.4)', () => {
        it('retorna erro TORRENT_NOT_FOUND para infoHash desconhecido', async () => {
            jest.clearAllMocks();
            const downloadManager = makeMockDownloadManager([]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-peers')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
        });
    });

    describe('engine indisponível (Requirement 7.5)', () => {
        it('retorna erro ENGINE_NOT_AVAILABLE quando torrentEngine é undefined', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, undefined);

            const handler = getHandler('torrent:get-peers')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
        });
    });

    describe('engine em reinício (Requirement 7.5)', () => {
        it('retorna erro ENGINE_RESTARTING quando engine está reiniciando', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const torrentEngine = makeMockTorrentEngine({
                isRestarting: jest.fn().mockReturnValue(true),
            } as any);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-peers')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
        });
    });

    describe('torrent em resolving-metadata retorna dados parciais (Requirement 7.6)', () => {
        it('retorna array vazio de peers quando torrent está em resolving-metadata', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem({ status: 'resolving-metadata' });
            const downloadManager = makeMockDownloadManager([item]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-peers')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual([]);
            // Não deve chamar getPeers no engine
            expect(torrentEngine.getPeers).not.toHaveBeenCalled();
        });
    });

    describe('payload inválido (Requirement 7.11)', () => {
        it('retorna erro INVALID_PARAMS para payload null', async () => {
            jest.clearAllMocks();
            const downloadManager = makeMockDownloadManager([makeDownloadItem()]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-peers')!;
            const response = (await handler(null, null)) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
        });
    });
});

describe('IPC Detail Handlers — torrent:get-pieces', () => {
    describe('payload válido retorna dados com sucesso (Requirement 7.3)', () => {
        it('retorna status das peças do torrent', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const expectedPieces: PieceStatus = [true, true, false, true, false];
            const torrentEngine = makeMockTorrentEngine({
                getPieces: jest.fn().mockReturnValue(expectedPieces),
            } as any);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-pieces')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(expectedPieces);
            expect(torrentEngine.getPieces).toHaveBeenCalledWith(VALID_INFO_HASH);
        });
    });

    describe('torrent não encontrado (Requirement 7.4)', () => {
        it('retorna erro TORRENT_NOT_FOUND para infoHash desconhecido', async () => {
            jest.clearAllMocks();
            const downloadManager = makeMockDownloadManager([]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-pieces')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
        });
    });

    describe('engine indisponível (Requirement 7.5)', () => {
        it('retorna erro ENGINE_NOT_AVAILABLE quando torrentEngine é undefined', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, undefined);

            const handler = getHandler('torrent:get-pieces')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
        });
    });

    describe('engine em reinício (Requirement 7.5)', () => {
        it('retorna erro ENGINE_RESTARTING quando engine está reiniciando', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem();
            const downloadManager = makeMockDownloadManager([item]);
            const torrentEngine = makeMockTorrentEngine({
                isRestarting: jest.fn().mockReturnValue(true),
            } as any);
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-pieces')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
        });
    });

    describe('torrent em resolving-metadata retorna dados parciais (Requirement 7.6)', () => {
        it('retorna array vazio de peças quando torrent está em resolving-metadata', async () => {
            jest.clearAllMocks();
            const item = makeDownloadItem({ status: 'resolving-metadata' });
            const downloadManager = makeMockDownloadManager([item]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-pieces')!;
            const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual([]);
            // Não deve chamar getPieces no engine
            expect(torrentEngine.getPieces).not.toHaveBeenCalled();
        });
    });

    describe('payload inválido (Requirement 7.11)', () => {
        it('retorna erro INVALID_PARAMS para payload null', async () => {
            jest.clearAllMocks();
            const downloadManager = makeMockDownloadManager([makeDownloadItem()]);
            const torrentEngine = makeMockTorrentEngine();
            const settingsManager = makeMockSettingsManager();

            registerIpcHandlers(downloadManager, settingsManager, torrentEngine);

            const handler = getHandler('torrent:get-pieces')!;
            const response = (await handler(null, null)) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
        });
    });
});

// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Testes unitários para os handlers IPC `torrent:open-folder` e `torrent:open-file`.
 *
 * Cobre:
 *   - Requisitos 1.1–1.5: Abrir pasta de destino via IPC
 *   - Requisitos 2.1–2.6: Abrir arquivo de destino via IPC
 *   - Requisitos 3.1–3.4: Validação e segurança dos canais IPC
 */

import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { ErrorCodes } from '../../shared/errorCodes';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../main/settingsManager';
import type { DownloadItem, TorrentFileInfo } from '../../shared/types';

// ─── Mock electron ────────────────────────────────────────────────────────────

const mockShellOpenPath = jest.fn<Promise<string>, [string]>();

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
    },
    dialog: {
        showOpenDialog: jest.fn(),
    },
    shell: {
        showItemInFolder: jest.fn(),
        openPath: (...args: unknown[]) => mockShellOpenPath(...(args as [string])),
    },
    BrowserWindow: jest.fn().mockImplementation(() => ({
        webContents: { send: jest.fn() },
        isDestroyed: jest.fn().mockReturnValue(false),
        on: jest.fn(),
    })),
}));

// ─── Mock fs (existsSync) ─────────────────────────────────────────────────────

const mockExistsSync = jest.fn<boolean, [string]>();

jest.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...(args as [string])),
    accessSync: jest.fn(),
    statSync: jest.fn(() => ({ isDirectory: () => true })),
    readFileSync: jest.fn(),
    constants: { W_OK: 2 },
}));

// Retrieve mocked ipcMain
const { ipcMain: mockIpcMain } = require('electron') as {
    ipcMain: { handle: jest.Mock };
};

// O filesystem destes handlers é virtual; contenção/symlinks têm testes próprios.
jest.mock('fs/promises', () => ({
    realpath: jest.fn(async (folder: string) => require('path').resolve(folder)),
    lstat: jest.fn(async () => ({ isSymbolicLink: () => false })),
    access: jest.fn(async () => undefined),
    stat: jest.fn(async (path: string) => {
        if (!jest.requireMock('fs').existsSync(path))
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isDirectory: () => true };
    }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_INFO_HASH = 'a'.repeat(40);
const DESTINATION_FOLDER = '/downloads/my-torrent';

function makeDownloadItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
    return {
        infoHash: VALID_INFO_HASH,
        name: 'My Torrent',
        totalSize: 1024,
        downloadedSize: 1024,
        progress: 1,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: 0,
        status: 'completed',
        destinationFolder: DESTINATION_FOLDER,
        addedAt: Date.now(),
        completedAt: Date.now(),
        selectedFileCount: 1,
        totalFileCount: 1,
        ...overrides,
    };
}

function makeFileInfo(overrides: Partial<TorrentFileInfo> = {}): TorrentFileInfo {
    return {
        index: 0,
        name: 'video.mp4',
        path: 'My Torrent/video.mp4',
        length: 1024,
        downloaded: 1024,
        selected: true,
        ...overrides,
    };
}

function makeMockDownloadManager(items: DownloadItem[] = []): DownloadManager {
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

function makeMockTorrentEngine(files: TorrentFileInfo[] = [], isRestarting = false) {
    return {
        getTrackers: jest.fn().mockReturnValue([]),
        addTracker: jest.fn(),
        removeTracker: jest.fn(),
        getFiles: jest.fn().mockReturnValue(files),
        setFileSelection: jest.fn().mockReturnValue([]),
        isRestarting: jest.fn().mockReturnValue(isRestarting),
        on: jest.fn(),
        removeListener: jest.fn(),
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

// ─── Testes ───────────────────────────────────────────────────────────────────

afterEach(() => {
    _rateLimiter.reset();
});

// ═══════════════════════════════════════════════════════════════════════════════
// torrent:open-folder
// ═══════════════════════════════════════════════════════════════════════════════

describe('torrent:open-folder', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ── Sucesso (happy path) ──────────────────────────────────────────────────

    it('abre a pasta de destino com sucesso e retorna success: true', async () => {
        const item = makeDownloadItem();
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        mockExistsSync.mockReturnValue(true);
        mockShellOpenPath.mockResolvedValue('');

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-folder')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(true);
        expect(mockShellOpenPath).toHaveBeenCalledWith(DESTINATION_FOLDER);
    });

    // ── Torrent não encontrado ────────────────────────────────────────────────

    it('retorna TORRENT_NOT_FOUND quando infoHash não corresponde a nenhum item', async () => {
        const dm = makeMockDownloadManager([]); // lista vazia
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-folder')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
    });

    // ── Pasta não existe no filesystem ────────────────────────────────────────

    it('retorna DESTINATION_FOLDER_NOT_FOUND quando a pasta não existe', async () => {
        const item = makeDownloadItem();
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        mockExistsSync.mockReturnValue(false);

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-folder')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.DESTINATION_FOLDER_NOT_FOUND);
        expect(mockShellOpenPath).not.toHaveBeenCalled();
    });

    // ── Shell retorna erro ────────────────────────────────────────────────────

    it('retorna DESTINATION_OPEN_FAILED quando shell.openPath retorna erro', async () => {
        const item = makeDownloadItem();
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        mockExistsSync.mockReturnValue(true);
        mockShellOpenPath.mockResolvedValue('Failed to open directory');

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-folder')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.DESTINATION_OPEN_FAILED);
    });

    // ── Payload inválido ──────────────────────────────────────────────────────

    it('retorna INVALID_PARAMS quando payload é null', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-folder')!;
        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando payload não tem infoHash', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-folder')!;
        const response = (await handler(null, {})) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando infoHash é string vazia', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-folder')!;
        const response = (await handler(null, { infoHash: '' })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando infoHash é número', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-folder')!;
        const response = (await handler(null, { infoHash: 12345 })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// torrent:open-file
// ═══════════════════════════════════════════════════════════════════════════════

describe('torrent:open-file', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ── Sucesso (happy path) ──────────────────────────────────────────────────

    it('abre o arquivo com sucesso e retorna success: true', async () => {
        const item = makeDownloadItem({ status: 'completed' });
        const file = makeFileInfo({ path: 'My Torrent/video.mp4', selected: true });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine([file]);

        mockExistsSync.mockReturnValue(true);
        mockShellOpenPath.mockResolvedValue('');

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(true);

        // Verifica que shell.openPath foi chamado com path.join(destinationFolder, file.path)
        const expectedPath = require('path').resolve(DESTINATION_FOLDER, 'My Torrent/video.mp4');
        expect(mockShellOpenPath).toHaveBeenCalledWith(expectedPath);
    });

    // ── Torrent não encontrado ────────────────────────────────────────────────

    it('retorna TORRENT_NOT_FOUND quando infoHash não corresponde a nenhum item', async () => {
        const dm = makeMockDownloadManager([]); // lista vazia
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
    });

    // ── Status não concluído → DESTINATION_NOT_COMPLETED ──────────────────────

    it('retorna DESTINATION_NOT_COMPLETED quando status é downloading', async () => {
        const item = makeDownloadItem({ status: 'downloading' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.DESTINATION_NOT_COMPLETED);
    });

    it('retorna DESTINATION_NOT_COMPLETED quando status é paused', async () => {
        const item = makeDownloadItem({ status: 'paused' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.DESTINATION_NOT_COMPLETED);
    });

    // ── Engine reiniciando → ENGINE_RESTARTING ────────────────────────────────

    it('retorna ENGINE_RESTARTING quando torrentEngine está reiniciando', async () => {
        const item = makeDownloadItem({ status: 'completed' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine([], true); // isRestarting = true

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
    });

    // ── Nenhum arquivo selecionado encontrado ─────────────────────────────────

    it('retorna DESTINATION_FILE_NOT_FOUND quando nenhum arquivo está selecionado', async () => {
        const item = makeDownloadItem({ status: 'completed' });
        const file = makeFileInfo({ selected: false }); // nenhum selecionado
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine([file]);

        mockExistsSync.mockReturnValue(true);

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.DESTINATION_FILE_NOT_FOUND);
    });

    it('retorna DESTINATION_FILE_NOT_FOUND quando lista de arquivos está vazia', async () => {
        const item = makeDownloadItem({ status: 'completed' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine([]); // sem arquivos

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.DESTINATION_FILE_NOT_FOUND);
    });

    // ── Arquivo não existe no filesystem ──────────────────────────────────────

    it('retorna DESTINATION_FILE_NOT_FOUND quando o arquivo não existe no disco', async () => {
        const item = makeDownloadItem({ status: 'completed' });
        const file = makeFileInfo({ selected: true });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine([file]);

        mockExistsSync.mockReturnValue(false);

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.DESTINATION_FILE_NOT_FOUND);
    });

    // ── Shell retorna erro ────────────────────────────────────────────────────

    it('retorna DESTINATION_OPEN_FAILED quando shell.openPath retorna erro', async () => {
        const item = makeDownloadItem({ status: 'completed' });
        const file = makeFileInfo({ selected: true });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine([file]);

        mockExistsSync.mockReturnValue(true);
        mockShellOpenPath.mockResolvedValue('No application found to open file');

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: VALID_INFO_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.DESTINATION_OPEN_FAILED);
    });

    // ── Payload inválido ──────────────────────────────────────────────────────

    it('retorna INVALID_PARAMS quando payload é null', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando payload não tem infoHash', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, {})) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando infoHash é string vazia', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: '' })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando infoHash é número', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:open-file')!;
        const response = (await handler(null, { infoHash: 42 })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });
});

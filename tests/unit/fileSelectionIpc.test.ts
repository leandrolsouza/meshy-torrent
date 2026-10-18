// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Unit tests for file selection IPC handlers.
 *
 * Covers:
 *   - torrent:get-files — success, torrent not found, resolving-metadata, invalid payload
 *   - torrent:set-file-selection — success, torrent not found, empty array, invalid index, invalid payload
 */

import { registerIpcHandlers } from '../../main/ipcHandler';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../main/settingsManager';
import type { TorrentEngine } from '../../main/torrentEngine';
import type { DownloadItem, TorrentFileInfo } from '../../shared/types';

import { ErrorCodes } from '../../shared/errorCodes';

// ─── Mock electron ────────────────────────────────────────────────────────────

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
    },
    dialog: {
        showOpenDialog: jest.fn(),
    },
    BrowserWindow: jest.fn(),
}));

const { ipcMain: mockIpcMain } = require('electron') as {
    ipcMain: { handle: jest.Mock };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDownloadManager(items: DownloadItem[] = []): DownloadManager {
    return {
        addTorrentFile: jest.fn(),
        addMagnetLink: jest.fn(),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        getAll: jest.fn().mockReturnValue(items),
        restoreSession: jest.fn().mockResolvedValue(undefined),
        persistSession: jest.fn(),
        on: jest.fn(),
    } as unknown as DownloadManager;
}

function makeMockSettingsManager(): SettingsManager {
    return {
        get: jest.fn().mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
        } as AppSettings),
        set: jest.fn(),
        getDefaultDownloadFolder: jest.fn().mockReturnValue('/downloads'),
    } as unknown as SettingsManager;
}

const SAMPLE_FILES: TorrentFileInfo[] = [
    {
        index: 0,
        name: 'video.mp4',
        path: 'Movie/video.mp4',
        length: 1000000,
        downloaded: 500000,
        selected: true,
    },
    {
        index: 1,
        name: 'subs.srt',
        path: 'Movie/subs.srt',
        length: 50000,
        downloaded: 50000,
        selected: true,
    },
    {
        index: 2,
        name: 'readme.txt',
        path: 'Movie/readme.txt',
        length: 1000,
        downloaded: 0,
        selected: false,
    },
];

function makeMockTorrentEngine(files: TorrentFileInfo[] = SAMPLE_FILES): TorrentEngine {
    return {
        addTorrentFile: jest.fn(),
        addMagnetLink: jest.fn(),
        pause: jest.fn(),
        resume: jest.fn(),
        remove: jest.fn(),
        setDownloadSpeedLimit: jest.fn(),
        setUploadSpeedLimit: jest.fn(),
        getAll: jest.fn().mockReturnValue([]),
        getFiles: jest.fn().mockReturnValue(files),
        setFileSelection: jest.fn().mockReturnValue(files),
        on: jest.fn(),
        removeListener: jest.fn(),
    } as unknown as TorrentEngine;
}

function makeDownloadItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
    return {
        infoHash: 'abc123',
        name: 'Test Torrent',
        totalSize: 1051000,
        downloadedSize: 550000,
        progress: 0.52,
        downloadSpeed: 100000,
        uploadSpeed: 50000,
        numPeers: 5,
        numSeeders: 3,
        timeRemaining: 5000,
        status: 'downloading',
        destinationFolder: '/downloads',
        addedAt: Date.now(),
        ...overrides,
    };
}

/**
 * Helper: extract the handler function registered for a given channel.
 */
function getHandler(
    channel: string,
): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
    const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    return call ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>) : undefined;
}

// ─── Tests: torrent:get-files ─────────────────────────────────────────────────

describe('torrent:get-files handler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns file list for a valid torrent', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123', status: 'downloading' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:get-files');
        expect(handler).toBeDefined();

        const response = (await handler!(null, { infoHash: 'abc123' })) as {
            success: boolean;
            data?: TorrentFileInfo[];
            error?: string;
        };

        expect(response.success).toBe(true);
        expect(response.data).toEqual(SAMPLE_FILES);
        expect(engine.getFiles as jest.Mock).toHaveBeenCalledWith('abc123');
    });

    it('returns error when torrent is not found', async () => {
        const dm = makeMockDownloadManager([]); // no items
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:get-files');
        const response = (await handler!(null, { infoHash: 'nonexistent' })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
    });

    it('returns empty array when torrent is in resolving-metadata state', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123', status: 'resolving-metadata' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:get-files');
        const response = (await handler!(null, { infoHash: 'abc123' })) as {
            success: boolean;
            data?: TorrentFileInfo[];
        };

        expect(response.success).toBe(true);
        expect(response.data).toEqual([]);
        expect(engine.getFiles as jest.Mock).not.toHaveBeenCalled();
    });

    it('returns error for null payload', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:get-files');
        const response = (await handler!(null, null)) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('returns error for empty infoHash', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:get-files');
        const response = (await handler!(null, { infoHash: '' })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('returns error for non-string infoHash', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:get-files');
        const response = (await handler!(null, { infoHash: 123 })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });
});

// ─── Tests: torrent:set-file-selection ────────────────────────────────────────

describe('torrent:set-file-selection handler', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns updated file list on successful selection', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123', status: 'downloading' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const updatedFiles = SAMPLE_FILES.map((f) => ({ ...f, selected: f.index === 0 }));
        const engine = makeMockTorrentEngine();
        (engine.setFileSelection as jest.Mock).mockReturnValue(updatedFiles);

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        expect(handler).toBeDefined();

        const response = (await handler!(null, { infoHash: 'abc123', selectedIndices: [0] })) as {
            success: boolean;
            data?: TorrentFileInfo[];
        };

        expect(response.success).toBe(true);
        expect(response.data).toEqual(updatedFiles);
        expect(engine.setFileSelection as jest.Mock).toHaveBeenCalledWith('abc123', [0]);
    });

    it('returns error when torrent is not found', async () => {
        const dm = makeMockDownloadManager([]); // no items
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, {
            infoHash: 'nonexistent',
            selectedIndices: [0],
        })) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
    });

    it('returns error when selectedIndices is empty', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, { infoHash: 'abc123', selectedIndices: [] })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.FILE_SELECTION_EMPTY);
    });

    it('returns error when selectedIndices contains negative number', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, { infoHash: 'abc123', selectedIndices: [-1] })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.FILE_INDEX_INVALID);
    });

    it('returns error when selectedIndices contains non-integer', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, { infoHash: 'abc123', selectedIndices: [1.5] })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.FILE_INDEX_INVALID);
    });

    it('returns error when index is out of range', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        // Engine has 3 files (indices 0, 1, 2)
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, { infoHash: 'abc123', selectedIndices: [5] })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.FILE_INDEX_INVALID);
    });

    it('returns error for null payload', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, null)) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('returns error for empty infoHash', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, { infoHash: '', selectedIndices: [0] })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('returns error when selectedIndices is not an array', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, {
            infoHash: 'abc123',
            selectedIndices: 'not-array',
        })) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.FILE_SELECTION_EMPTY);
    });

    it('returns error when selectedIndices contains non-number', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        const engine = makeMockTorrentEngine();

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, { infoHash: 'abc123', selectedIndices: ['a'] })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.FILE_INDEX_INVALID);
    });
});

// ─── Tests: torrent:set-file-selection com totalFiles === 0 (Tarefa 6.1) ─────

describe('torrent:set-file-selection — rejeição quando torrent não possui arquivos (totalFiles === 0)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('retorna FILE_INDEX_INVALID quando o torrent ainda não possui arquivos (lista vazia)', async () => {
        const item = makeDownloadItem({ infoHash: 'abc123', status: 'downloading' });
        const dm = makeMockDownloadManager([item]);
        const sm = makeMockSettingsManager();
        // Engine retorna lista vazia de arquivos — torrent sem metadados completos
        const engine = makeMockTorrentEngine([]);

        registerIpcHandlers(dm, sm, engine);

        const handler = getHandler('torrent:set-file-selection');
        const response = (await handler!(null, {
            infoHash: 'abc123',
            selectedIndices: [0],
        })) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.FILE_INDEX_INVALID);
        // Garante que setFileSelection não foi chamado com dados inválidos
        expect(engine.setFileSelection as jest.Mock).not.toHaveBeenCalled();
    });
});

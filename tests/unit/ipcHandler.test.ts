// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Example-based tests for IPC Handler.
 *
 * Covers:
 *   - Requirement 8.1: All expected IPC channels are registered (smoke test)
 *   - Requirement 8.4: nodeIntegration: false and contextIsolation: true in BrowserWindow config
 *   - Requirement 8.5: Invalid payload returns structured error { success: false, error: string }
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { ErrorCodes } from '../../shared/errorCodes';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../main/settingsManager';
import type { DownloadItem } from '../../shared/types';

// ─── Mock electron ────────────────────────────────────────────────────────────
// jest.mock is hoisted before variable declarations, so we must define mocks
// inside the factory using jest.fn() and retrieve them via require() afterwards.

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

// Retrieve the mocked references after jest.mock has run
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

function makeMockTorrentEngine() {
    return {
        getTrackers: jest.fn().mockReturnValue([]),
        addTracker: jest.fn(),
        removeTracker: jest.fn(),
        getFiles: jest.fn().mockReturnValue([]),
        setFileSelection: jest.fn().mockReturnValue([]),
        on: jest.fn(),
        removeListener: jest.fn(),
    };
}

// ─── Tests: Requirement 8.1 — All IPC channels are registered ────────────────

// Resetar rate limiter entre testes para evitar falsos positivos
afterEach(() => {
    _rateLimiter.reset();
});

describe('registerIpcHandlers — IPC channel registration (Requirement 8.1)', () => {
    const EXPECTED_CHANNELS = [
        'app:update-status',
        'app:check-updates',
        'app:install-update',
        'bandwidth:get-status',
        'bandwidth:set-light',
        'torrent:batch-action',
        'dialog:select-torrent-files',
        'torrent:manage-files',
        'app:get-external-torrents',
        'app:acknowledge-external-torrent',
        'app:register-magnet-handler',
        'app:get-magnet-handler-status',
        'app:open-magnet-default-apps',
        'torrent:prepare',
        'torrent:cancel-preparation',
        'torrent:disk-space',
        'torrent:confirm',
        'torrent:add-file',
        'torrent:add-file-buffer',
        'torrent:add-magnet',
        'torrent:toggle-seed',
        'torrent:pause',
        'torrent:resume',
        'torrent:remove',
        'torrent:get-all',
        'torrent:get-files',
        'torrent:set-file-selection',
        'torrent:retry',
        'settings:get',
        'settings:set',
        'settings:select-folder',
        'dialog:select-torrent-file',
        'tracker:get',
        'tracker:add',
        'tracker:remove',
        'tracker:apply-global',
        'tracker:get-global',
        'tracker:add-global',
        'tracker:remove-global',
        'renderer:report-error',
        'app:get-metrics',
        'torrent:open-folder',
        'torrent:open-file',
        'queue:reorder',
        'queue:get-order',
        'torrent:get-metadata',
        'torrent:get-peers',
        'torrent:get-pieces',
    ];

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('registers all expected IPC channels', () => {
        const downloadManager = makeMockDownloadManager();
        const settingsManager = makeMockSettingsManager();
        const torrentEngine = makeMockTorrentEngine();

        registerIpcHandlers(downloadManager, settingsManager, torrentEngine as any);

        const registeredChannels = mockIpcMain.handle.mock.calls.map(
            (call: unknown[]) => call[0] as string,
        );

        for (const channel of EXPECTED_CHANNELS) {
            expect(registeredChannels).toContain(channel);
        }
    });

    it('registers exactly the expected IPC channels (no extra channels)', () => {
        const downloadManager = makeMockDownloadManager();
        const settingsManager = makeMockSettingsManager();
        const torrentEngine = makeMockTorrentEngine();

        registerIpcHandlers(downloadManager, settingsManager, torrentEngine as any);

        expect(mockIpcMain.handle).toHaveBeenCalledTimes(EXPECTED_CHANNELS.length);
    });

    it.each(EXPECTED_CHANNELS)('registers channel "%s"', (channel) => {
        const downloadManager = makeMockDownloadManager();
        const settingsManager = makeMockSettingsManager();
        const torrentEngine = makeMockTorrentEngine();

        registerIpcHandlers(downloadManager, settingsManager, torrentEngine as any);

        const registeredChannels = mockIpcMain.handle.mock.calls.map(
            (call: unknown[]) => call[0] as string,
        );
        expect(registeredChannels).toContain(channel);
    });
});

// ─── Tests: Requirement 8.4 — nodeIntegration and contextIsolation ────────────

describe('main/index.ts — BrowserWindow security config (Requirement 8.4)', () => {
    const indexPath = join(__dirname, '../../main/index.ts');

    it('sets nodeIntegration: false in BrowserWindow webPreferences', () => {
        const source = readFileSync(indexPath, 'utf-8');
        expect(source).toContain('nodeIntegration: false');
    });

    it('sets contextIsolation: true in BrowserWindow webPreferences', () => {
        const source = readFileSync(indexPath, 'utf-8');
        expect(source).toContain('contextIsolation: true');
    });

    it('does not enable nodeIntegration anywhere', () => {
        const source = readFileSync(indexPath, 'utf-8');
        expect(source).not.toMatch(/nodeIntegration\s*:\s*true/);
    });

    it('does not disable contextIsolation anywhere', () => {
        const source = readFileSync(indexPath, 'utf-8');
        expect(source).not.toMatch(/contextIsolation\s*:\s*false/);
    });
});

// ─── Tests: Requirement 8.5 — Invalid payload returns structured error ────────

describe('registerIpcHandlers — invalid payload returns structured error (Requirement 8.5)', () => {
    /**
     * Helper: extract the handler function registered for a given channel.
     * ipcMain.handle is called as: ipcMain.handle(channel, handlerFn)
     */
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    beforeEach(() => {
        jest.clearAllMocks();

        const downloadManager = makeMockDownloadManager();
        const settingsManager = makeMockSettingsManager();

        registerIpcHandlers(downloadManager, settingsManager);
    });

    it('torrent:add-file with null payload returns { success: false, error: string }', async () => {
        const handler = getHandler('torrent:add-file');
        expect(handler).toBeDefined();

        const response = (await handler!(null, null)) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
        expect(response.error!.length).toBeGreaterThan(0);
    });

    it('torrent:add-file with empty object payload returns { success: false, error: string }', async () => {
        const handler = getHandler('torrent:add-file');
        const response = (await handler!(null, {})) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('torrent:add-file with empty filePath returns { success: false, error: string }', async () => {
        const handler = getHandler('torrent:add-file');
        const response = (await handler!(null, { filePath: '' })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('torrent:add-magnet with null payload returns { success: false, error: string }', async () => {
        const handler = getHandler('torrent:add-magnet');
        expect(handler).toBeDefined();

        const response = (await handler!(null, null)) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('torrent:pause with null payload returns { success: false, error: string }', async () => {
        const handler = getHandler('torrent:pause');
        expect(handler).toBeDefined();

        const response = (await handler!(null, null)) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('torrent:resume with null payload returns { success: false, error: string }', async () => {
        const handler = getHandler('torrent:resume');
        expect(handler).toBeDefined();

        const response = (await handler!(null, null)) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('torrent:remove with null payload returns { success: false, error: string }', async () => {
        const handler = getHandler('torrent:remove');
        expect(handler).toBeDefined();

        const response = (await handler!(null, null)) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('torrent:remove with missing deleteFiles field returns { success: false, error: string }', async () => {
        const handler = getHandler('torrent:remove');
        const response = (await handler!(null, { infoHash: 'a'.repeat(40) })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('settings:set with null payload returns { success: false, error: string }', async () => {
        const handler = getHandler('settings:set');
        expect(handler).toBeDefined();

        const response = (await handler!(null, null)) as { success: boolean; error?: string };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('settings:set with invalid downloadSpeedLimit returns { success: false, error: string }', async () => {
        const handler = getHandler('settings:set');
        const response = (await handler!(null, { downloadSpeedLimit: -1 })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('settings:set with invalid uploadSpeedLimit returns { success: false, error: string }', async () => {
        const handler = getHandler('settings:set');
        const response = (await handler!(null, { uploadSpeedLimit: 1.5 })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('settings:set with empty string locale returns { success: false, error: string }', async () => {
        const handler = getHandler('settings:set');
        const response = (await handler!(null, { locale: '' })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
        expect(response.error).toBe('error.settings.invalidLocale');
    });

    it('settings:set with whitespace-only locale returns { success: false, error: string }', async () => {
        const handler = getHandler('settings:set');
        const response = (await handler!(null, { locale: '   ' })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
        expect(response.error).toBe('error.settings.invalidLocale');
    });

    it('settings:set with non-string locale (number) returns { success: false, error: string }', async () => {
        const handler = getHandler('settings:set');
        const response = (await handler!(null, { locale: 42 })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
        expect(response.error).toBe('error.settings.invalidLocale');
    });

    it('settings:set with null locale returns { success: false, error: string }', async () => {
        const handler = getHandler('settings:set');
        const response = (await handler!(null, { locale: null })) as {
            success: boolean;
            error?: string;
        };

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
        expect(response.error).toBe('error.settings.invalidLocale');
    });

    it('settings:set with valid locale string returns { success: true }', async () => {
        const handler = getHandler('settings:set');
        const response = (await handler!(null, { locale: 'en-US' })) as {
            success: boolean;
            data?: unknown;
        };

        expect(response.success).toBe(true);
    });
});

// ─── Tests: Tracker IPC handlers (Requirement 8.1, 8.2) ──────────────────────

describe('registerIpcHandlers — tracker handlers', () => {
    let mockTorrentEngine: ReturnType<typeof makeMockTorrentEngine>;
    let mockSettingsMgr: SettingsManager;

    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockTorrentEngine = makeMockTorrentEngine();
        mockSettingsMgr = makeMockSettingsManager();
        const downloadManager = makeMockDownloadManager();
        registerIpcHandlers(downloadManager, mockSettingsMgr, mockTorrentEngine as any);
    });

    // ── tracker:get ───────────────────────────────────────────────────────────

    describe('tracker:get', () => {
        it('retorna trackers do torrent com sucesso', async () => {
            const trackers = [{ url: 'udp://tracker.example.com:6969', status: 'connected' }];
            (mockTorrentEngine.getTrackers as jest.Mock).mockReturnValue(trackers);

            const handler = getHandler('tracker:get')!;
            const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(trackers);
            expect(mockTorrentEngine.getTrackers).toHaveBeenCalledWith('a'.repeat(40));
        });

        it('retorna erro para payload inválido (null)', async () => {
            const handler = getHandler('tracker:get')!;
            const response = (await handler(null, null)) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('retorna erro para infoHash vazio', async () => {
            const handler = getHandler('tracker:get')!;
            const response = (await handler(null, { infoHash: '' })) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('retorna erro quando torrentEngine lança exceção', async () => {
            (mockTorrentEngine.getTrackers as jest.Mock).mockImplementation(() => {
                throw new Error('Torrent não encontrado');
            });

            const handler = getHandler('tracker:get')!;
            const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

            expect(response.success).toBe(false);
            // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
            expect(response.error).toBe('error.operation.failed');
        });
    });

    // ── tracker:add ───────────────────────────────────────────────────────────

    describe('tracker:add', () => {
        it('adiciona tracker e retorna lista atualizada', async () => {
            const trackers = [{ url: 'udp://tracker.example.com:6969', status: 'pending' }];
            (mockTorrentEngine.getTrackers as jest.Mock).mockReturnValue(trackers);

            const handler = getHandler('tracker:add')!;
            const response = (await handler(null, {
                infoHash: 'a'.repeat(40),
                url: 'udp://tracker.example.com:6969/announce',
            })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(trackers);
            expect(mockTorrentEngine.addTracker).toHaveBeenCalledWith(
                'a'.repeat(40),
                'udp://tracker.example.com:6969/announce',
            );
        });

        it('retorna erro para payload sem url', async () => {
            const handler = getHandler('tracker:add')!;
            const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('retorna erro para url inválida (protocolo ftp)', async () => {
            const handler = getHandler('tracker:add')!;
            const response = (await handler(null, {
                infoHash: 'a'.repeat(40),
                url: 'ftp://tracker.example.com:6969',
            })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.INVALID_TRACKER_URL);
        });

        it('retorna erro para payload null', async () => {
            const handler = getHandler('tracker:add')!;
            const response = (await handler(null, null)) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });
    });

    // ── tracker:remove ────────────────────────────────────────────────────────

    describe('tracker:remove', () => {
        it('remove tracker e retorna lista atualizada', async () => {
            (mockTorrentEngine.getTrackers as jest.Mock).mockReturnValue([]);

            const handler = getHandler('tracker:remove')!;
            const response = (await handler(null, {
                infoHash: 'a'.repeat(40),
                url: 'udp://tracker.example.com:6969',
            })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual([]);
            expect(mockTorrentEngine.removeTracker).toHaveBeenCalledWith(
                'a'.repeat(40),
                'udp://tracker.example.com:6969',
            );
        });

        it('retorna erro para payload sem url', async () => {
            const handler = getHandler('tracker:remove')!;
            const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('retorna erro quando removeTracker lança exceção', async () => {
            (mockTorrentEngine.removeTracker as jest.Mock).mockImplementation(() => {
                throw new Error('Tracker não encontrado');
            });

            const handler = getHandler('tracker:remove')!;
            const response = (await handler(null, {
                infoHash: 'a'.repeat(40),
                url: 'udp://tracker.example.com:6969',
            })) as any;

            expect(response.success).toBe(false);
            // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
            expect(response.error).toBe('error.operation.failed');
        });
    });

    // ── tracker:apply-global ──────────────────────────────────────────────────

    describe('tracker:apply-global', () => {
        it('aplica trackers globais e retorna lista atualizada', async () => {
            (mockSettingsMgr.getGlobalTrackers as jest.Mock).mockReturnValue([
                'udp://global1.example.com:6969',
                'udp://global2.example.com:6969',
            ]);
            const trackers = [
                { url: 'udp://global1.example.com:6969', status: 'pending' },
                { url: 'udp://global2.example.com:6969', status: 'pending' },
            ];
            (mockTorrentEngine.getTrackers as jest.Mock).mockReturnValue(trackers);

            const handler = getHandler('tracker:apply-global')!;
            const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(trackers);
            expect(mockTorrentEngine.addTracker).toHaveBeenCalledTimes(2);
        });

        it('ignora silenciosamente erros individuais ao aplicar trackers globais', async () => {
            (mockSettingsMgr.getGlobalTrackers as jest.Mock).mockReturnValue([
                'udp://ok.example.com:6969',
                'udp://fail.example.com:6969',
            ]);
            (mockTorrentEngine.addTracker as jest.Mock)
                .mockImplementationOnce(() => {}) // primeiro sucesso
                .mockImplementationOnce(() => {
                    throw new Error('Tracker já presente');
                }); // segundo falha
            (mockTorrentEngine.getTrackers as jest.Mock).mockReturnValue([
                { url: 'udp://ok.example.com:6969', status: 'pending' },
            ]);

            const handler = getHandler('tracker:apply-global')!;
            const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toHaveLength(1);
        });

        it('retorna erro para payload inválido', async () => {
            const handler = getHandler('tracker:apply-global')!;
            const response = (await handler(null, null)) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });
    });

    // ── tracker:get-global ────────────────────────────────────────────────────

    describe('tracker:get-global', () => {
        it('retorna lista global de trackers', async () => {
            const globalTrackers = ['udp://global.example.com:6969'];
            (mockSettingsMgr.getGlobalTrackers as jest.Mock).mockReturnValue(globalTrackers);

            const handler = getHandler('tracker:get-global')!;
            const response = (await handler(null, undefined)) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(globalTrackers);
        });
    });

    // ── tracker:add-global ────────────────────────────────────────────────────

    describe('tracker:add-global', () => {
        it('adiciona tracker global e retorna lista atualizada', async () => {
            const updated = ['udp://global.example.com:6969'];
            (mockSettingsMgr.getGlobalTrackers as jest.Mock).mockReturnValue(updated);

            const handler = getHandler('tracker:add-global')!;
            const response = (await handler(null, {
                url: 'udp://global.example.com:6969',
            })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual(updated);
            expect(mockSettingsMgr.addGlobalTracker).toHaveBeenCalledWith(
                'udp://global.example.com:6969',
            );
        });

        it('retorna erro para url inválida', async () => {
            const handler = getHandler('tracker:add-global')!;
            const response = (await handler(null, {
                url: 'ftp://invalid.example.com',
            })) as any;

            expect(response.success).toBe(false);
            expect(response.error).toBe(ErrorCodes.INVALID_TRACKER_URL);
        });

        it('retorna erro para payload null', async () => {
            const handler = getHandler('tracker:add-global')!;
            const response = (await handler(null, null)) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('retorna erro para url vazia', async () => {
            const handler = getHandler('tracker:add-global')!;
            const response = (await handler(null, { url: '' })) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('retorna erro quando addGlobalTracker lança exceção (duplicata)', async () => {
            (mockSettingsMgr.addGlobalTracker as jest.Mock).mockImplementation(() => {
                throw new Error('Tracker já existe na lista global');
            });

            const handler = getHandler('tracker:add-global')!;
            const response = (await handler(null, {
                url: 'udp://global.example.com:6969',
            })) as any;

            expect(response.success).toBe(false);
            // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
            expect(response.error).toBe('error.operation.failed');
        });
    });

    // ── tracker:remove-global ─────────────────────────────────────────────────

    describe('tracker:remove-global', () => {
        it('remove tracker global e retorna lista atualizada', async () => {
            (mockSettingsMgr.getGlobalTrackers as jest.Mock).mockReturnValue([]);

            const handler = getHandler('tracker:remove-global')!;
            const response = (await handler(null, {
                url: 'udp://global.example.com:6969',
            })) as any;

            expect(response.success).toBe(true);
            expect(response.data).toEqual([]);
            expect(mockSettingsMgr.removeGlobalTracker).toHaveBeenCalledWith(
                'udp://global.example.com:6969',
            );
        });

        it('retorna erro para payload null', async () => {
            const handler = getHandler('tracker:remove-global')!;
            const response = (await handler(null, null)) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });

        it('retorna erro para url vazia', async () => {
            const handler = getHandler('tracker:remove-global')!;
            const response = (await handler(null, { url: '' })) as any;

            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
        });
    });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

import fc from 'fast-check';

// ─── Property 18 — Resposta IPC sempre estruturada ────────────────────────────
// Feature: meshy-torrent-client, Property 18: Resposta IPC sempre tem forma estruturada
// **Validates: Requirements 8.2, 8.5**

describe('Property 18: Resposta IPC sempre tem forma estruturada', () => {
    const ALL_CHANNELS = [
        'torrent:add-file',
        'torrent:add-magnet',
        'torrent:toggle-seed',
        'torrent:pause',
        'torrent:resume',
        'torrent:remove',
        'torrent:get-all',
        'settings:get',
        'settings:set',
        'settings:select-folder',
        'tracker:get',
        'tracker:add',
        'tracker:remove',
        'tracker:apply-global',
        'tracker:get-global',
        'tracker:add-global',
        'tracker:remove-global',
    ];

    /**
     * Helper: extract the handler function registered for a given channel.
     */
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    /**
     * Registers handlers with fresh mocks and returns the mock managers.
     */
    function setupHandlers() {
        jest.clearAllMocks();

        const downloadManager = makeMockDownloadManager();
        const settingsManager = makeMockSettingsManager();
        const torrentEngine = makeMockTorrentEngine();

        registerIpcHandlers(downloadManager, settingsManager, torrentEngine as any);

        return { downloadManager, settingsManager, torrentEngine };
    }

    it('any payload sent to any IPC channel always returns { success: boolean } and never throws', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...ALL_CHANNELS),
                fc.anything(),
                async (channel, payload) => {
                    setupHandlers();
                    const handler = getHandler(channel);
                    expect(handler).toBeDefined();

                    // The handler must never throw — it must always return a structured response
                    const response = (await handler!(null, payload)) as Record<string, unknown>;

                    expect(response).toBeDefined();
                    expect(typeof response).toBe('object');
                    expect(response).not.toBeNull();
                    expect(typeof response.success).toBe('boolean');
                },
            ),
            { numRuns: 100 },
        );
    });

    it('invalid payloads to channels requiring parameters return { success: false, error: string }', async () => {
        // Channels that require specific payload shapes — any arbitrary value
        // that doesn't match the expected shape should yield { success: false, error: string }
        const CHANNELS_WITH_REQUIRED_PARAMS = [
            'torrent:add-file',
            'torrent:add-magnet',
            'torrent:toggle-seed',
            'torrent:pause',
            'torrent:resume',
            'torrent:remove',
            'tracker:get',
            'tracker:add',
            'tracker:remove',
            'tracker:apply-global',
            'tracker:add-global',
            'tracker:remove-global',
        ];

        // Generator for payloads that are definitely NOT valid for any of these channels.
        // We exclude objects that happen to have the right shape by using primitives,
        // null, undefined, arrays, and objects without the required keys.
        const invalidPayloadArb = fc.oneof(
            fc.constant(null),
            fc.constant(undefined),
            fc.boolean(),
            fc.integer(),
            fc.double(),
            fc.string(),
            fc.array(fc.anything()),
            // Objects with wrong keys
            fc.record({
                wrongKey: fc.anything(),
            }),
            // Empty object
            fc.constant({}),
        );

        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...CHANNELS_WITH_REQUIRED_PARAMS),
                invalidPayloadArb,
                async (channel, payload) => {
                    setupHandlers();
                    const handler = getHandler(channel);
                    expect(handler).toBeDefined();

                    const response = (await handler!(null, payload)) as Record<string, unknown>;

                    expect(response).toBeDefined();
                    expect(response.success).toBe(false);
                    expect(typeof response.error).toBe('string');
                    expect((response.error as string).length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('settings:set with invalid speed limit values returns { success: false, error: string }', async () => {
        // Generate payloads where speed limits are invalid (negative, float, non-number)
        const invalidSpeedLimitArb = fc.oneof(
            fc.double().filter((v) => v < 0 || !Number.isInteger(v)),
            fc.constant(-1),
            fc.constant(1.5),
            fc.constant(-0.1),
            fc.constant(NaN),
            fc.constant(Infinity),
            fc.constant(-Infinity),
        );

        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom('downloadSpeedLimit', 'uploadSpeedLimit'),
                invalidSpeedLimitArb,
                async (field, invalidValue) => {
                    setupHandlers();
                    const handler = getHandler('settings:set');
                    expect(handler).toBeDefined();

                    const payload = { [field]: invalidValue };
                    const response = (await handler!(null, payload)) as Record<string, unknown>;

                    expect(response).toBeDefined();
                    expect(response.success).toBe(false);
                    expect(typeof response.error).toBe('string');
                    expect((response.error as string).length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── Property 19 — Evento de progresso IPC contém todos os itens ativos ───────
// Feature: meshy-torrent-client, Property 19: Evento de progresso IPC contém todos os itens ativos
// **Validates: Requirements 8.3**

describe('Property 19: Evento de progresso IPC contém todos os itens ativos', () => {
    // ── Arbitrary generators ──────────────────────────────────────────────────

    const ALL_STATUSES = [
        'queued',
        'resolving-metadata',
        'downloading',
        'paused',
        'completed',
        'error',
        'metadata-failed',
        'files-not-found',
    ] as const;

    const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['downloading', 'resolving-metadata']);

    /** Generate a hex string of exactly 40 chars (simulates an infoHash). */
    const infoHashArb = fc
        .string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: 40, maxLength: 40 })
        .map((s) => s.toLowerCase());

    /** Generate a single DownloadItem with a given infoHash. */
    const downloadItemArb = (hash: string) =>
        fc.record({
            infoHash: fc.constant(hash),
            name: fc.string({ minLength: 1, maxLength: 50 }),
            totalSize: fc.nat({ max: 10_000_000_000 }),
            downloadedSize: fc.nat({ max: 10_000_000_000 }),
            progress: fc.double({ min: 0, max: 1, noNaN: true }),
            downloadSpeed: fc.nat({ max: 100_000_000 }),
            uploadSpeed: fc.nat({ max: 100_000_000 }),
            numPeers: fc.nat({ max: 500 }),
            numSeeders: fc.nat({ max: 500 }),
            timeRemaining: fc.nat({ max: 1_000_000_000 }),
            status: fc.constantFrom(...ALL_STATUSES),
            destinationFolder: fc.constant('/downloads'),
            addedAt: fc.nat({ max: Date.now() }),
        });

    /**
     * Generate an array of 0–10 DownloadItems with unique infoHashes.
     * Uses fc.uniqueArray to guarantee uniqueness of hashes, then maps
     * each hash to a full DownloadItem.
     */
    const downloadItemsArb = fc
        .uniqueArray(infoHashArb, { minLength: 0, maxLength: 10 })
        .chain((hashes) =>
            hashes.length === 0
                ? fc.constant<DownloadItem[]>([])
                : fc
                      .tuple(...hashes.map((h) => downloadItemArb(h)))
                      .map((items) => items as DownloadItem[]),
        );

    // ── Helpers ───────────────────────────────────────────────────────────────

    function makeMockTorrentEngine() {
        return {
            on: jest.fn(),
            removeListener: jest.fn(),
        };
    }

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('progress event payload contains exactly the active items from downloadManager.getAll()', () => {
        fc.assert(
            fc.property(downloadItemsArb, (items) => {
                // ── Arrange ──────────────────────────────────────────────────
                const downloadManager = makeMockDownloadManager();
                (downloadManager.getAll as jest.Mock).mockReturnValue(items);

                const mockWebContents = { send: jest.fn() };
                const mockWindow = {
                    webContents: mockWebContents,
                    isDestroyed: jest.fn().mockReturnValue(false),
                    on: jest.fn(),
                };

                const { BrowserWindow } = require('electron');
                BrowserWindow.mockImplementation(() => mockWindow);

                const torrentEngine = makeMockTorrentEngine();

                // Import and call attachWindowEvents
                const { attachWindowEvents } = require('../../main/ipcHandler');
                attachWindowEvents(downloadManager, torrentEngine, mockWindow);

                // ── Act ──────────────────────────────────────────────────────
                // Advance the timer by 1 second to trigger the progress interval
                jest.advanceTimersByTime(1000);

                // ── Assert ───────────────────────────────────────────────────
                // The progress event should have been sent
                const sendCalls = mockWebContents.send.mock.calls.filter(
                    (call: unknown[]) => call[0] === 'torrent:progress',
                );
                expect(sendCalls.length).toBe(1);

                const payload = sendCalls[0][1] as DownloadItem[];

                // Extract active items from the original items array
                const expectedActiveHashes = new Set(
                    items
                        .filter((item) => ACTIVE_STATUSES.has(item.status))
                        .map((item) => item.infoHash),
                );

                // Extract active items from the payload
                const payloadActiveHashes = new Set(
                    payload
                        .filter((item) => ACTIVE_STATUSES.has(item.status))
                        .map((item) => item.infoHash),
                );

                // The active infoHashes in the payload must match exactly
                expect(payloadActiveHashes).toEqual(expectedActiveHashes);

                // Clean up: clear the interval by triggering the 'closed' callback
                const closedCallback = mockWindow.on.mock.calls.find(
                    (call: unknown[]) => call[0] === 'closed',
                );
                if (closedCallback) {
                    (closedCallback[1] as () => void)();
                }
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Property 8 — Payloads inválidos retornam { success: false } sem exceção ──
// Feature: tracker-management, Property 8: IPC retorna erro para payloads inválidos
// **Validates: Requirements 8.2**

describe('Property 8: payloads inválidos retornam { success: false } sem lançar exceção', () => {
    // Canais de tracker que exigem payload com campos específicos
    const TRACKER_CHANNELS_WITH_INFOHASH = ['tracker:get', 'tracker:apply-global'];

    const TRACKER_CHANNELS_WITH_INFOHASH_AND_URL = ['tracker:add', 'tracker:remove'];

    const TRACKER_CHANNELS_WITH_URL = ['tracker:add-global', 'tracker:remove-global'];

    const ALL_TRACKER_CHANNELS = [
        ...TRACKER_CHANNELS_WITH_INFOHASH,
        ...TRACKER_CHANNELS_WITH_INFOHASH_AND_URL,
        ...TRACKER_CHANNELS_WITH_URL,
    ];

    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    function setupHandlers() {
        jest.clearAllMocks();

        const downloadManager = makeMockDownloadManager();
        const settingsManager = makeMockSettingsManager();
        const torrentEngine = makeMockTorrentEngine();

        registerIpcHandlers(downloadManager, settingsManager, torrentEngine as any);

        return { downloadManager, settingsManager, torrentEngine };
    }

    // Gerador de payloads inválidos — primitivos, null, arrays, objetos sem campos esperados
    const invalidPayloadArb = fc.oneof(
        fc.constant(null),
        fc.constant(undefined),
        fc.boolean(),
        fc.integer(),
        fc.double(),
        fc.string(),
        fc.array(fc.anything()),
        fc.record({ wrongKey: fc.anything() }),
        fc.constant({}),
    );

    it('qualquer payload inválido enviado a canais de tracker retorna { success: false } sem lançar exceção', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...ALL_TRACKER_CHANNELS),
                invalidPayloadArb,
                async (channel, payload) => {
                    setupHandlers();
                    const handler = getHandler(channel);
                    expect(handler).toBeDefined();

                    // O handler nunca deve lançar exceção
                    const response = (await handler!(null, payload)) as Record<string, unknown>;

                    expect(response).toBeDefined();
                    expect(typeof response).toBe('object');
                    expect(response).not.toBeNull();
                    expect(response.success).toBe(false);
                    expect(typeof response.error).toBe('string');
                    expect((response.error as string).length).toBeGreaterThan(0);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('canais com infoHash rejeitam objetos com infoHash não-string ou vazio', async () => {
        const invalidInfoHashArb = fc.oneof(
            fc.constant({ infoHash: '' }),
            fc.constant({ infoHash: 123 }),
            fc.constant({ infoHash: null }),
            fc.constant({ infoHash: true }),
            fc.constant({ infoHash: undefined }),
            fc.constant({}),
        );

        const channelsWithInfoHash = [
            ...TRACKER_CHANNELS_WITH_INFOHASH,
            ...TRACKER_CHANNELS_WITH_INFOHASH_AND_URL,
        ];

        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...channelsWithInfoHash),
                invalidInfoHashArb,
                async (channel, payload) => {
                    setupHandlers();
                    const handler = getHandler(channel);
                    expect(handler).toBeDefined();

                    const response = (await handler!(null, payload)) as Record<string, unknown>;

                    expect(response.success).toBe(false);
                    expect(typeof response.error).toBe('string');
                },
            ),
            { numRuns: 50 },
        );
    });

    it('canais com url rejeitam objetos com url não-string ou vazia', async () => {
        const invalidUrlPayloadArb = fc.oneof(
            fc.constant({ url: '' }),
            fc.constant({ url: 123 }),
            fc.constant({ url: null }),
            fc.constant({ url: true }),
            fc.constant({ url: undefined }),
            fc.constant({}),
        );

        await fc.assert(
            fc.asyncProperty(
                fc.constantFrom(...TRACKER_CHANNELS_WITH_URL),
                invalidUrlPayloadArb,
                async (channel, payload) => {
                    setupHandlers();
                    const handler = getHandler(channel);
                    expect(handler).toBeDefined();

                    const response = (await handler!(null, payload)) as Record<string, unknown>;

                    expect(response.success).toBe(false);
                    expect(typeof response.error).toBe('string');
                },
            ),
            { numRuns: 50 },
        );
    });
});

// ─── Tests: Validação de booleanos de rede no handler settings:set (Task 5.5) ─

describe('registerIpcHandlers — validação de dhtEnabled/pexEnabled/utpEnabled no settings:set', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('rejeita dhtEnabled não-booleano (número)', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('settings:set')!;
        const response = (await handler(null, { dhtEnabled: 1 })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('rejeita pexEnabled não-booleano (string)', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('settings:set')!;
        const response = (await handler(null, { pexEnabled: 'true' })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('rejeita utpEnabled não-booleano (null)', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('settings:set')!;
        const response = (await handler(null, { utpEnabled: null })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('aceita dhtEnabled booleano true', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('settings:set')!;
        const response = (await handler(null, { dhtEnabled: true })) as any;

        expect(response.success).toBe(true);
    });

    it('aceita pexEnabled booleano false', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('settings:set')!;
        const response = (await handler(null, { pexEnabled: false })) as any;

        expect(response.success).toBe(true);
    });

    it('aceita utpEnabled booleano false', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('settings:set')!;
        const response = (await handler(null, { utpEnabled: false })) as any;

        expect(response.success).toBe(true);
    });

    it('não persiste configurações quando validação falha', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('settings:set')!;
        await handler(null, { dhtEnabled: 'invalid' });

        expect(sm.set).not.toHaveBeenCalled();
    });
});

// ─── Tests: Detecção de mudança e acionamento de restart (Task 5.6) ───────────

describe('registerIpcHandlers — detecção de mudança de rede e restart', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('aciona restart quando dhtEnabled muda de true para false', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).restart = jest.fn().mockResolvedValue(undefined);
        (te as any).isRestarting = jest.fn().mockReturnValue(false);

        // Configurações atuais: dhtEnabled = true
        (sm.get as jest.Mock).mockReturnValue({
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
        });

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('settings:set')!;
        await handler(null, { dhtEnabled: false });

        expect((te as any).restart).toHaveBeenCalledTimes(1);
    });

    it('aciona restart quando pexEnabled muda', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).restart = jest.fn().mockResolvedValue(undefined);
        (te as any).isRestarting = jest.fn().mockReturnValue(false);

        (sm.get as jest.Mock).mockReturnValue({
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
        });

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('settings:set')!;
        await handler(null, { pexEnabled: false });

        expect((te as any).restart).toHaveBeenCalledTimes(1);
    });

    it('aciona restart quando utpEnabled muda', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).restart = jest.fn().mockResolvedValue(undefined);
        (te as any).isRestarting = jest.fn().mockReturnValue(false);

        (sm.get as jest.Mock).mockReturnValue({
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
        });

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('settings:set')!;
        await handler(null, { utpEnabled: false });

        expect((te as any).restart).toHaveBeenCalledTimes(1);
    });

    it('NÃO aciona restart quando valores de rede não mudam', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).restart = jest.fn().mockResolvedValue(undefined);
        (te as any).isRestarting = jest.fn().mockReturnValue(false);

        // Configurações atuais: todos true
        (sm.get as jest.Mock).mockReturnValue({
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
        });

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('settings:set')!;
        // Enviar os mesmos valores — não deve acionar restart
        await handler(null, { dhtEnabled: true, pexEnabled: true, utpEnabled: true });

        expect((te as any).restart).not.toHaveBeenCalled();
    });

    it('NÃO aciona restart quando apenas configurações não-rede mudam', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).restart = jest.fn().mockResolvedValue(undefined);
        (te as any).isRestarting = jest.fn().mockReturnValue(false);

        (sm.get as jest.Mock).mockReturnValue({
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
        });

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('settings:set')!;
        await handler(null, { downloadSpeedLimit: 500 });

        expect((te as any).restart).not.toHaveBeenCalled();
    });

    it('passa configurações atualizadas ao restart', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).restart = jest.fn().mockResolvedValue(undefined);
        (te as any).isRestarting = jest.fn().mockReturnValue(false);

        // Primeira chamada a get() retorna valores anteriores (antes de set)
        // Segunda chamada retorna valores atualizados (após set)
        let callCount = 0;
        (sm.get as jest.Mock).mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return {
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
                };
            }
            return {
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
                dhtEnabled: false,
                pexEnabled: true,
                utpEnabled: true,

                closeToTray: false,
            };
        });

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('settings:set')!;
        await handler(null, { dhtEnabled: false });

        expect((te as any).restart).toHaveBeenCalledWith({
            downloadPath: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            dhtEnabled: false,
            pexEnabled: true,
            utpEnabled: true,
        });
    });

    it('NÃO aciona restart quando torrentEngine não está disponível', async () => {
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();

        (sm.get as jest.Mock).mockReturnValue({
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
        });

        // Registrar sem torrentEngine
        registerIpcHandlers(dm, sm);

        const handler = getHandler('settings:set')!;
        // Não deve lançar exceção mesmo sem torrentEngine
        const response = (await handler(null, { dhtEnabled: false })) as any;

        expect(response.success).toBe(true);
    });
});

// ─── Tests: Rejeição de operações durante restart (Task 5.7) ──────────────────

describe('registerIpcHandlers — rejeição de operações durante restart do motor', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    const GUARDED_CHANNELS = [
        'torrent:add-file',
        'torrent:add-magnet',
        'torrent:toggle-seed',
        'torrent:pause',
        'torrent:resume',
        'torrent:remove',
    ];

    // Payloads válidos para cada canal (para garantir que a rejeição vem da guarda, não da validação)
    const VALID_PAYLOADS: Record<string, unknown> = {
        'torrent:add-file': { filePath: '/path/to/file.torrent' },
        'torrent:add-magnet': { magnetUri: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) },
        'torrent:pause': { infoHash: 'a'.repeat(40) },
        'torrent:resume': { infoHash: 'a'.repeat(40) },
        'torrent:remove': { infoHash: 'a'.repeat(40), deleteFiles: false },
    };

    it.each(GUARDED_CHANNELS)('%s retorna erro quando motor está reiniciando', async (channel) => {
        jest.clearAllMocks();

        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).restart = jest.fn().mockResolvedValue(undefined);
        (te as any).isRestarting = jest.fn().mockReturnValue(true);

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler(channel)!;
        const response = (await handler(null, VALID_PAYLOADS[channel])) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
    });

    it.each(GUARDED_CHANNELS)(
        '%s permite operação quando motor NÃO está reiniciando',
        async (channel) => {
            jest.clearAllMocks();

            const dm = makeMockDownloadManager();
            const sm = makeMockSettingsManager();
            const te = makeMockTorrentEngine();
            (te as any).restart = jest.fn().mockResolvedValue(undefined);
            (te as any).isRestarting = jest.fn().mockReturnValue(false);

            // Configurar mocks para que as operações não falhem por outros motivos
            (dm.addTorrentFile as jest.Mock).mockResolvedValue({
                infoHash: 'a'.repeat(40),
                name: 'test',
                status: 'downloading',
            });
            (dm.addMagnetLink as jest.Mock).mockResolvedValue({
                infoHash: 'a'.repeat(40),
                name: 'test',
                status: 'resolving-metadata',
            });

            registerIpcHandlers(dm, sm, te as any);

            const handler = getHandler(channel)!;
            const response = (await handler(null, VALID_PAYLOADS[channel])) as any;

            // Não deve conter a mensagem de reinício
            if (!response.success) {
                expect(response.error).not.toContain('reiniciando');
            }
        },
    );

    it('torrent:get-all NÃO é bloqueado durante restart', async () => {
        jest.clearAllMocks();

        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).restart = jest.fn().mockResolvedValue(undefined);
        (te as any).isRestarting = jest.fn().mockReturnValue(true);

        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:get-all')!;
        const response = (await handler(null, undefined)) as any;

        // get-all deve funcionar mesmo durante restart
        expect(response.success).toBe(true);
    });
});

// ─── PBT: Propriedade 2 — Reinício acionado somente quando valores de rede mudam (Task 5.8) ──
// Feature: dht-pex-settings, Property 2: Reinício acionado somente quando valores de rede mudam
// **Validates: Requirements 6.3**

describe('Property 2: Reinício acionado somente quando valores de rede mudam', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    it('restart é acionado se e somente se pelo menos um campo de rede difere', async () => {
        const networkSettingsArb = fc.record({
            dhtEnabled: fc.boolean(),
            pexEnabled: fc.boolean(),
            utpEnabled: fc.boolean(),
        });

        await fc.assert(
            fc.asyncProperty(networkSettingsArb, networkSettingsArb, async (previous, next) => {
                jest.clearAllMocks();

                const dm = makeMockDownloadManager();
                const sm = makeMockSettingsManager();
                const te = makeMockTorrentEngine();
                (te as any).restart = jest.fn().mockResolvedValue(undefined);
                (te as any).isRestarting = jest.fn().mockReturnValue(false);

                // Configurar settingsManager.get() para retornar os valores "anteriores"
                (sm.get as jest.Mock).mockReturnValue({
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
                    dhtEnabled: previous.dhtEnabled,
                    pexEnabled: previous.pexEnabled,
                    utpEnabled: previous.utpEnabled,
                });

                registerIpcHandlers(dm, sm, te as any);

                const handler = getHandler('settings:set')!;
                await handler(null, {
                    dhtEnabled: next.dhtEnabled,
                    pexEnabled: next.pexEnabled,
                    utpEnabled: next.utpEnabled,
                });

                // Calcular se pelo menos um campo de rede difere
                const shouldRestart =
                    previous.dhtEnabled !== next.dhtEnabled ||
                    previous.pexEnabled !== next.pexEnabled ||
                    previous.utpEnabled !== next.utpEnabled;

                if (shouldRestart) {
                    expect((te as any).restart).toHaveBeenCalledTimes(1);
                } else {
                    expect((te as any).restart).not.toHaveBeenCalled();
                }
            }),
            { numRuns: 200 },
        );
    });
});

// ─── Tests: renderer:report-error handler (Task 4.3) ─────────────────────────

describe('registerIpcHandlers — renderer:report-error handler (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    function setup() {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);
        return { dm, sm };
    }

    it('retorna sucesso para payload válido com message e source', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, {
            message: 'Uncaught TypeError: x is not a function',
            source: 'ErrorBoundary',
        })) as any;

        expect(response.success).toBe(true);
    });

    it('retorna sucesso com stack e componentStack opcionais presentes', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, {
            message: 'React render error',
            source: 'App',
            stack: 'Error: React render error\n  at App.tsx:10',
            componentStack: '\n    in App\n    in div',
        })) as any;

        expect(response.success).toBe(true);
    });

    it('retorna sucesso mesmo sem stack e componentStack', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, {
            message: 'Minimal error',
            source: 'DownloadList',
        })) as any;

        expect(response.success).toBe(true);
    });

    it('retorna erro para payload null', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
        expect(response.error.length).toBeGreaterThan(0);
    });

    it('retorna erro para message vazia', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, { message: '', source: 'App' })) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna erro para source ausente no payload', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, { message: 'Some error' })) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna erro para source vazia', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, { message: 'Some error', source: '' })) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna erro para payload sem nenhum campo', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, {})) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna erro para payload primitivo (número)', async () => {
        setup();
        const handler = getHandler('renderer:report-error')!;
        const response = (await handler(null, 42)) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });
});

// ─── Tests: app:get-metrics handler (Task 4.3) ────────────────────────────────

describe('registerIpcHandlers — app:get-metrics handler (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    beforeEach(() => {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);
    });

    it('retorna MetricsSnapshot com success: true', async () => {
        const handler = getHandler('app:get-metrics')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(true);
        expect(response.data).toBeDefined();
    });

    it('snapshot contém todos os campos numéricos obrigatórios', async () => {
        const handler = getHandler('app:get-metrics')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(true);
        const snap = response.data;
        expect(typeof snap.ipcCallCount).toBe('number');
        expect(typeof snap.ipcErrorCount).toBe('number');
        expect(typeof snap.engineErrorCount).toBe('number');
        expect(typeof snap.rendererCrashCount).toBe('number');
        expect(typeof snap.rendererErrorCount).toBe('number');
        expect(typeof snap.uptimeMs).toBe('number');
        expect(typeof snap.startedAt).toBe('number');
    });

    it('snapshot contém objeto memoryUsage com campos de heap', async () => {
        const handler = getHandler('app:get-metrics')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(true);
        const snap = response.data;
        expect(typeof snap.memoryUsage).toBe('object');
        expect(typeof snap.memoryUsage.heapUsed).toBe('number');
        expect(typeof snap.memoryUsage.heapTotal).toBe('number');
        expect(typeof snap.memoryUsage.rss).toBe('number');
    });

    it('snapshot contém mapas de chamadas e erros por canal', async () => {
        const handler = getHandler('app:get-metrics')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(true);
        const snap = response.data;
        expect(typeof snap.errorsByChannel).toBe('object');
        expect(typeof snap.callsByChannel).toBe('object');
        expect(typeof snap.avgLatencyByChannel).toBe('object');
    });

    it('handler ignora o payload (sempre retorna snapshot)', async () => {
        const handler = getHandler('app:get-metrics')!;
        const response1 = (await handler(null, null)) as any;
        const response2 = (await handler(null, { unexpected: true })) as any;

        expect(response1.success).toBe(true);
        expect(response2.success).toBe(true);
    });
});

// ─── Tests: torrent:retry handler (Task 4.3) ──────────────────────────────────

describe('registerIpcHandlers — torrent:retry handler (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    const RETRIED_ITEM = {
        infoHash: 'a'.repeat(40),
        name: 'test.torrent',
        status: 'downloading',
        destinationFolder: '/downloads',
        totalSize: 0,
        downloadedSize: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: 0,
        addedAt: 0,
    };

    it('retorna o item re-tentado com sucesso', async () => {
        jest.clearAllMocks();
        const dm = {
            ...makeMockDownloadManager(),
            retryDownload: jest.fn().mockResolvedValue(RETRIED_ITEM),
        } as unknown as DownloadManager;
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(false);
        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:retry')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual(RETRIED_ITEM);
        expect(dm.retryDownload).toHaveBeenCalledWith('a'.repeat(40));
    });

    it('retorna ENGINE_RESTARTING quando motor está reiniciando', async () => {
        jest.clearAllMocks();
        const dm = {
            ...makeMockDownloadManager(),
            retryDownload: jest.fn(),
        } as unknown as DownloadManager;
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(true);
        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:retry')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
        expect(dm.retryDownload).not.toHaveBeenCalled();
    });

    it('retorna erro para payload null', async () => {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('torrent:retry')!;
        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
        expect(response.error.length).toBeGreaterThan(0);
    });

    it('retorna erro para infoHash vazio', async () => {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('torrent:retry')!;
        const response = (await handler(null, { infoHash: '' })) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna erro quando retryDownload lança exceção', async () => {
        jest.clearAllMocks();
        const dm = {
            ...makeMockDownloadManager(),
            retryDownload: jest
                .fn()
                .mockRejectedValue(new Error('Torrent não está em estado de erro')),
        } as unknown as DownloadManager;
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(false);
        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:retry')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(false);
        // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
        expect(response.error).toBe('error.operation.failed');
    });

    it('retorna erro para payload sem infoHash', async () => {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        const handler = getHandler('torrent:retry')!;
        const response = (await handler(null, { wrongKey: 'value' })) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });
});

// ─── Tests: ENGINE_NOT_AVAILABLE branches (Task 4.3) ──────────────────────────

describe('registerIpcHandlers — ENGINE_NOT_AVAILABLE sem torrentEngine (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    /** Registra handlers SEM torrentEngine para cobrir ENGINE_NOT_AVAILABLE */
    function setupWithoutEngine(items: unknown[] = []) {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        (dm.getAll as jest.Mock).mockReturnValue(items);
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm); // sem torrentEngine
        return { dm, sm };
    }

    it('tracker:get retorna ENGINE_NOT_AVAILABLE sem engine', async () => {
        setupWithoutEngine();
        const handler = getHandler('tracker:get')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });

    it('tracker:add retorna ENGINE_NOT_AVAILABLE sem engine', async () => {
        setupWithoutEngine();
        const handler = getHandler('tracker:add')!;
        const response = (await handler(null, {
            infoHash: 'a'.repeat(40),
            url: 'udp://tracker.example.com:6969',
        })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });

    it('tracker:remove retorna ENGINE_NOT_AVAILABLE sem engine', async () => {
        setupWithoutEngine();
        const handler = getHandler('tracker:remove')!;
        const response = (await handler(null, {
            infoHash: 'a'.repeat(40),
            url: 'udp://tracker.example.com:6969',
        })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });

    it('tracker:apply-global retorna ENGINE_NOT_AVAILABLE sem engine', async () => {
        setupWithoutEngine();
        const handler = getHandler('tracker:apply-global')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });

    it('torrent:get-files retorna ENGINE_NOT_AVAILABLE quando item existe mas engine ausente', async () => {
        setupWithoutEngine([{ infoHash: 'a'.repeat(40), status: 'downloading' }]);
        const handler = getHandler('torrent:get-files')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });

    it('torrent:set-file-selection retorna ENGINE_NOT_AVAILABLE quando item existe mas engine ausente', async () => {
        setupWithoutEngine([{ infoHash: 'a'.repeat(40), status: 'downloading' }]);
        const handler = getHandler('torrent:set-file-selection')!;
        const response = (await handler(null, {
            infoHash: 'a'.repeat(40),
            selectedIndices: [0],
        })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });

    it('torrent:get-metadata retorna ENGINE_NOT_AVAILABLE sem engine', async () => {
        setupWithoutEngine([{ infoHash: 'a'.repeat(40), status: 'downloading' }]);
        const handler = getHandler('torrent:get-metadata')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });

    it('torrent:get-peers retorna ENGINE_NOT_AVAILABLE sem engine', async () => {
        setupWithoutEngine([{ infoHash: 'a'.repeat(40), status: 'downloading' }]);
        const handler = getHandler('torrent:get-peers')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });

    it('torrent:get-pieces retorna ENGINE_NOT_AVAILABLE sem engine', async () => {
        setupWithoutEngine([{ infoHash: 'a'.repeat(40), status: 'downloading' }]);
        const handler = getHandler('torrent:get-pieces')!;
        const response = (await handler(null, { infoHash: 'a'.repeat(40) })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_NOT_AVAILABLE);
    });
});

// ─── Tests: torrent:get-metadata handler (Task 4.3) ───────────────────────────

describe('registerIpcHandlers — torrent:get-metadata handler (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    const VALID_HASH = 'a'.repeat(40);
    const VALID_ITEM = { infoHash: VALID_HASH, status: 'downloading' };
    const VALID_METADATA = {
        infoHash: VALID_HASH,
        creator: 'TestCreator',
        comment: 'Test comment',
        creationDate: 1234567890,
    };

    function setup(items: unknown[] = [VALID_ITEM], isRestarting = false) {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        (dm.getAll as jest.Mock).mockReturnValue(items);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(isRestarting);
        (te as any).getMetadata = jest.fn().mockReturnValue(VALID_METADATA);
        registerIpcHandlers(dm, sm, te as any);
        return { dm, sm, te };
    }

    it('retorna metadados com sucesso para infoHash hexadecimal válido', async () => {
        setup();
        const handler = getHandler('torrent:get-metadata')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual(VALID_METADATA);
    });

    it('retorna TORRENT_NOT_FOUND quando torrent não está na lista', async () => {
        setup([]); // lista vazia
        const handler = getHandler('torrent:get-metadata')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
    });

    it('retorna ENGINE_RESTARTING quando motor está reiniciando', async () => {
        setup([VALID_ITEM], true); // isRestarting = true
        const handler = getHandler('torrent:get-metadata')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
    });

    it('retorna INVALID_PARAMS para infoHash com menos de 40 chars', async () => {
        setup();
        const handler = getHandler('torrent:get-metadata')!;
        const response = (await handler(null, { infoHash: 'abc123' })) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna INVALID_PARAMS para infoHash não hexadecimal de 40 chars', async () => {
        setup();
        const handler = getHandler('torrent:get-metadata')!;
        // 40 chars but contains 'g'-'z' which are not hex
        const nonHexHash = 'g'.repeat(40);
        const response = (await handler(null, { infoHash: nonHexHash })) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna INVALID_PARAMS para payload null', async () => {
        setup();
        const handler = getHandler('torrent:get-metadata')!;
        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna erro quando getMetadata lança exceção', async () => {
        const { te } = setup();
        (te as any).getMetadata.mockImplementation(() => {
            throw new Error('Torrent não encontrado no engine');
        });

        const handler = getHandler('torrent:get-metadata')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(false);
        // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
        expect(response.error).toBe('error.operation.failed');
    });
});

// ─── Tests: torrent:get-peers handler (Task 4.3) ──────────────────────────────

describe('registerIpcHandlers — torrent:get-peers handler (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    const VALID_HASH = 'b'.repeat(40);
    const VALID_PEERS = [
        { address: '1.2.3.4:6881', client: 'uTorrent', downloadSpeed: 0, uploadSpeed: 0 },
        { address: '5.6.7.8:6881', client: 'qBittorrent', downloadSpeed: 512, uploadSpeed: 256 },
    ];

    function setup(
        items: unknown[] = [{ infoHash: VALID_HASH, status: 'downloading' }],
        isRestarting = false,
    ) {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        (dm.getAll as jest.Mock).mockReturnValue(items);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(isRestarting);
        (te as any).getPeers = jest.fn().mockReturnValue(VALID_PEERS);
        registerIpcHandlers(dm, sm, te as any);
        return { dm, sm, te };
    }

    it('retorna lista de peers com sucesso', async () => {
        setup();
        const handler = getHandler('torrent:get-peers')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual(VALID_PEERS);
    });

    it('retorna array vazio para torrent em resolving-metadata', async () => {
        setup([{ infoHash: VALID_HASH, status: 'resolving-metadata' }]);
        const handler = getHandler('torrent:get-peers')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual([]);
    });

    it('retorna TORRENT_NOT_FOUND quando torrent não está na lista', async () => {
        setup([]); // lista vazia
        const handler = getHandler('torrent:get-peers')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
    });

    it('retorna ENGINE_RESTARTING quando motor está reiniciando', async () => {
        setup([{ infoHash: VALID_HASH, status: 'downloading' }], true);
        const handler = getHandler('torrent:get-peers')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
    });

    it('retorna INVALID_PARAMS para payload null', async () => {
        setup();
        const handler = getHandler('torrent:get-peers')!;
        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna lista vazia de peers quando getPeers retorna []', async () => {
        const { te } = setup();
        (te as any).getPeers.mockReturnValue([]);
        const handler = getHandler('torrent:get-peers')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual([]);
    });
});

// ─── Tests: torrent:get-pieces handler (Task 4.3) ─────────────────────────────

describe('registerIpcHandlers — torrent:get-pieces handler (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    const VALID_HASH = 'c'.repeat(40);
    const VALID_PIECES = [true, false, true, true, false, true];

    function setup(
        items: unknown[] = [{ infoHash: VALID_HASH, status: 'downloading' }],
        isRestarting = false,
    ) {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        (dm.getAll as jest.Mock).mockReturnValue(items);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(isRestarting);
        (te as any).getPieces = jest.fn().mockReturnValue(VALID_PIECES);
        registerIpcHandlers(dm, sm, te as any);
        return { dm, sm, te };
    }

    it('retorna lista de peças com sucesso', async () => {
        setup();
        const handler = getHandler('torrent:get-pieces')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual(VALID_PIECES);
    });

    it('retorna array vazio para torrent em resolving-metadata', async () => {
        setup([{ infoHash: VALID_HASH, status: 'resolving-metadata' }]);
        const handler = getHandler('torrent:get-pieces')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual([]);
    });

    it('retorna TORRENT_NOT_FOUND quando torrent não está na lista', async () => {
        setup([]); // lista vazia
        const handler = getHandler('torrent:get-pieces')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
    });

    it('retorna ENGINE_RESTARTING quando motor está reiniciando', async () => {
        setup([{ infoHash: VALID_HASH, status: 'downloading' }], true);
        const handler = getHandler('torrent:get-pieces')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.ENGINE_RESTARTING);
    });

    it('retorna INVALID_PARAMS para payload null', async () => {
        setup();
        const handler = getHandler('torrent:get-pieces')!;
        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(typeof response.error).toBe('string');
    });

    it('retorna erro quando getPieces lança exceção', async () => {
        const { te } = setup();
        (te as any).getPieces.mockImplementation(() => {
            throw new Error('Falha ao obter peças do torrent');
        });

        const handler = getHandler('torrent:get-pieces')!;
        const response = (await handler(null, { infoHash: VALID_HASH })) as any;

        expect(response.success).toBe(false);
        // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
        expect(response.error).toBe('error.operation.failed');
    });
});

// ─── Tests: withTimeout timeout path (Task 4.3) ───────────────────────────────

describe('registerIpcHandlers — withTimeout expiração de operação (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    it('retorna erro quando operação IPC expira após 30 segundos', async () => {
        jest.useFakeTimers();

        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        // pause nunca resolve — simula operação travada
        (dm.pause as jest.Mock).mockReturnValue(new Promise<void>(() => {}));

        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(false);
        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:pause')!;

        // Iniciar o handler (não await ainda — handler está bloqueado no pause)
        const p = handler(null, { infoHash: 'a'.repeat(40) });

        // Avançar o relógio além do timeout de 30s
        jest.advanceTimersByTime(31_000);

        // Agora aguardar a resposta — deve retornar o erro de timeout
        const response = (await p) as any;

        jest.useRealTimers();

        expect(response.success).toBe(false);
        // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
        expect(response.error).toBe('error.operation.failed');
    });
});

// ─── Tests: ChannelRateLimiter limit exceeded (Task 4.3) ──────────────────────

describe('registerIpcHandlers — ChannelRateLimiter limite excedido (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    it('retorna error.rateLimit quando canal excede 500 chamadas no mesmo segundo', async () => {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        // Preencher o rate limiter para o canal 'torrent:get-all' até o limite máximo (500)
        // _rateLimiter está exportado para fins de teste
        for (let i = 0; i < 500; i++) {
            _rateLimiter.tryConsume('torrent:get-all');
        }

        // A próxima chamada ao handler deve ser bloqueada pelo rate limiter
        const handler = getHandler('torrent:get-all')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe('error.rateLimit');
    });

    it('permite chamadas normais quando rate limiter está abaixo do limite', async () => {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        registerIpcHandlers(dm, sm);

        // Rate limiter foi resetado pelo afterEach — apenas algumas chamadas
        for (let i = 0; i < 10; i++) {
            _rateLimiter.tryConsume('settings:get');
        }

        // Chamada ao handler deve ser permitida
        const handler = getHandler('settings:get')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(true);
    });
});

// ─── Tests: torrent:add-file-buffer com tipos de buffer (Task 4.3) ────────────

describe('registerIpcHandlers — torrent:add-file-buffer tipos de buffer (Task 4.3)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    const MOCK_ITEM = {
        infoHash: 'a'.repeat(40),
        name: 'test.torrent',
        status: 'downloading',
        destinationFolder: '/downloads',
        totalSize: 0,
        downloadedSize: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: 0,
        addedAt: 0,
    };

    function setup() {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        (dm.addTorrentBuffer as jest.Mock).mockResolvedValue(MOCK_ITEM);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(false);
        registerIpcHandlers(dm, sm, te as any);
        return { dm };
    }

    it('aceita ArrayBuffer e retorna o item adicionado', async () => {
        const { dm } = setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        // Criar um ArrayBuffer com conteúdo válido (bencode começa com 'd')
        const arrayBuffer = new ArrayBuffer(8);
        new Uint8Array(arrayBuffer)[0] = 0x64; // 'd' — início de bencode válido

        const response = (await handler(null, { buffer: arrayBuffer })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual(MOCK_ITEM);
        expect(dm.addTorrentBuffer).toHaveBeenCalledTimes(1);
        // Verificar que o buffer passado é um Buffer Node.js (convertido de ArrayBuffer)
        const passedBuffer = (dm.addTorrentBuffer as jest.Mock).mock.calls[0][0];
        expect(Buffer.isBuffer(passedBuffer)).toBe(true);
    });

    it('aceita Buffer Node.js e retorna o item adicionado', async () => {
        const { dm } = setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const nodeBuffer = Buffer.from([0x64, 0x31, 0x3a]); // 'd1:' — início de bencode

        const response = (await handler(null, { buffer: nodeBuffer })) as any;

        expect(response.success).toBe(true);
        expect(dm.addTorrentBuffer).toHaveBeenCalledTimes(1);
    });

    it('aceita Uint8Array e retorna o item adicionado', async () => {
        const { dm } = setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const uint8Array = new Uint8Array([0x64, 0x00, 0x01, 0x02]);

        const response = (await handler(null, { buffer: uint8Array })) as any;

        expect(response.success).toBe(true);
        expect(dm.addTorrentBuffer).toHaveBeenCalledTimes(1);
    });

    it('rejeita buffer vazio (length === 0) com INVALID_FILE_PATH', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const emptyBuffer = Buffer.alloc(0);

        const response = (await handler(null, { buffer: emptyBuffer })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });

    it('rejeita ArrayBuffer vazio com INVALID_FILE_PATH', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const emptyArrayBuffer = new ArrayBuffer(0);

        const response = (await handler(null, { buffer: emptyArrayBuffer })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });

    it('rejeita payload sem campo buffer', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const response = (await handler(null, { wrongKey: 'value' })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });

    it('rejeita buffer com tipo inválido (string) com INVALID_FILE_PATH', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const response = (await handler(null, { buffer: 'not-a-buffer' })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });

    it('rejeita buffer com tipo inválido (número) com INVALID_FILE_PATH', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const response = (await handler(null, { buffer: 12345 })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });

    it('rejeita payload null', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });

    it('retorna erro quando addTorrentBuffer lança exceção', async () => {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        (dm.addTorrentBuffer as jest.Mock).mockRejectedValue(
            new Error('Arquivo .torrent corrompido'),
        );
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(false);
        registerIpcHandlers(dm, sm, te as any);

        const handler = getHandler('torrent:add-file-buffer')!;
        const nodeBuffer = Buffer.from([0x64, 0x31]);

        const response = (await handler(null, { buffer: nodeBuffer })) as any;

        expect(response.success).toBe(false);
        // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
        expect(response.error).toBe('error.operation.failed');
    });
});

// ─── Tests: torrent:add-file-buffer magic bytes (Tarefa 6.1) ─────────────────
// Req 4.1/4.5: o handler valida os magic bytes do buffer antes de passá-lo ao engine.

describe('registerIpcHandlers — torrent:add-file-buffer validação de magic bytes (Tarefa 6.1)', () => {
    function getHandler(
        channel: string,
    ): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
        const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
        return call
            ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>)
            : undefined;
    }

    const MOCK_ITEM = {
        infoHash: 'a'.repeat(40),
        name: 'test.torrent',
        status: 'downloading',
        destinationFolder: '/downloads',
        totalSize: 0,
        downloadedSize: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: 0,
        addedAt: 0,
    };

    function setup() {
        jest.clearAllMocks();
        const dm = makeMockDownloadManager();
        (dm.addTorrentBuffer as jest.Mock).mockResolvedValue(MOCK_ITEM);
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        (te as any).isRestarting = jest.fn().mockReturnValue(false);
        registerIpcHandlers(dm, sm, te as any);
        return { dm };
    }

    it('rejeita Buffer com primeiro byte diferente de 0x64 (não-bencode)', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        // Primeiro byte 0x50 ('P') — não é um dicionário bencode
        const invalidBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // ZIP magic bytes

        const response = (await handler(null, { buffer: invalidBuffer })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });

    it('rejeita Uint8Array com primeiro byte diferente de 0x64', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        // 0xFF não é início de bencode
        const invalidUint8Array = new Uint8Array([0xff, 0x00, 0x01]);

        const response = (await handler(null, { buffer: invalidUint8Array })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });

    it('aceita Buffer com primeiro byte 0x64 (bencode válido)', async () => {
        const { dm } = setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const validBuffer = Buffer.from([0x64, 0x31, 0x3a]); // 'd1:' — início de bencode

        const response = (await handler(null, { buffer: validBuffer })) as any;

        expect(response.success).toBe(true);
        expect(dm.addTorrentBuffer).toHaveBeenCalledTimes(1);
    });

    it('aceita Uint8Array com primeiro byte 0x64', async () => {
        const { dm } = setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const validUint8 = new Uint8Array([0x64, 0x65, 0x66]); // 'd' start

        const response = (await handler(null, { buffer: validUint8 })) as any;

        expect(response.success).toBe(true);
        expect(dm.addTorrentBuffer).toHaveBeenCalledTimes(1);
    });

    it('rejeita ArrayBuffer com primeiro byte diferente de 0x64', async () => {
        setup();
        const handler = getHandler('torrent:add-file-buffer')!;

        const arrayBuf = new ArrayBuffer(4);
        new Uint8Array(arrayBuf)[0] = 0x4d; // 'M' — não é bencode

        const response = (await handler(null, { buffer: arrayBuf })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_FILE_PATH);
    });
});

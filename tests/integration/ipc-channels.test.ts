// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Integration tests for IPC channels.
 *
 * Smoke tests for all registered IPC channels and verification that
 * malformed payloads return structured error responses.
 *
 * **Validates: Requirements 8.1, 8.5**
 */

import { EventEmitter } from 'events';
import { resolve as resolvePath } from 'path';
import { registerIpcHandlers } from '../../main/ipcHandler';
import { ErrorCodes } from '../../shared/errorCodes';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../main/settingsManager';
import type { DownloadItem, IPCResponse } from '../../shared/types';

// ─── Mock electron ────────────────────────────────────────────────────────────

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
    },
    dialog: {
        showOpenDialog: jest.fn(),
    },
}));

// Mock fs para validação de destinationFolder no handler settings:set
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn().mockReturnValue(true),
    accessSync: jest.fn(),
}));

const { ipcMain: mockIpcMain, dialog: mockDialog } = require('electron') as {
    ipcMain: { handle: jest.Mock };
    dialog: { showOpenDialog: jest.Mock };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
] as const;

function makeSampleDownloadItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
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
        ...overrides,
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

/**
 * Extract the handler function registered for a given IPC channel.
 */
function getHandler(
    channel: string,
): ((_event: unknown, payload?: unknown) => Promise<unknown>) | undefined {
    const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    return call ? (call[1] as (_event: unknown, payload?: unknown) => Promise<unknown>) : undefined;
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Integration: IPC Channels (Requirements 8.1, 8.5)', () => {
    let downloadManager: DownloadManager;
    let settingsManager: SettingsManager;
    let torrentEngine: ReturnType<typeof makeMockTorrentEngine>;

    beforeEach(() => {
        jest.clearAllMocks();
        downloadManager = makeMockDownloadManager();
        settingsManager = makeMockSettingsManager();
        torrentEngine = makeMockTorrentEngine();
        registerIpcHandlers(downloadManager, settingsManager, torrentEngine as any);
    });

    // ── Smoke tests: all channels registered ─────────────────────────────────

    describe('Smoke: all IPC channels are registered and respond', () => {
        it('registers exactly the expected IPC channels', () => {
            expect(mockIpcMain.handle).toHaveBeenCalledTimes(EXPECTED_CHANNELS.length);
        });

        it.each(EXPECTED_CHANNELS)('channel "%s" is registered', (channel) => {
            const registeredChannels = mockIpcMain.handle.mock.calls.map(
                (call: unknown[]) => call[0] as string,
            );
            expect(registeredChannels).toContain(channel);
        });

        it('torrent:add-file responds with { success: true } for valid payload', async () => {
            const handler = getHandler('torrent:add-file')!;
            const response = (await handler(null, {
                filePath: '/path/to/file.torrent',
            })) as IPCResponse<DownloadItem>;

            expect(response.success).toBe(true);
            expect(response).toHaveProperty('data');
        });

        it('torrent:add-magnet responds with { success: true } for valid payload', async () => {
            const handler = getHandler('torrent:add-magnet')!;
            const response = (await handler(null, {
                magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
            })) as IPCResponse<DownloadItem>;

            expect(response.success).toBe(true);
            expect(response).toHaveProperty('data');
        });

        it('torrent:pause responds with { success: true } for valid payload', async () => {
            const handler = getHandler('torrent:pause')!;
            const response = (await handler(null, {
                infoHash: 'a'.repeat(40),
            })) as IPCResponse<void>;

            expect(response.success).toBe(true);
        });

        it('torrent:resume responds with { success: true } for valid payload', async () => {
            const handler = getHandler('torrent:resume')!;
            const response = (await handler(null, {
                infoHash: 'a'.repeat(40),
            })) as IPCResponse<void>;

            expect(response.success).toBe(true);
        });

        it('torrent:remove responds with { success: true } for valid payload', async () => {
            const handler = getHandler('torrent:remove')!;
            const response = (await handler(null, {
                infoHash: 'a'.repeat(40),
                deleteFiles: false,
            })) as IPCResponse<void>;

            expect(response.success).toBe(true);
        });

        it('torrent:get-all responds with { success: true } and data array', async () => {
            const handler = getHandler('torrent:get-all')!;
            const response = (await handler(null)) as IPCResponse<DownloadItem[]>;

            expect(response.success).toBe(true);
            if (response.success) {
                expect(Array.isArray(response.data)).toBe(true);
            }
        });

        it('settings:get responds with { success: true } and settings object', async () => {
            const handler = getHandler('settings:get')!;
            const response = (await handler(null)) as IPCResponse<AppSettings>;

            expect(response.success).toBe(true);
            if (response.success) {
                expect(response.data).toHaveProperty('destinationFolder');
                expect(response.data).toHaveProperty('downloadSpeedLimit');
                expect(response.data).toHaveProperty('uploadSpeedLimit');
            }
        });

        it('settings:set responds with { success: true } for valid partial settings', async () => {
            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                downloadSpeedLimit: 500,
            })) as IPCResponse<AppSettings>;

            expect(response.success).toBe(true);
            expect(settingsManager.set).toHaveBeenCalledWith({ downloadSpeedLimit: 500 });
        });

        it('settings:select-folder responds with structured response', async () => {
            mockDialog.showOpenDialog.mockResolvedValue({
                canceled: false,
                filePaths: ['/selected/folder'],
            });

            const handler = getHandler('settings:select-folder')!;
            const response = (await handler(null)) as IPCResponse<string>;

            expect(response.success).toBe(true);
            if (response.success) {
                expect(response.data).toBe('/selected/folder');
            }
        });
    });

    // ── Valid payloads: verify interaction with managers ──────────────────────

    describe('Valid payloads: handlers delegate to correct managers', () => {
        it('torrent:add-file delegates to downloadManager.addTorrentFile', async () => {
            const handler = getHandler('torrent:add-file')!;
            await handler(null, { filePath: '/path/to/test.torrent' });

            // path.resolve normaliza o caminho antes de passá-lo ao manager (task 6.2)
            expect(downloadManager.addTorrentFile).toHaveBeenCalledWith(
                resolvePath('/path/to/test.torrent'),
            );
        });

        it('torrent:add-magnet delegates to downloadManager.addMagnetLink', async () => {
            const magnetUri = `magnet:?xt=urn:btih:${'b'.repeat(40)}`;
            const handler = getHandler('torrent:add-magnet')!;
            await handler(null, { magnetUri });

            expect(downloadManager.addMagnetLink).toHaveBeenCalledWith(magnetUri);
        });

        it('torrent:pause delegates to downloadManager.pause', async () => {
            const infoHash = 'c'.repeat(40);
            const handler = getHandler('torrent:pause')!;
            await handler(null, { infoHash });

            expect(downloadManager.pause).toHaveBeenCalledWith(infoHash);
        });

        it('torrent:resume delegates to downloadManager.resume', async () => {
            const infoHash = 'd'.repeat(40);
            const handler = getHandler('torrent:resume')!;
            await handler(null, { infoHash });

            expect(downloadManager.resume).toHaveBeenCalledWith(infoHash);
        });

        it('torrent:remove delegates to downloadManager.remove with deleteFiles flag', async () => {
            const infoHash = 'e'.repeat(40);
            const handler = getHandler('torrent:remove')!;
            await handler(null, { infoHash, deleteFiles: true });

            expect(downloadManager.remove).toHaveBeenCalledWith(infoHash, true);
        });

        it('torrent:get-all delegates to downloadManager.getAll', async () => {
            const handler = getHandler('torrent:get-all')!;
            await handler(null);

            expect(downloadManager.getAll).toHaveBeenCalled();
        });

        it('settings:get delegates to settingsManager.get', async () => {
            const handler = getHandler('settings:get')!;
            await handler(null);

            expect(settingsManager.get).toHaveBeenCalled();
        });

        it('settings:set delegates to settingsManager.set then settingsManager.get', async () => {
            const handler = getHandler('settings:set')!;
            await handler(null, { uploadSpeedLimit: 100 });

            expect(settingsManager.set).toHaveBeenCalledWith({ uploadSpeedLimit: 100 });
            expect(settingsManager.get).toHaveBeenCalled();
        });
    });

    // ── Malformed payloads: all return { success: false, error: string } ─────

    describe('Malformed payloads return { success: false, error: string }', () => {
        // Helper to assert structured error response
        async function expectStructuredError(channel: string, payload: unknown): Promise<void> {
            const handler = getHandler(channel)!;
            const response = (await handler(null, payload)) as { success: boolean; error?: string };

            expect(response).toBeDefined();
            expect(response.success).toBe(false);
            expect(typeof response.error).toBe('string');
            expect(response.error!.length).toBeGreaterThan(0);
        }

        // ── torrent:add-file ─────────────────────────────────────────────────

        describe('torrent:add-file', () => {
            it.each([
                ['null', null],
                ['undefined', undefined],
                ['empty object', {}],
                ['number', 42],
                ['string', 'not-an-object'],
                ['boolean', true],
                ['array', ['/path.torrent']],
                ['object with empty filePath', { filePath: '' }],
                ['object with numeric filePath', { filePath: 123 }],
                ['object with wrong key', { path: '/file.torrent' }],
            ])('rejects %s payload', async (_label, payload) => {
                await expectStructuredError('torrent:add-file', payload);
            });
        });

        // ── torrent:add-magnet ───────────────────────────────────────────────

        describe('torrent:add-magnet', () => {
            it.each([
                ['null', null],
                ['undefined', undefined],
                ['empty object', {}],
                ['number', 99],
                ['string', 'just-a-string'],
                ['boolean', false],
                ['array', ['magnet:?xt=urn:btih:abc']],
                ['object with empty magnetUri', { magnetUri: '' }],
                ['object with numeric magnetUri', { magnetUri: 42 }],
                ['object with wrong key', { uri: 'magnet:?xt=urn:btih:abc' }],
            ])('rejects %s payload', async (_label, payload) => {
                await expectStructuredError('torrent:add-magnet', payload);
            });
        });

        // ── torrent:pause ────────────────────────────────────────────────────

        describe('torrent:pause', () => {
            it.each([
                ['null', null],
                ['undefined', undefined],
                ['empty object', {}],
                ['number', 0],
                ['string', 'hash'],
                ['boolean', true],
                ['object with empty infoHash', { infoHash: '' }],
                ['object with numeric infoHash', { infoHash: 123 }],
            ])('rejects %s payload', async (_label, payload) => {
                await expectStructuredError('torrent:pause', payload);
            });
        });

        // ── torrent:resume ───────────────────────────────────────────────────

        describe('torrent:resume', () => {
            it.each([
                ['null', null],
                ['undefined', undefined],
                ['empty object', {}],
                ['number', 1],
                ['string', 'hash'],
                ['object with empty infoHash', { infoHash: '' }],
                ['object with numeric infoHash', { infoHash: 456 }],
            ])('rejects %s payload', async (_label, payload) => {
                await expectStructuredError('torrent:resume', payload);
            });
        });

        // ── torrent:remove ───────────────────────────────────────────────────

        describe('torrent:remove', () => {
            it.each([
                ['null', null],
                ['undefined', undefined],
                ['empty object', {}],
                ['number', 7],
                ['string', 'remove-me'],
                ['missing deleteFiles', { infoHash: 'a'.repeat(40) }],
                ['missing infoHash', { deleteFiles: true }],
                ['empty infoHash', { infoHash: '', deleteFiles: true }],
                ['numeric infoHash', { infoHash: 123, deleteFiles: false }],
                ['string deleteFiles', { infoHash: 'a'.repeat(40), deleteFiles: 'yes' }],
            ])('rejects %s payload', async (_label, payload) => {
                await expectStructuredError('torrent:remove', payload);
            });
        });

        // ── settings:set ─────────────────────────────────────────────────────

        describe('settings:set', () => {
            it.each([
                ['null', null],
                ['undefined', undefined],
                ['number', 42],
                ['string', 'settings'],
                ['boolean', true],
            ])('rejects %s payload', async (_label, payload) => {
                await expectStructuredError('settings:set', payload);
            });

            it.each([
                ['negative downloadSpeedLimit', { downloadSpeedLimit: -1 }],
                ['float downloadSpeedLimit', { downloadSpeedLimit: 1.5 }],
                ['NaN downloadSpeedLimit', { downloadSpeedLimit: NaN }],
                ['Infinity downloadSpeedLimit', { downloadSpeedLimit: Infinity }],
                ['negative uploadSpeedLimit', { uploadSpeedLimit: -10 }],
                ['float uploadSpeedLimit', { uploadSpeedLimit: 0.5 }],
                ['NaN uploadSpeedLimit', { uploadSpeedLimit: NaN }],
                ['Infinity uploadSpeedLimit', { uploadSpeedLimit: Infinity }],
            ])('rejects invalid speed limit: %s', async (_label, payload) => {
                await expectStructuredError('settings:set', payload);
            });

            it('rejects non-string destinationFolder', async () => {
                await expectStructuredError('settings:set', { destinationFolder: 123 });
            });
        });
    });

    // ── Settings channels: deeper integration ────────────────────────────────

    describe('Settings channels: get and set integration', () => {
        it('settings:get returns the current settings from settingsManager', async () => {
            const handler = getHandler('settings:get')!;
            const response = (await handler(null)) as IPCResponse<AppSettings>;

            expect(response.success).toBe(true);
            if (response.success) {
                expect(response.data).toEqual({
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
                });
            }
        });

        it('settings:set with valid downloadSpeedLimit calls set and returns updated settings', async () => {
            const updatedSettings: AppSettings = {
                destinationFolder: '/downloads',
                downloadSpeedLimit: 1024,
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
            (settingsManager.get as jest.Mock).mockReturnValue(updatedSettings);

            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                downloadSpeedLimit: 1024,
            })) as IPCResponse<AppSettings>;

            expect(response.success).toBe(true);
            if (response.success) {
                expect(response.data.downloadSpeedLimit).toBe(1024);
            }
            expect(settingsManager.set).toHaveBeenCalledWith({ downloadSpeedLimit: 1024 });
        });

        it('settings:set with valid uploadSpeedLimit calls set and returns updated settings', async () => {
            const updatedSettings: AppSettings = {
                destinationFolder: '/downloads',
                downloadSpeedLimit: 0,
                uploadSpeedLimit: 512,
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
            (settingsManager.get as jest.Mock).mockReturnValue(updatedSettings);

            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                uploadSpeedLimit: 512,
            })) as IPCResponse<AppSettings>;

            expect(response.success).toBe(true);
            if (response.success) {
                expect(response.data.uploadSpeedLimit).toBe(512);
            }
            expect(settingsManager.set).toHaveBeenCalledWith({ uploadSpeedLimit: 512 });
        });

        it('settings:set with valid destinationFolder calls set and returns updated settings', async () => {
            const updatedSettings: AppSettings = {
                destinationFolder: '/new/folder',
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
            (settingsManager.get as jest.Mock).mockReturnValue(updatedSettings);

            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                destinationFolder: '/new/folder',
            })) as IPCResponse<AppSettings>;

            expect(response.success).toBe(true);
            if (response.success) {
                expect(response.data.destinationFolder).toBe('/new/folder');
            }
            // path.resolve normaliza o caminho antes de persistir (task 6.2)
            expect(settingsManager.set).toHaveBeenCalledWith({
                destinationFolder: resolvePath('/new/folder'),
            });
        });

        it('settings:set with speed limit 0 (no limit) is accepted', async () => {
            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {
                downloadSpeedLimit: 0,
                uploadSpeedLimit: 0,
            })) as IPCResponse<AppSettings>;

            expect(response.success).toBe(true);
            expect(settingsManager.set).toHaveBeenCalledWith({
                downloadSpeedLimit: 0,
                uploadSpeedLimit: 0,
            });
        });

        it('settings:set with empty object is accepted (no changes)', async () => {
            const handler = getHandler('settings:set')!;
            const response = (await handler(null, {})) as IPCResponse<AppSettings>;

            expect(response.success).toBe(true);
        });

        it('settings:select-folder returns error when dialog is canceled', async () => {
            mockDialog.showOpenDialog.mockResolvedValue({
                canceled: true,
                filePaths: [],
            });

            const handler = getHandler('settings:select-folder')!;
            const response = (await handler(null)) as IPCResponse<string>;

            expect(response.success).toBe(false);
            if (!response.success) {
                expect(typeof response.error).toBe('string');
            }
        });
    });

    // ── Error propagation: manager throws → structured error ─────────────────

    describe('Manager errors are caught and returned as structured errors', () => {
        it('torrent:add-file catches manager error and returns { success: false }', async () => {
            (downloadManager.addTorrentFile as jest.Mock).mockRejectedValue(
                new Error('Arquivo inválido'),
            );

            const handler = getHandler('torrent:add-file')!;
            const response = (await handler(null, {
                filePath: '/bad/file.torrent',
            })) as IPCResponse<never>;

            expect(response.success).toBe(false);
            if (!response.success) {
                expect(response.error).toBe(ErrorCodes.OPERATION_FAILED);
            }
        });

        it('torrent:add-magnet catches manager error and returns { success: false }', async () => {
            (downloadManager.addMagnetLink as jest.Mock).mockRejectedValue(
                new Error('Torrent já existe na lista'),
            );

            const handler = getHandler('torrent:add-magnet')!;
            const response = (await handler(null, {
                magnetUri: `magnet:?xt=urn:btih:${'f'.repeat(40)}`,
            })) as IPCResponse<never>;

            expect(response.success).toBe(false);
            if (!response.success) {
                expect(response.error).toBe(ErrorCodes.OPERATION_FAILED);
            }
        });

        it('torrent:pause catches manager error and returns { success: false }', async () => {
            (downloadManager.pause as jest.Mock).mockRejectedValue(
                new Error('Falha ao pausar: timeout'),
            );

            const handler = getHandler('torrent:pause')!;
            const response = (await handler(null, {
                infoHash: 'a'.repeat(40),
            })) as IPCResponse<never>;

            expect(response.success).toBe(false);
            if (!response.success) {
                expect(response.error).toBe(ErrorCodes.OPERATION_FAILED);
            }
        });

        it('settings:get catches manager error and returns { success: false }', async () => {
            (settingsManager.get as jest.Mock).mockImplementation(() => {
                throw new Error('Store corrupted');
            });

            const handler = getHandler('settings:get')!;
            const response = (await handler(null)) as IPCResponse<never>;

            expect(response.success).toBe(false);
            if (!response.success) {
                expect(response.error).toBe(ErrorCodes.OPERATION_FAILED);
            }
        });
    });
});

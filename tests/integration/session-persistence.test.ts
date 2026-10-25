/**
 * Integration tests for session persistence.
 *
 * Tests the interaction between DownloadManager, SettingsManager, and the
 * persisted store to verify the full round-trip:
 *   add downloads → persist session → create new manager → restore → verify state
 *
 * **Validates: Requirements 7.1, 7.2, 7.3, 7.4**
 */

import { EventEmitter } from 'events';
import { ipcMain } from 'electron';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, rmdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDownloadManager } from '../../main/downloadManager';
import { registerIpcHandlers } from '../../main/ipcHandler';
import { createSettingsManager } from '../../main/settingsManager';
import type { TorrentEngine, TorrentInfo, TorrentStatus } from '../../main/torrentEngine';
import type { PersistedDownloadItem, PersistedStore } from '../../main/downloadManager';
import type { SettingsStore } from '../../main/settingsManager';
import type { IPCResponse, TorrentFileInfo, TorrentMetadata } from '../../shared/types';
import { ErrorCodes } from '../../shared/errorCodes';

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() }, dialog: {} }));
jest.mock('../../main/rendererSecurity', () => ({ isTrustedIpcSender: jest.fn(() => true) }));

// ─── FS Mocks (hoisted by Jest) ───────────────────────────────────────────────

import { existsSync, accessSync } from 'fs';

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(),
    accessSync: jest.fn(),
}));

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockAccessSync = accessSync as jest.MockedFunction<typeof accessSync>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTorrentInfo(overrides: Partial<TorrentInfo> = {}): TorrentInfo {
    return {
        infoHash: 'a'.repeat(40),
        name: 'Default Torrent',
        totalSize: 1_000_000,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: Infinity,
        downloaded: 0,
        status: 'downloading' as TorrentStatus,
        ...overrides,
    };
}

/**
 * Creates a mock TorrentEngine that is also an EventEmitter so tests can
 * manually emit 'progress', 'done', and 'error' events.
 */
function makeMockEngine(): TorrentEngine & EventEmitter {
    const emitter = new EventEmitter();

    const engine: TorrentEngine & EventEmitter = Object.assign(emitter, {
        addTorrentFile: jest.fn().mockResolvedValue(makeTorrentInfo()),

        detachTorrent: jest.fn().mockResolvedValue(undefined),

        getTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn().mockResolvedValue(makeTorrentInfo()),
        addMagnetLink: jest
            .fn()
            .mockResolvedValue(makeTorrentInfo({ status: 'resolving-metadata' as TorrentStatus })),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        setDownloadSpeedLimit: jest.fn(),
        setUploadSpeedLimit: jest.fn(),
        getAll: jest.fn().mockReturnValue([]),
        getFiles: jest.fn().mockReturnValue([]),
        setFileSelection: jest.fn().mockReturnValue([]),
        getTrackers: jest.fn().mockReturnValue([]),
        addTracker: jest.fn(),
        removeTracker: jest.fn(),
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
    });

    return engine;
}

/**
 * Creates a mock PersistedStore backed by an in-memory map, simulating
 * electron-store behavior for integration testing.
 */
function makeMockStore(initial: PersistedDownloadItem[] = []): PersistedStore {
    const data = new Map<string, unknown>();
    if (initial.length > 0) {
        data.set('downloads', initial);
    }
    return {
        get: jest.fn().mockImplementation((key: string) => data.get(key)),
        set: jest.fn().mockImplementation((key: string, value: unknown) => {
            data.set(key, value);
        }),
    };
}

/**
 * Creates a mock SettingsStore backed by an in-memory map, simulating
 * electron-store behavior for the SettingsManager.
 */
function makeMockSettingsStore(initialFolder = '/downloads'): SettingsStore {
    const data = new Map<string, unknown>();
    data.set('destinationFolder', initialFolder);
    data.set('downloadSpeedLimit', 0);
    data.set('uploadSpeedLimit', 0);
    data.set('schemaVersion', 1);
    // Estes cenários isolam a restauração de downloads sem seeding automático.
    data.set('seedingEnabled', false);
    return {
        get: jest.fn().mockImplementation((key: string) => data.get(key)),
        set: jest.fn().mockImplementation((key: string, value: unknown) => data.set(key, value)),
        setMany: jest.fn((values) => {
            for (const [key, value] of Object.entries(values)) data.set(key, value);
        }),
    };
}

// ─── Integration Tests ───────────────────────────────────────────────────────

describe('Integration: Session Persistence (Requirements 7.1, 7.2, 7.3, 7.4)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // ── Requirement 7.1, 7.2: Full round-trip ────────────────────────────────

    it.each(['engine', 'arquivos'])(
        'preserva falha na remoção (%s) e permite excluir pelo IPC após restaurar sem torrent na engine',
        async (failureAt) => {
            const root = await mkdtemp(join(tmpdir(), 'meshy-removal-test-'));
            if (!root.startsWith(join(tmpdir(), 'meshy-removal-test-')))
                throw new Error('Alvo temporário inesperado');
            try {
                await writeFile(join(root, 'a.bin'), 'hello');
                await writeFile(join(root, 'keep.txt'), 'keep');
                if (failureAt === 'arquivos') await mkdir(join(root, 'b.bin'));
                else await writeFile(join(root, 'b.bin'), 'other');
                const hash = 'a'.repeat(40);
                const metadata = Buffer.from('de');
                const files: TorrentFileInfo[] = [0, 1].map((index) => ({
                    index,
                    name: index === 0 ? 'a.bin' : 'b.bin',
                    path: index === 0 ? 'a.bin' : 'b.bin',
                    length: 5,
                    downloaded: 5,
                    selected: index === 0,
                }));
                const settings = createSettingsManager({
                    store: makeMockSettingsStore(root),
                    getDownloadsPath: () => root,
                });
                const store = makeMockStore([
                    {
                        infoHash: hash,
                        name: 'test',
                        destinationFolder: root,
                        totalSize: 5,
                        downloadedSize: 5,
                        progress: 1,
                        status: 'paused',
                        addedAt: 1,
                        selectedFileIndices: [0],
                    },
                ]);
                const engine = makeMockEngine();
                let live = true;
                jest.mocked(engine.getFiles).mockImplementation(() => {
                    if (!live) throw new Error('Torrent ausente');
                    return files;
                });
                jest.mocked(engine.getTorrentFile).mockImplementation(() =>
                    live ? metadata : undefined,
                );
                jest.mocked(engine.remove).mockImplementationOnce(async () => {
                    // O WebTorrent já descartou o torrent quando informa a falha.
                    live = false;
                    if (failureAt === 'engine') throw new Error('EACCES');
                });
                const manager = createDownloadManager(engine, settings, store, undefined, {
                    disableCleanupTimer: true,
                });
                await manager.restoreSession();
                registerIpcHandlers(manager, settings, engine);
                const remove = jest
                    .mocked(ipcMain.handle)
                    .mock.calls.find(([channel]) => channel === 'torrent:remove')![1];
                expect(
                    await remove({} as Electron.IpcMainInvokeEvent, {
                        infoHash: hash,
                        deleteFiles: true,
                    }),
                ).toEqual({ success: false, error: ErrorCodes.OPERATION_FAILED });
                expect(manager.getAll()[0]).toMatchObject({ infoHash: hash, status: 'error' });
                expect(store.get('downloads')?.[0]).toMatchObject({
                    infoHash: hash,
                    status: 'error',
                    errorMessage: ErrorCodes.OPERATION_FAILED,
                    files,
                    selectedFileIndices: [0],
                    torrentFileBase64: metadata.toString('base64'),
                });
                if (failureAt === 'arquivos') {
                    expect(await readdir(root)).toEqual(['b.bin', 'keep.txt']);
                    await rmdir(join(root, 'b.bin'));
                    await writeFile(join(root, 'b.bin'), 'other');
                }

                const restoredEngine = makeMockEngine();
                const restored = createDownloadManager(restoredEngine, settings, store, undefined, {
                    disableCleanupTimer: true,
                });
                await restored.restoreSession();
                expect(restoredEngine.addTorrentBuffer).not.toHaveBeenCalled();
                expect(restored.getFiles(hash)).toEqual(files);
                jest.mocked(ipcMain.handle).mockClear();
                registerIpcHandlers(restored, settings, restoredEngine);
                const retry = jest
                    .mocked(ipcMain.handle)
                    .mock.calls.find(([channel]) => channel === 'torrent:remove')![1];

                expect(
                    await retry({} as Electron.IpcMainInvokeEvent, {
                        infoHash: hash,
                        deleteFiles: true,
                    }),
                ).toEqual({ success: true, data: undefined });
                expect(await readdir(root)).toEqual(['keep.txt']);
                expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
                expect(restored.getAll()).toEqual([]);
                expect(store.get('downloads')).toEqual([]);
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
    );

    it('persiste a seleção alterada via IPC antes de responder e a reaplica após reiniciar', async () => {
        const hash = 'a'.repeat(40);
        const metadata = Buffer.from('de');
        const files: TorrentFileInfo[] = [
            { index: 0, name: 'a.bin', path: 'a.bin', length: 100, downloaded: 50, selected: true },
            {
                index: 1,
                name: 'b.bin',
                path: 'b.bin',
                length: 300,
                downloaded: 60,
                selected: false,
            },
        ];
        const settings = createSettingsManager({
            store: makeMockSettingsStore(),
            getDownloadsPath: () => '/downloads',
        });
        const store = makeMockStore([
            {
                infoHash: hash,
                name: 'test',
                totalSize: 100,
                downloadedSize: 50,
                progress: 0.5,
                status: 'downloading',
                destinationFolder: '/downloads',
                addedAt: 1,
                selectedFileIndices: [0],
                torrentFileBase64: metadata.toString('base64'),
            },
        ]);
        const engine = makeMockEngine();
        let currentFiles = files.map((file) => ({ ...file }));
        jest.mocked(engine.getFiles).mockImplementation(() => currentFiles);
        jest.mocked(engine.setFileSelection).mockImplementation((_hash, indices) => {
            currentFiles = currentFiles.map((file) => ({
                ...file,
                selected: indices.includes(file.index),
            }));
            return currentFiles;
        });
        const manager = createDownloadManager(engine, settings, store, undefined, {
            disableCleanupTimer: true,
        });
        await manager.restoreSession();
        registerIpcHandlers(manager, settings, engine);
        const handler = jest
            .mocked(ipcMain.handle)
            .mock.calls.find(([channel]) => channel === 'torrent:set-file-selection')![1];

        const response = (await handler({} as Electron.IpcMainInvokeEvent, {
            infoHash: hash,
            selectedIndices: [1],
        })) as IPCResponse<TorrentFileInfo[]>;

        expect(response).toEqual({ success: true, data: currentFiles });
        expect(manager.getAll()[0]).toMatchObject({
            totalSize: 300,
            downloadedSize: 60,
            progress: 0.2,
            selectedFileCount: 1,
        });
        // Sem persistSession adicional: o comando precisa confirmar uma seleção já salva.
        expect(store.get('downloads')?.[0]).toMatchObject({
            selectedFileIndices: [1],
            totalSize: 300,
            downloadedSize: 60,
            progress: 0.2,
        });

        const restoredEngine = makeMockEngine();
        const selectedFiles = files.map((file) => ({ ...file, selected: file.index === 1 }));
        jest.mocked(restoredEngine.getFiles).mockReturnValue(selectedFiles);
        jest.mocked(restoredEngine.setFileSelection).mockReturnValue(selectedFiles);
        const restoredManager = createDownloadManager(restoredEngine, settings, store, undefined, {
            disableCleanupTimer: true,
        });
        await restoredManager.restoreSession();

        expect(restoredEngine.addTorrentBuffer).toHaveBeenCalledWith(metadata, false, {
            destinationFolder: '/downloads',
            selectedFileIndices: [1],
        });
        expect(restoredEngine.setFileSelection).toHaveBeenCalledWith(hash, [1]);
        expect(restoredManager.getFiles(hash).map((file) => file.selected)).toEqual([false, true]);
    });

    it.each(['downloading', 'paused', 'queued'] as const)(
        'restaura metadados salvos sem magnet ou caminho .torrent no estado %s',
        async (status) => {
            jest.useFakeTimers();
            const hash = 'a'.repeat(40);
            const metadata = Buffer.from('d4:infod4:name4:testee');
            const settings = createSettingsManager({
                store: makeMockSettingsStore('/downloads'),
                getDownloadsPath: () => '/downloads',
            });
            const store = makeMockStore([
                {
                    infoHash: hash,
                    name: 'test',
                    totalSize: 100,
                    downloadedSize: 20,
                    progress: 0.2,
                    status,
                    destinationFolder: '/downloads',
                    addedAt: 1,
                    selectedFileIndices: [0],
                    torrentFileBase64: metadata.toString('base64'),
                },
            ]);
            const engine = makeMockEngine();
            (engine.addTorrentBuffer as jest.Mock).mockResolvedValue(
                makeTorrentInfo({ infoHash: hash }),
            );
            const manager = createDownloadManager(engine, settings, store, undefined, {
                disableCleanupTimer: true,
            });
            await manager.restoreSession();
            if (status !== 'downloading') {
                expect(engine.addTorrentBuffer).not.toHaveBeenCalled();
                (engine.resume as jest.Mock).mockRejectedValueOnce(new Error('Torrent ausente'));
                await manager.resume(hash);
            }
            expect(engine.addTorrentBuffer).toHaveBeenCalledWith(metadata, false, {
                destinationFolder: '/downloads',
                selectedFileIndices: [0],
            });
            expect(engine.addMagnetLink).not.toHaveBeenCalled();
            expect(manager.getAll()[0].status).toBe('downloading');
            manager.persistSession();
            expect(store.get('downloads')?.[0]).toMatchObject({
                torrentFileBase64: metadata.toString('base64'),
                selectedFileIndices: [0],
            });
        },
    );

    describe('Full round-trip: add → persist → restore → verify', () => {
        it('persists and restores a torrent file download with correct state', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const store = makeMockStore();
            const engine1 = makeMockEngine();

            const torrentInfo = makeTorrentInfo({
                infoHash: 'aabb'.padEnd(40, '0'),
                name: 'Ubuntu ISO',
                totalSize: 2_500_000_000,
                status: 'downloading' as TorrentStatus,
            });
            (engine1.addTorrentFile as jest.Mock).mockResolvedValue(torrentInfo);

            // Phase 1: Add a torrent file download
            const manager1 = createDownloadManager(engine1, settings, store);
            const added = await manager1.addTorrentFile('/path/to/ubuntu.torrent');

            expect(added.infoHash).toBe('aabb'.padEnd(40, '0'));
            expect(added.name).toBe('Ubuntu ISO');
            expect(added.status).toBe('downloading');

            // Phase 2: Simulate app shutdown — persist session
            manager1.persistSession();

            // Phase 3: Simulate app restart — create new manager and restore
            const engine2 = makeMockEngine();
            // The item was 'downloading', so restoreSession will try to re-add it.
            // Since there's no magnetUri or torrentFilePath in the persisted data,
            // neither addMagnetLink nor addTorrentFile will be called, and the item
            // will remain with status 'downloading' from the restore logic.
            const manager2 = createDownloadManager(engine2, settings, store);
            await manager2.restoreSession();

            // Phase 4: Verify restored state
            const restored = manager2.getAll();
            expect(restored).toHaveLength(1);
            expect(restored[0].infoHash).toBe('aabb'.padEnd(40, '0'));
            expect(restored[0].name).toBe('Ubuntu ISO');
            expect(restored[0].totalSize).toBe(2_500_000_000);
            expect(restored[0].destinationFolder).toBe('/downloads');
            expect(restored[0].addedAt).toBe(added.addedAt);
            // Runtime fields reset to defaults on restore
            expect(restored[0].downloadSpeed).toBe(0);
            expect(restored[0].uploadSpeed).toBe(0);
            expect(restored[0].numPeers).toBe(0);
        });

        it('persists and restores a magnet link download with correct state', async () => {
            jest.useFakeTimers();

            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const store = makeMockStore();
            const engine1 = makeMockEngine();

            const magnetHash = 'ccdd'.padEnd(40, '0');
            const magnetUri = `magnet:?xt=urn:btih:${magnetHash}`;
            const magnetInfo = makeTorrentInfo({
                infoHash: magnetHash,
                name: magnetHash,
                totalSize: 0,
                status: 'resolving-metadata' as TorrentStatus,
            });
            (engine1.addMagnetLink as jest.Mock).mockResolvedValue(magnetInfo);

            // Phase 1: Add a magnet link
            const manager1 = createDownloadManager(engine1, settings, store);
            const added = await manager1.addMagnetLink(magnetUri);

            expect(added.status).toBe('resolving-metadata');

            // Phase 2: Persist session
            manager1.persistSession();

            // Phase 3: Restore in a new manager
            const engine2 = makeMockEngine();
            const manager2 = createDownloadManager(engine2, settings, store);
            await manager2.restoreSession();

            // Phase 4: Verify
            const restored = manager2.getAll();
            expect(restored).toHaveLength(1);
            expect(restored[0].infoHash).toBe(magnetHash);
            expect(restored[0].status).toBe('resolving-metadata');
            expect(restored[0].addedAt).toBe(added.addedAt);
        });

        it('persists and restores multiple downloads of mixed types', async () => {
            jest.useFakeTimers();

            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const store = makeMockStore();
            const engine1 = makeMockEngine();

            // Add a torrent file
            const torrentHash = '1111'.padEnd(40, '0');
            const torrentInfo = makeTorrentInfo({
                infoHash: torrentHash,
                name: 'Torrent File Download',
                totalSize: 500_000,
                status: 'downloading' as TorrentStatus,
            });
            (engine1.addTorrentFile as jest.Mock).mockResolvedValue(torrentInfo);

            // Add a magnet link
            const magnetHash = '2222'.padEnd(40, '0');
            const magnetUri = `magnet:?xt=urn:btih:${magnetHash}`;
            const magnetInfo = makeTorrentInfo({
                infoHash: magnetHash,
                name: magnetHash,
                totalSize: 0,
                status: 'resolving-metadata' as TorrentStatus,
            });
            (engine1.addMagnetLink as jest.Mock).mockResolvedValue(magnetInfo);

            const manager1 = createDownloadManager(engine1, settings, store);
            await manager1.addTorrentFile('/path/to/file.torrent');
            await manager1.addMagnetLink(magnetUri);

            expect(manager1.getAll()).toHaveLength(2);

            // Persist
            manager1.persistSession();

            // Restore in a new manager
            const engine2 = makeMockEngine();
            const manager2 = createDownloadManager(engine2, settings, store);
            await manager2.restoreSession();

            const restored = manager2.getAll();
            expect(restored).toHaveLength(2);

            const restoredTorrent = restored.find((i) => i.infoHash === torrentHash);
            const restoredMagnet = restored.find((i) => i.infoHash === magnetHash);

            expect(restoredTorrent).toBeDefined();
            expect(restoredTorrent!.name).toBe('Torrent File Download');

            expect(restoredMagnet).toBeDefined();
            expect(restoredMagnet!.infoHash).toBe(magnetHash);
        });
    });

    // ── Requirement 7.3: Auto-resume ─────────────────────────────────────────

    describe('Auto-resume: downloading items are re-added to engine after restore', () => {
        it('auto-resumes items with status downloading via magnetUri', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const downloadingHash = 'aaaa'.padEnd(40, '0');
            const magnetUri = `magnet:?xt=urn:btih:${downloadingHash}`;

            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: downloadingHash,
                    name: 'Active Download',
                    totalSize: 1_000_000,
                    downloadedSize: 500_000,
                    progress: 0.5,
                    status: 'downloading',
                    destinationFolder: '/downloads',
                    addedAt: Date.now() - 60_000,
                    magnetUri,
                },
            ];

            const store = makeMockStore(persistedItems);
            const engine = makeMockEngine();

            // Configure engine to accept the re-add
            (engine.addMagnetLink as jest.Mock).mockResolvedValue(
                makeTorrentInfo({
                    infoHash: downloadingHash,
                    status: 'downloading' as TorrentStatus,
                }),
            );

            const manager = createDownloadManager(engine, settings, store);
            await manager.restoreSession();

            // Engine should have been called to re-add the downloading item
            expect(engine.addMagnetLink).toHaveBeenCalledWith(magnetUri, false, {
                destinationFolder: '/downloads',
            });

            const all = manager.getAll();
            expect(all).toHaveLength(1);
            expect(all[0].status).toBe('downloading');
        });

        it('auto-resumes items with status downloading via torrentFilePath', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const downloadingHash = 'bbbb'.padEnd(40, '0');
            const torrentFilePath = '/path/to/active.torrent';

            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: downloadingHash,
                    name: 'Active Torrent File',
                    totalSize: 2_000_000,
                    downloadedSize: 1_000_000,
                    progress: 0.5,
                    status: 'downloading',
                    destinationFolder: '/downloads',
                    addedAt: Date.now() - 30_000,
                    torrentFilePath,
                },
            ];

            const store = makeMockStore(persistedItems);
            const engine = makeMockEngine();

            (engine.addTorrentFile as jest.Mock).mockResolvedValue(
                makeTorrentInfo({
                    infoHash: downloadingHash,
                    status: 'downloading' as TorrentStatus,
                }),
            );

            const manager = createDownloadManager(engine, settings, store);
            await manager.restoreSession();

            expect(engine.addTorrentFile).toHaveBeenCalledWith(torrentFilePath, false, {
                destinationFolder: '/downloads',
            });

            const all = manager.getAll();
            expect(all).toHaveLength(1);
            expect(all[0].status).toBe('downloading');
        });

        it('does NOT auto-resume paused, completed, or error items', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: 'pppp'.padEnd(40, '0'),
                    name: 'Paused Download',
                    totalSize: 1_000_000,
                    downloadedSize: 250_000,
                    progress: 0.25,
                    status: 'paused',
                    destinationFolder: '/downloads',
                    addedAt: Date.now() - 120_000,
                    magnetUri: `magnet:?xt=urn:btih:${'pppp'.padEnd(40, '0')}`,
                },
                {
                    infoHash: 'cccc'.padEnd(40, '0'),
                    name: 'Completed Download',
                    totalSize: 3_000_000,
                    downloadedSize: 3_000_000,
                    progress: 1,
                    status: 'completed',
                    destinationFolder: '/downloads',
                    addedAt: Date.now() - 300_000,
                    completedAt: Date.now() - 100_000,
                    magnetUri: `magnet:?xt=urn:btih:${'cccc'.padEnd(40, '0')}`,
                },
                {
                    infoHash: 'eeee'.padEnd(40, '0'),
                    name: 'Error Download',
                    totalSize: 500_000,
                    downloadedSize: 100_000,
                    progress: 0.2,
                    status: 'error',
                    destinationFolder: '/downloads',
                    addedAt: Date.now() - 200_000,
                    magnetUri: `magnet:?xt=urn:btih:${'eeee'.padEnd(40, '0')}`,
                },
            ];

            const store = makeMockStore(persistedItems);
            const engine = makeMockEngine();

            const manager = createDownloadManager(engine, settings, store);
            await manager.restoreSession();

            // Engine should NOT have been called to re-add any of these
            expect(engine.addMagnetLink).not.toHaveBeenCalled();
            expect(engine.addTorrentFile).not.toHaveBeenCalled();

            const all = manager.getAll();
            expect(all).toHaveLength(3);
            expect(all.find((i) => i.infoHash === 'pppp'.padEnd(40, '0'))!.status).toBe('paused');
            expect(all.find((i) => i.infoHash === 'cccc'.padEnd(40, '0'))!.status).toBe(
                'completed',
            );
            expect(all.find((i) => i.infoHash === 'eeee'.padEnd(40, '0'))!.status).toBe('error');
        });
    });

    // ── Requirement 7.4: Missing files ───────────────────────────────────────

    describe('Missing files: items with non-existent destination get files-not-found', () => {
        it('marks non-completed items as files-not-found when destination folder is missing', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: 'ffff'.padEnd(40, '0'),
                    name: 'Missing Folder Download',
                    totalSize: 1_000_000,
                    downloadedSize: 500_000,
                    progress: 0.5,
                    status: 'paused',
                    destinationFolder: '/nonexistent/path',
                    addedAt: Date.now() - 60_000,
                },
            ];

            const store = makeMockStore(persistedItems);
            const engine = makeMockEngine();

            // Destination folder does NOT exist
            mockExistsSync.mockReturnValue(false);

            const manager = createDownloadManager(engine, settings, store);
            await manager.restoreSession();

            const all = manager.getAll();
            expect(all).toHaveLength(1);
            expect(all[0].status).toBe('files-not-found');
            expect(all[0].infoHash).toBe('ffff'.padEnd(40, '0'));
        });

        it('does NOT mark completed items as files-not-found even when folder is missing', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: 'gggg'.padEnd(40, '0'),
                    name: 'Completed Download',
                    totalSize: 2_000_000,
                    downloadedSize: 2_000_000,
                    progress: 1,
                    status: 'completed',
                    destinationFolder: '/nonexistent/path',
                    addedAt: Date.now() - 300_000,
                    completedAt: Date.now() - 100_000,
                },
            ];

            const store = makeMockStore(persistedItems);
            const engine = makeMockEngine();

            // Destination folder does NOT exist
            mockExistsSync.mockReturnValue(false);

            const manager = createDownloadManager(engine, settings, store);
            await manager.restoreSession();

            const all = manager.getAll();
            expect(all).toHaveLength(1);
            expect(all[0].status).toBe('completed');
        });

        it('downloading items with missing folder get files-not-found and are NOT auto-resumed', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const downloadingHash = 'hhhh'.padEnd(40, '0');
            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: downloadingHash,
                    name: 'Download With Missing Folder',
                    totalSize: 1_000_000,
                    downloadedSize: 500_000,
                    progress: 0.5,
                    status: 'downloading',
                    destinationFolder: '/nonexistent/path',
                    addedAt: Date.now() - 60_000,
                    magnetUri: `magnet:?xt=urn:btih:${downloadingHash}`,
                },
            ];

            const store = makeMockStore(persistedItems);
            const engine = makeMockEngine();

            // Destination folder does NOT exist
            mockExistsSync.mockReturnValue(false);

            const manager = createDownloadManager(engine, settings, store);
            await manager.restoreSession();

            // Should NOT have tried to re-add to engine
            expect(engine.addMagnetLink).not.toHaveBeenCalled();
            expect(engine.addTorrentFile).not.toHaveBeenCalled();

            const all = manager.getAll();
            expect(all).toHaveLength(1);
            expect(all[0].status).toBe('files-not-found');
        });
    });

    // ── Mixed statuses ───────────────────────────────────────────────────────

    describe('Mixed statuses: various statuses handled correctly after restore', () => {
        it('handles a mix of downloading, paused, completed, error, and missing-folder items', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const downloadingHash = 'aaaa'.padEnd(40, '0');
            const pausedHash = 'bbbb'.padEnd(40, '0');
            const completedHash = 'cccc'.padEnd(40, '0');
            const errorHash = 'dddd'.padEnd(40, '0');
            const missingFolderHash = 'eeee'.padEnd(40, '0');

            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: downloadingHash,
                    name: 'Downloading Item',
                    totalSize: 1_000_000,
                    downloadedSize: 500_000,
                    progress: 0.5,
                    status: 'downloading',
                    destinationFolder: '/downloads',
                    addedAt: 1_000_000,
                    magnetUri: `magnet:?xt=urn:btih:${downloadingHash}`,
                },
                {
                    infoHash: pausedHash,
                    name: 'Paused Item',
                    totalSize: 2_000_000,
                    downloadedSize: 1_000_000,
                    progress: 0.5,
                    status: 'paused',
                    destinationFolder: '/downloads',
                    addedAt: 2_000_000,
                },
                {
                    infoHash: completedHash,
                    name: 'Completed Item',
                    totalSize: 3_000_000,
                    downloadedSize: 3_000_000,
                    progress: 1,
                    status: 'completed',
                    destinationFolder: '/downloads',
                    addedAt: 3_000_000,
                    completedAt: 3_500_000,
                    elapsedMs: 500_000,
                },
                {
                    infoHash: errorHash,
                    name: 'Error Item',
                    totalSize: 500_000,
                    downloadedSize: 100_000,
                    progress: 0.2,
                    status: 'error',
                    destinationFolder: '/downloads',
                    addedAt: 4_000_000,
                },
                {
                    infoHash: missingFolderHash,
                    name: 'Missing Folder Item',
                    totalSize: 750_000,
                    downloadedSize: 200_000,
                    progress: 0.27,
                    status: 'paused',
                    destinationFolder: '/nonexistent/folder',
                    addedAt: 5_000_000,
                },
            ];

            const store = makeMockStore(persistedItems);
            const engine = makeMockEngine();

            // Configure engine for the downloading item's auto-resume
            (engine.addMagnetLink as jest.Mock).mockResolvedValue(
                makeTorrentInfo({
                    infoHash: downloadingHash,
                    status: 'downloading' as TorrentStatus,
                }),
            );

            // existsSync: return true for /downloads, false for /nonexistent/folder
            mockExistsSync.mockImplementation((path: unknown) => {
                return path !== '/nonexistent/folder';
            });

            const manager = createDownloadManager(engine, settings, store);
            await manager.restoreSession();

            const all = manager.getAll();
            expect(all).toHaveLength(5);

            // Downloading item: auto-resumed → status downloading
            const downloading = all.find((i) => i.infoHash === downloadingHash);
            expect(downloading).toBeDefined();
            expect(downloading!.status).toBe('downloading');
            expect(engine.addMagnetLink).toHaveBeenCalledWith(
                `magnet:?xt=urn:btih:${downloadingHash}`,
                false,
                { destinationFolder: '/downloads' },
            );

            // Paused item: stays paused (folder exists)
            const paused = all.find((i) => i.infoHash === pausedHash);
            expect(paused).toBeDefined();
            expect(paused!.status).toBe('paused');

            // Completed item: stays completed
            const completed = all.find((i) => i.infoHash === completedHash);
            expect(completed).toBeDefined();
            expect(completed!.status).toBe('completed');
            expect(completed!.completedAt).toBe(3_500_000);
            expect(completed!.elapsedMs).toBe(500_000);

            // Error item: stays error (folder exists)
            const errorItem = all.find((i) => i.infoHash === errorHash);
            expect(errorItem).toBeDefined();
            expect(errorItem!.status).toBe('error');

            // Missing folder item: becomes files-not-found
            const missingFolder = all.find((i) => i.infoHash === missingFolderHash);
            expect(missingFolder).toBeDefined();
            expect(missingFolder!.status).toBe('files-not-found');
        });

        it('settings manager destination folder is independent of persisted item folders', async () => {
            // Verify that the SettingsManager's current folder doesn't affect
            // the restored items' destinationFolder values
            const settingsStore = makeMockSettingsStore('/new/default/folder');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/new/default/folder',
            });

            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: 'abcd'.padEnd(40, '0'),
                    name: 'Old Download',
                    totalSize: 1_000_000,
                    downloadedSize: 1_000_000,
                    progress: 1,
                    status: 'completed',
                    destinationFolder: '/old/folder',
                    addedAt: 1_000_000,
                    completedAt: 2_000_000,
                },
            ];

            const store = makeMockStore(persistedItems);
            const engine = makeMockEngine();

            const manager = createDownloadManager(engine, settings, store);
            await manager.restoreSession();

            const all = manager.getAll();
            expect(all).toHaveLength(1);
            // The restored item keeps its original destinationFolder
            expect(all[0].destinationFolder).toBe('/old/folder');
            // The settings manager has a different current folder
            expect(settings.get().destinationFolder).toBe('/new/default/folder');
        });

        it('persist after restore produces a consistent round-trip', async () => {
            const settingsStore = makeMockSettingsStore('/downloads');
            const settings = createSettingsManager({
                store: settingsStore,
                getDownloadsPath: () => '/downloads',
            });

            const pausedHash = 'abab'.padEnd(40, '0');
            const completedHash = 'cdcd'.padEnd(40, '0');

            const persistedItems: PersistedDownloadItem[] = [
                {
                    infoHash: pausedHash,
                    name: 'Paused Torrent',
                    totalSize: 1_000_000,
                    downloadedSize: 400_000,
                    progress: 0.4,
                    status: 'paused',
                    destinationFolder: '/downloads',
                    addedAt: 1_000_000,
                },
                {
                    infoHash: completedHash,
                    name: 'Completed Torrent',
                    totalSize: 2_000_000,
                    downloadedSize: 2_000_000,
                    progress: 1,
                    status: 'completed',
                    destinationFolder: '/downloads',
                    addedAt: 2_000_000,
                    completedAt: 2_500_000,
                    elapsedMs: 500_000,
                },
            ];

            const store = makeMockStore(persistedItems);

            // First cycle: restore → persist
            const engine1 = makeMockEngine();
            const manager1 = createDownloadManager(engine1, settings, store);
            await manager1.restoreSession();
            manager1.persistSession();

            // Second cycle: restore from the re-persisted data
            const engine2 = makeMockEngine();
            const manager2 = createDownloadManager(engine2, settings, store);
            await manager2.restoreSession();

            const restored = manager2.getAll();
            expect(restored).toHaveLength(2);

            const restoredPaused = restored.find((i) => i.infoHash === pausedHash);
            expect(restoredPaused).toBeDefined();
            expect(restoredPaused!.name).toBe('Paused Torrent');
            expect(restoredPaused!.status).toBe('paused');
            expect(restoredPaused!.progress).toBe(0.4);

            const restoredCompleted = restored.find((i) => i.infoHash === completedHash);
            expect(restoredCompleted).toBeDefined();
            expect(restoredCompleted!.name).toBe('Completed Torrent');
            expect(restoredCompleted!.status).toBe('completed');
            expect(restoredCompleted!.completedAt).toBe(2_500_000);
            expect(restoredCompleted!.elapsedMs).toBe(500_000);
        });
    });
});

// ─── TorrentMetadata round-trip ───────────────────────────────────────────────

describe('Integração: recuperação de sessão parcialmente corrompida', () => {
    const first: PersistedDownloadItem = {
        infoHash: 'a'.repeat(40),
        name: 'Primeiro download',
        totalSize: 100,
        downloadedSize: 50,
        progress: 0.5,
        status: 'paused',
        destinationFolder: '/downloads',
        addedAt: 1,
        selectedFileIndices: [0],
    };
    const last: PersistedDownloadItem = {
        ...first,
        infoHash: 'b'.repeat(40),
        name: 'Último download',
        status: 'queued',
        magnetUri: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
    };

    function setup(downloads: unknown) {
        const data = new Map<string, unknown>([
            ['downloads', downloads],
            ['downloadsSchemaVersion', 1],
        ]);
        const store: PersistedStore = {
            get: jest.fn().mockImplementation((key: string) => data.get(key)),
            set: jest.fn((key: string, value: unknown) => data.set(key, value)),
        };
        const settings = createSettingsManager({
            store: makeMockSettingsStore('/downloads'),
            getDownloadsPath: () => '/downloads',
        });
        const engine = makeMockEngine();
        const manager = createDownloadManager(engine, settings, store, undefined, {
            disableCleanupTimer: true,
        });
        return { manager, store, data, engine };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it.each([
        null,
        undefined,
        false,
        42,
        'corrompido',
        [],
        {},
        { ...first, name: null },
        { ...first, destinationFolder: null },
        { ...first, totalSize: '100' },
        { ...first, progress: 2 },
        { ...first, addedAt: null },
        { ...first, selectedFileIndices: {} },
        { ...first, selectedFileIndices: [null] },
        { ...first, completedAt: 'ontem' },
        { ...first, creator: {} },
        { ...first, torrentFileBase64: 'inválido' },
    ])('ignora entrada inválida (%j) e preserva os downloads válidos ao redor', async (invalid) => {
        const { manager, store, engine } = setup([first, invalid, last]);
        await expect(manager.restoreSession()).resolves.toBeUndefined();
        expect(manager.getAll().map((item) => item.infoHash)).toEqual([
            first.infoHash,
            last.infoHash,
        ]);
        expect(manager.getQueueOrder()).toEqual([last.infoHash]);
        manager.persistSession();
        expect(store.get('downloads')).toEqual([
            expect.objectContaining(first),
            expect.objectContaining(last),
        ]);

        // O próximo processo recebe a sessão recuperada com seleção e fila intactas.
        const recovered = setup(store.get('downloads'));
        await recovered.manager.restoreSession();
        expect(recovered.manager.getAll().map((item) => item.infoHash)).toEqual([
            first.infoHash,
            last.infoHash,
        ]);
        expect(recovered.manager.getQueueOrder()).toEqual([last.infoHash]);
        expect(engine.addMagnetLink).not.toHaveBeenCalled();
    });

    it.each([null, {}, 'corrompido', 42])(
        'preserva a sessão original quando downloads não é uma lista (%j)',
        async (original) => {
            const { manager, store, data } = setup(original);
            await expect(manager.restoreSession()).rejects.toThrow('sessão de downloads inválido');
            manager.persistSession();
            await manager.applySeedingSettings();
            expect(store.set).not.toHaveBeenCalled();
            expect(data.get('downloads')).toEqual(original);
            expect(data.get('downloadsSchemaVersion')).toBe(1);
        },
    );

    it('não sobrescreve a sessão após falha de leitura do armazenamento', async () => {
        const original = [first, last];
        const { manager, store, data } = setup(original);
        jest.mocked(store.get).mockImplementation(() => {
            throw new Error('Falha de leitura');
        });
        await expect(manager.restoreSession()).rejects.toThrow('Falha de leitura');
        manager.persistSession();
        expect(store.set).not.toHaveBeenCalled();
        expect(data.get('downloads')).toEqual(original);
    });

    it('não grava um snapshot parcial se a restauração for interrompida entre itens', async () => {
        const original = [first, last];
        const { manager, store, data } = setup(original);
        manager.on('update', (item) => {
            if (item.infoHash === last.infoHash) throw new Error('Restauração interrompida');
        });
        await expect(manager.restoreSession()).rejects.toThrow('Restauração interrompida');
        manager.persistSession();
        await manager.applySeedingSettings();
        expect(store.set).not.toHaveBeenCalled();
        expect(data.get('downloads')).toEqual(original);
    });

    it('aguarda todos os itens antes de permitir persistência durante retomada assíncrona', async () => {
        const active: PersistedDownloadItem = {
            ...first,
            status: 'downloading',
            magnetUri: `magnet:?xt=urn:btih:${first.infoHash}`,
        };
        const original = [active, last];
        const { manager, store, data, engine } = setup(original);
        let finish!: (info: TorrentInfo) => void;
        jest.mocked(engine.addMagnetLink).mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const restoration = manager.restoreSession();
        await Promise.resolve();
        expect(engine.addMagnetLink).toHaveBeenCalled();
        manager.persistSession();
        expect(store.set).not.toHaveBeenCalled();
        expect(data.get('downloads')).toEqual(original);

        finish(makeTorrentInfo({ infoHash: first.infoHash }));
        await restoration;
        expect(store.get('downloads')).toEqual([
            expect.objectContaining({ infoHash: first.infoHash }),
            expect.objectContaining({ infoHash: last.infoHash }),
        ]);
    });
});

describe('Integration: TorrentMetadata persisted and restored for completed torrents', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('persists and restores TorrentMetadata for completed torrents', async () => {
        const hash = 'a'.repeat(40);
        const expectedMetadata: TorrentMetadata = {
            infoHash: hash,
            creator: 'TestCreator',
            comment: 'Test comment',
            creationDate: 1700000000000,
        };

        const settingsStore = makeMockSettingsStore('/downloads');
        const settings = createSettingsManager({
            store: settingsStore,
            getDownloadsPath: () => '/downloads',
        });
        const store = makeMockStore();
        const engine1 = makeMockEngine();
        (engine1.getMetadata as jest.Mock).mockReturnValue(expectedMetadata);
        (engine1.addTorrentFile as jest.Mock).mockResolvedValue(
            makeTorrentInfo({ infoHash: hash, status: 'downloading' as TorrentStatus }),
        );

        const manager1 = createDownloadManager(engine1, settings, store, undefined, {
            disableCleanupTimer: true,
        });
        await manager1.addTorrentFile('/path/to/file.torrent');

        // Emitir done — captura metadados no cache
        engine1.emit('done', hash);

        // Verificar que o cache foi populado
        expect(manager1.getCachedMetadata(hash)).toEqual(expectedMetadata);

        // Persistir sessão
        manager1.persistSession();

        // Verificar que os campos de metadados foram persistidos
        const persisted = store.get('downloads');
        expect(persisted?.[0]).toMatchObject({
            creator: 'TestCreator',
            comment: 'Test comment',
            creationDate: 1700000000000,
        });

        // Criar novo manager e restaurar sessão
        const engine2 = makeMockEngine();
        const manager2 = createDownloadManager(engine2, settings, store, undefined, {
            disableCleanupTimer: true,
        });
        await manager2.restoreSession();

        // Verificar que os metadados foram restaurados
        expect(manager2.getCachedMetadata(hash)).toEqual(expectedMetadata);
    });
});

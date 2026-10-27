/**
 * Tests for DownloadManager — metadata timeout logic + property-based tests.
 *
 * Covers:
 *   - Requirement 1.2: Torrent file added to Download_List
 *   - Requirement 2.2: Magnet link added with status resolving-metadata
 *   - Requirement 2.3: name + totalSize updated when metadata resolves → status downloading
 *   - Requirement 2.5: After 60s without resolution → status metadata-failed
 */

import { EventEmitter } from 'events';
import fc from 'fast-check';
import { createDownloadManager } from '../../main/downloadManager';
import type { TorrentEngine, TorrentInfo, TorrentStatus } from '../../main/torrentEngine';
import type { SettingsManager } from '../../main/settingsManager';
import type { DownloadItem } from '../../main/downloadManager';
import type { TorrentMetadata } from '../../shared/types';

// ─── FS Mocks (hoisted by Jest) ───────────────────────────────────────────────

import { existsSync, accessSync } from 'fs';
import type { PersistedDownloadItem, PersistedStore } from '../../main/downloadManager';

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(),
    accessSync: jest.fn(),
}));

jest.mock('fs/promises', () => ({
    ...jest.requireActual('fs/promises'),
    access: jest.fn(async (path: string) => {
        jest.requireMock('fs').accessSync(path);
    }),
    stat: jest.fn(async (path: string) => {
        if (!jest.requireMock('fs').existsSync(path)) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return { isDirectory: () => true };
    }),
}));

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockAccessSync = accessSync as jest.MockedFunction<typeof accessSync>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_MAGNET = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
const INFO_HASH = 'a'.repeat(40);

function makeTorrentInfo(overrides: Partial<TorrentInfo> = {}): TorrentInfo {
    return {
        infoHash: INFO_HASH,
        name: INFO_HASH, // before metadata: name is the infoHash
        totalSize: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: Infinity,
        downloaded: 0,
        status: 'resolving-metadata' as TorrentStatus,
        ...overrides,
    };
}

/**
 * Creates a mock TorrentEngine that is also an EventEmitter so tests can
 * manually emit 'progress', 'done', and 'error' events.
 */
function makeMockEngine(magnetInfo: TorrentInfo = makeTorrentInfo()): TorrentEngine & EventEmitter {
    const emitter = new EventEmitter();

    const engine: TorrentEngine & EventEmitter = Object.assign(emitter, {
        addTorrentFile: jest.fn(),

        detachTorrent: jest.fn().mockResolvedValue(undefined),

        getTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn(),
        addMagnetLink: jest.fn().mockResolvedValue(magnetInfo),
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
        shutdown: jest.fn().mockResolvedValue(undefined),
    });

    return engine;
}

function makeMockSettings(folder = '/downloads'): SettingsManager {
    return {
        get: jest.fn().mockReturnValue({
            destinationFolder: folder,
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 3,
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            globalTrackers: [],
            autoApplyGlobalTrackers: false,
        }),
        set: jest.fn(),
        getDefaultDownloadFolder: jest.fn().mockReturnValue(folder),
        getGlobalTrackers: jest.fn().mockReturnValue([]),
        addGlobalTracker: jest.fn(),
        removeGlobalTracker: jest.fn(),
        setAutoApplyGlobalTrackers: jest.fn(),
    } as unknown as SettingsManager;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DownloadManager — metadata timeout (Requirement 2.5)', () => {
    beforeEach(() => {
        // Folder validation: simulate valid (existing + writable) folder
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it('sets initial status to resolving-metadata when adding a magnet link', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings);

        const item = await manager.addMagnetLink(VALID_MAGNET);

        expect(item.status).toBe('resolving-metadata');
    });

    it('transitions to metadata-failed after 60s without metadata resolution', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings);

        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push({ ...item }));

        await manager.addMagnetLink(VALID_MAGNET);

        // Advance 60 seconds — the timeout should fire
        await jest.advanceTimersByTimeAsync(60_000);

        const lastUpdate = updates[updates.length - 1];
        expect(lastUpdate.status).toBe('metadata-failed');
        expect(lastUpdate.infoHash).toBe(INFO_HASH);
    });

    it('does NOT transition to metadata-failed if metadata resolves before 60s', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings);

        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push({ ...item }));

        await manager.addMagnetLink(VALID_MAGNET);

        // Simulate metadata resolution via a progress event at 30s
        jest.advanceTimersByTime(30_000);
        engine.emit(
            'progress',
            makeTorrentInfo({
                name: 'My Torrent',
                totalSize: 1_000_000,
                status: 'downloading',
            }),
        );

        // Advance past the 60s mark — timer should have been cleared
        jest.advanceTimersByTime(31_000);

        const statuses = updates.map((u) => u.status);
        expect(statuses).not.toContain('metadata-failed');
        expect(statuses[statuses.length - 1]).toBe('downloading');
    });

    it('updates name and totalSize when metadata resolves (resolving-metadata → downloading)', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings);

        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push({ ...item }));

        await manager.addMagnetLink(VALID_MAGNET);

        // Emit progress with resolved metadata
        engine.emit(
            'progress',
            makeTorrentInfo({
                name: 'Resolved Torrent Name',
                totalSize: 5_000_000,
                status: 'downloading',
            }),
        );

        const downloadingUpdate = updates.find((u) => u.status === 'downloading');
        expect(downloadingUpdate).toBeDefined();
        expect(downloadingUpdate!.name).toBe('Resolved Torrent Name');
        expect(downloadingUpdate!.totalSize).toBe(5_000_000);
    });

    it('does not set metadata-failed if item was already removed before 60s', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings);

        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push({ ...item }));

        await manager.addMagnetLink(VALID_MAGNET);

        // Remove the item before the timeout fires
        await manager.remove(INFO_HASH, false);

        // Advance past 60s
        await jest.advanceTimersByTimeAsync(60_000);

        // No metadata-failed update should have been emitted after removal
        const postRemovalUpdates = updates.filter((u) => u.status === 'metadata-failed');
        expect(postRemovalUpdates).toHaveLength(0);
    });

    it('emits update event with metadata-failed status when timeout fires', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings);

        const updateListener = jest.fn();
        manager.on('update', updateListener);

        await manager.addMagnetLink(VALID_MAGNET);
        const callCountBeforeTimeout = updateListener.mock.calls.length;

        await jest.advanceTimersByTimeAsync(60_000);

        // Should have been called once more with metadata-failed
        expect(updateListener).toHaveBeenCalledTimes(callCountBeforeTimeout + 1);
        const lastCall = updateListener.mock.calls[updateListener.mock.calls.length - 1][0];
        expect(lastCall.status).toBe('metadata-failed');
    });

    it('getAll reflects metadata-failed status after timeout', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings);

        await manager.addMagnetLink(VALID_MAGNET);
        await jest.advanceTimersByTimeAsync(60_000);

        const all = manager.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('metadata-failed');
    });
});

// ─── Property-based tests ────────────────────────────────────────────────────

// Feature: meshy-torrent-client, Property 2: Adição de torrent cresce a lista
describe('DownloadManager — Property 2: Adição de torrent cresce a lista', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    /**
     * **Validates: Requirements 1.2, 2.2**
     *
     * Para qualquer lista de downloads e qualquer torrent válido (arquivo ou magnet)
     * não presente na lista, após adicioná-lo, a lista SHALL conter exatamente um
     * item a mais e o novo item SHALL estar presente na lista.
     */
    it('adding a torrent file grows the list by exactly one and the new item is present', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 0, max: 10 }),
                fc.string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                }),
                async (preExistingCount, newHash) => {
                    const normalizedHash = newHash.toLowerCase();

                    // Ensure fs mocks are set for each iteration
                    mockExistsSync.mockReturnValue(true);
                    mockAccessSync.mockReturnValue(undefined);

                    // Build a mock engine that returns unique infoHashes for pre-existing items
                    const engine = makeMockEngine();
                    const settings = makeMockSettings();
                    const manager = createDownloadManager(engine, settings);

                    // Pre-populate the list with `preExistingCount` items using addTorrentFile
                    const usedHashes: string[] = [];
                    for (let i = 0; i < preExistingCount; i++) {
                        const hash = i.toString(16).padStart(40, '0');
                        usedHashes.push(hash);

                        const info = makeTorrentInfo({
                            infoHash: hash,
                            name: `Torrent ${i}`,
                            status: 'downloading' as TorrentStatus,
                        });
                        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);
                        await manager.addTorrentFile(`/path/to/file${i}.torrent`);
                    }

                    // Ensure the new hash doesn't collide with pre-existing ones
                    // If it does, skip this iteration (shrink-friendly)
                    if (usedHashes.includes(normalizedHash)) {
                        return true; // vacuously true — skip collision
                    }

                    const sizeBefore = manager.getAll().length;

                    // Configure engine to return the new torrent info
                    const newInfo = makeTorrentInfo({
                        infoHash: normalizedHash,
                        name: 'New Torrent',
                        totalSize: 1_000_000,
                        status: 'downloading' as TorrentStatus,
                    });
                    (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(newInfo);

                    await manager.addTorrentFile('/path/to/new.torrent');

                    const allAfter = manager.getAll();

                    // List grew by exactly 1
                    if (allAfter.length !== sizeBefore + 1) return false;

                    // The new item is present in the list
                    const found = allAfter.some((item) => item.infoHash === normalizedHash);
                    return found;
                },
            ),
            { numRuns: 100 },
        );
    });

    it('adding a magnet link grows the list by exactly one and the new item is present', async () => {
        jest.useFakeTimers();
        try {
            await fc.assert(
                fc.asyncProperty(
                    fc.integer({ min: 0, max: 10 }),
                    fc.string({
                        unit: fc.constantFrom(...'0123456789abcdef'),
                        minLength: 40,
                        maxLength: 40,
                    }),
                    async (preExistingCount, newHash) => {
                        const normalizedHash = newHash.toLowerCase();

                        // Ensure fs mocks are set for each iteration
                        mockExistsSync.mockReturnValue(true);
                        mockAccessSync.mockReturnValue(undefined);

                        const engine = makeMockEngine();
                        const settings = makeMockSettings();
                        const manager = createDownloadManager(engine, settings);

                        // Pre-populate the list with `preExistingCount` items using addMagnetLink
                        const usedHashes: string[] = [];
                        for (let i = 0; i < preExistingCount; i++) {
                            const hash = i.toString(16).padStart(40, '0');
                            usedHashes.push(hash);

                            const info = makeTorrentInfo({
                                infoHash: hash,
                                name: hash,
                                status: 'resolving-metadata' as TorrentStatus,
                            });
                            (engine.addMagnetLink as jest.Mock).mockResolvedValueOnce(info);
                            await manager.addMagnetLink(`magnet:?xt=urn:btih:${hash}`);
                        }

                        // Skip if collision with pre-existing hashes
                        if (usedHashes.includes(normalizedHash)) {
                            return true;
                        }

                        const sizeBefore = manager.getAll().length;

                        // Configure engine to return the new torrent info
                        const newInfo = makeTorrentInfo({
                            infoHash: normalizedHash,
                            name: normalizedHash,
                            status: 'resolving-metadata' as TorrentStatus,
                        });
                        (engine.addMagnetLink as jest.Mock).mockResolvedValueOnce(newInfo);

                        await manager.addMagnetLink(`magnet:?xt=urn:btih:${normalizedHash}`);

                        const allAfter = manager.getAll();

                        // List grew by exactly 1
                        if (allAfter.length !== sizeBefore + 1) return false;

                        // The new item is present in the list
                        const found = allAfter.some((item) => item.infoHash === normalizedHash);
                        return found;
                    },
                ),
                { numRuns: 100 },
            );
        } finally {
            jest.useRealTimers();
        }
    });
});

// ─── Property-based tests — Idempotência de adição ───────────────────────────

// Feature: meshy-torrent-client, Property 3: Idempotência de adição (sem duplicatas)
describe('DownloadManager — Property 3: Idempotência de adição (sem duplicatas)', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * **Validates: Requirements 1.5**
     *
     * Para qualquer torrent já presente na Download_List, tentar adicioná-lo
     * novamente SHALL deixar o comprimento da lista inalterado — nenhum item
     * duplicado SHALL ser criado.
     */
    it('adding a duplicate torrent file does not change the list length', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                }),
                async (hash) => {
                    const normalizedHash = hash.toLowerCase();

                    mockExistsSync.mockReturnValue(true);
                    mockAccessSync.mockReturnValue(undefined);

                    const engine = makeMockEngine();
                    const settings = makeMockSettings();
                    const manager = createDownloadManager(engine, settings);

                    // First add — should succeed
                    const info = makeTorrentInfo({
                        infoHash: normalizedHash,
                        name: 'Test Torrent',
                        status: 'downloading' as TorrentStatus,
                    });
                    (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);
                    await manager.addTorrentFile('/path/to/file.torrent');

                    const lengthBefore = manager.getAll().length;

                    // Second add — same infoHash, engine returns same info
                    (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);
                    try {
                        await manager.addTorrentFile('/path/to/file.torrent');
                    } catch {
                        // Expected: 'Torrent já existe na lista'
                    }

                    const lengthAfter = manager.getAll().length;

                    // List length must remain unchanged
                    return lengthAfter === lengthBefore;
                },
            ),
            { numRuns: 100 },
        );
    });

    it('adding a duplicate magnet link does not change the list length', async () => {
        jest.useFakeTimers();
        try {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({
                        unit: fc.constantFrom(...'0123456789abcdef'),
                        minLength: 40,
                        maxLength: 40,
                    }),
                    async (hash) => {
                        const normalizedHash = hash.toLowerCase();

                        mockExistsSync.mockReturnValue(true);
                        mockAccessSync.mockReturnValue(undefined);

                        const engine = makeMockEngine();
                        const settings = makeMockSettings();
                        const manager = createDownloadManager(engine, settings);

                        const magnetUri = `magnet:?xt=urn:btih:${normalizedHash}`;

                        // First add — should succeed
                        const info = makeTorrentInfo({
                            infoHash: normalizedHash,
                            name: normalizedHash,
                            status: 'resolving-metadata' as TorrentStatus,
                        });
                        (engine.addMagnetLink as jest.Mock).mockResolvedValueOnce(info);
                        await manager.addMagnetLink(magnetUri);

                        const lengthBefore = manager.getAll().length;

                        // Second add — same magnet link
                        (engine.addMagnetLink as jest.Mock).mockResolvedValueOnce(info);
                        try {
                            await manager.addMagnetLink(magnetUri);
                        } catch {
                            // Expected: 'Torrent já existe na lista'
                        }

                        const lengthAfter = manager.getAll().length;

                        // List length must remain unchanged
                        return lengthAfter === lengthBefore;
                    },
                ),
                { numRuns: 100 },
            );
        } finally {
            jest.useRealTimers();
        }
    });
});

// ─── Property-based tests — Round-trip pausar/retomar ─────────────────────────

// Feature: meshy-torrent-client, Property 8: Round-trip pausar/retomar preserva estado
describe('DownloadManager — Property 8: Round-trip pausar/retomar preserva estado', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * **Validates: Requirements 4.1, 4.2**
     *
     * Para qualquer DownloadItem com status `downloading`, após chamar `pause()`
     * seguido de `resume()`, o status SHALL retornar a `downloading` — o estado
     * SHALL ser equivalente ao estado anterior à pausa.
     */
    it('pause() followed by resume() restores status to downloading', async () => {
        jest.useFakeTimers();
        try {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({
                        unit: fc.constantFrom(...'0123456789abcdef'),
                        minLength: 40,
                        maxLength: 40,
                    }),
                    fc.string({ minLength: 1, maxLength: 100 }),
                    fc.integer({ min: 1, max: 10_000_000_000 }),
                    async (hash, torrentName, totalSize) => {
                        const normalizedHash = hash.toLowerCase();

                        mockExistsSync.mockReturnValue(true);
                        mockAccessSync.mockReturnValue(undefined);

                        const engine = makeMockEngine();
                        const settings = makeMockSettings();
                        const manager = createDownloadManager(engine, settings);

                        // Add a torrent file so it starts in 'downloading' status
                        const info = makeTorrentInfo({
                            infoHash: normalizedHash,
                            name: torrentName,
                            totalSize,
                            status: 'downloading' as TorrentStatus,
                        });
                        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);
                        await manager.addTorrentFile('/path/to/file.torrent');

                        // Verify initial status is downloading
                        const beforePause = manager
                            .getAll()
                            .find((i) => i.infoHash === normalizedHash);
                        if (!beforePause || beforePause.status !== 'downloading') return false;

                        // Pause the torrent
                        await manager.pause(normalizedHash);

                        // Verify status is paused
                        const afterPause = manager
                            .getAll()
                            .find((i) => i.infoHash === normalizedHash);
                        if (!afterPause || afterPause.status !== 'paused') return false;

                        // Resume the torrent
                        await manager.resume(normalizedHash);

                        // Verify status returned to downloading
                        const afterResume = manager
                            .getAll()
                            .find((i) => i.infoHash === normalizedHash);
                        if (!afterResume || afterResume.status !== 'downloading') return false;

                        // Verify the item's identity is preserved (same infoHash, name, totalSize)
                        return (
                            afterResume.infoHash === normalizedHash &&
                            afterResume.name === torrentName &&
                            afterResume.totalSize === totalSize
                        );
                    },
                ),
                { numRuns: 100 },
            );
        } finally {
            jest.useRealTimers();
        }
    });
});

// ─── Property-based tests — Remoção elimina item da lista ─────────────────────

// Feature: meshy-torrent-client, Property 9: Remoção elimina item da lista independente de deleteFiles
describe('DownloadManager — Property 9: Remoção elimina item da lista independente de deleteFiles', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * **Validates: Requirements 4.4, 4.5**
     *
     * Para qualquer DownloadItem presente na Download_List e qualquer valor booleano
     * de `deleteFiles`, após chamar `remove(infoHash, deleteFiles)`, o item com aquele
     * `infoHash` SHALL estar ausente do resultado de `getAll()`.
     */
    it('remove(infoHash, deleteFiles) eliminates the item from getAll() regardless of deleteFiles', async () => {
        jest.useFakeTimers();
        try {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({
                        unit: fc.constantFrom(...'0123456789abcdef'),
                        minLength: 40,
                        maxLength: 40,
                    }),
                    fc.boolean(),
                    async (hash, deleteFiles) => {
                        const normalizedHash = hash.toLowerCase();

                        mockExistsSync.mockReturnValue(true);
                        mockAccessSync.mockReturnValue(undefined);

                        const engine = makeMockEngine();
                        const settings = makeMockSettings();
                        const manager = createDownloadManager(engine, settings);

                        // Add a torrent file so it appears in the list
                        const info = makeTorrentInfo({
                            infoHash: normalizedHash,
                            name: 'Test Torrent',
                            totalSize: 1_000_000,
                            status: 'downloading' as TorrentStatus,
                        });
                        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);
                        await manager.addTorrentFile('/path/to/file.torrent');

                        // Verify the item is present before removal
                        const beforeRemoval = manager.getAll();
                        if (!beforeRemoval.some((item) => item.infoHash === normalizedHash))
                            return false;

                        // Remove the item with the random deleteFiles boolean
                        await manager.remove(normalizedHash, deleteFiles);

                        // Verify the item is absent from getAll()
                        const afterRemoval = manager.getAll();
                        const stillPresent = afterRemoval.some(
                            (item) => item.infoHash === normalizedHash,
                        );
                        return !stillPresent;
                    },
                ),
                { numRuns: 100 },
            );
        } finally {
            jest.useRealTimers();
        }
    });
});

// ─── Property-based tests — Atualização de metadados após resolução ──────────

// Feature: meshy-torrent-client, Property 5: Atualização de metadados após resolução
describe('DownloadManager — Property 5: Atualização de metadados após resolução', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * **Validates: Requirements 2.3**
     *
     * Para qualquer DownloadItem com status `resolving-metadata` e qualquer objeto
     * de metadados válido (name: string não-vazia, totalSize: número positivo),
     * após aplicar a resolução de metadados, o item SHALL ter `name` e `totalSize`
     * atualizados e status SHALL ser `downloading`.
     */
    it('updates name, totalSize, and status to downloading after metadata resolution', async () => {
        jest.useFakeTimers();
        try {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({
                        unit: fc.constantFrom(...'0123456789abcdef'),
                        minLength: 40,
                        maxLength: 40,
                    }),
                    fc.string({ minLength: 1, maxLength: 200 }),
                    fc.integer({ min: 1, max: 10_000_000_000 }),
                    async (hash, resolvedName, resolvedTotalSize) => {
                        const normalizedHash = hash.toLowerCase();

                        mockExistsSync.mockReturnValue(true);
                        mockAccessSync.mockReturnValue(undefined);

                        const magnetInfo = makeTorrentInfo({
                            infoHash: normalizedHash,
                            name: normalizedHash, // before metadata: name is the infoHash
                            totalSize: 0,
                            status: 'resolving-metadata' as TorrentStatus,
                        });
                        const engine = makeMockEngine(magnetInfo);
                        const settings = makeMockSettings();
                        const manager = createDownloadManager(engine, settings);

                        const updates: DownloadItem[] = [];
                        manager.on('update', (item) => updates.push({ ...item }));

                        const magnetUri = `magnet:?xt=urn:btih:${normalizedHash}`;
                        await manager.addMagnetLink(magnetUri);

                        // Verify initial status is resolving-metadata
                        const initial = manager.getAll().find((i) => i.infoHash === normalizedHash);
                        if (!initial || initial.status !== 'resolving-metadata') return false;

                        // Emit a progress event with resolved metadata (status: downloading)
                        engine.emit(
                            'progress',
                            makeTorrentInfo({
                                infoHash: normalizedHash,
                                name: resolvedName,
                                totalSize: resolvedTotalSize,
                                status: 'downloading' as TorrentStatus,
                            }),
                        );

                        // Verify the item was updated correctly
                        const afterResolution = manager
                            .getAll()
                            .find((i) => i.infoHash === normalizedHash);
                        if (!afterResolution) return false;

                        return (
                            afterResolution.name === resolvedName &&
                            afterResolution.totalSize === resolvedTotalSize &&
                            afterResolution.status === 'downloading'
                        );
                    },
                ),
                { numRuns: 100 },
            );
        } finally {
            jest.useRealTimers();
        }
    });
});

// ─── restoreSession / persistSession ─────────────────────────────────────────

function makePersistedItem(overrides: Partial<PersistedDownloadItem> = {}): PersistedDownloadItem {
    return {
        infoHash: 'b'.repeat(40),
        name: 'Test Torrent',
        totalSize: 1_000_000,
        downloadedSize: 500_000,
        progress: 0.5,
        status: 'paused',
        destinationFolder: '/downloads',
        addedAt: 1_000_000,
        ...overrides,
    };
}

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

describe('DownloadManager — restoreSession()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('restores items from the store into getAll()', async () => {
        const item = makePersistedItem({ status: 'paused' });
        const store = makeMockStore([item]);
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        // Folder exists so no files-not-found override
        mockExistsSync.mockReturnValue(true);

        const manager = createDownloadManager(engine, settings, store);
        await manager.restoreSession();

        const all = manager.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].infoHash).toBe(item.infoHash);
        expect(all[0].name).toBe(item.name);
        expect(all[0].totalSize).toBe(item.totalSize);
        expect(all[0].progress).toBe(item.progress);
        expect(all[0].destinationFolder).toBe(item.destinationFolder);
    });

    it('emits update event for each restored item', async () => {
        const items = [
            makePersistedItem({ infoHash: 'c'.repeat(40), status: 'paused' }),
            makePersistedItem({ infoHash: 'd'.repeat(40), status: 'completed' }),
        ];
        const store = makeMockStore(items);
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        mockExistsSync.mockReturnValue(true);

        const manager = createDownloadManager(engine, settings, store);
        const updates: string[] = [];
        manager.on('update', (item) => updates.push(item.infoHash));

        await manager.restoreSession();

        expect(updates).toContain('c'.repeat(40));
        expect(updates).toContain('d'.repeat(40));
    });

    it('marks items with missing destination folder as files-not-found', async () => {
        const item = makePersistedItem({ status: 'paused', destinationFolder: '/missing/folder' });
        const store = makeMockStore([item]);
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        // Folder does NOT exist
        mockExistsSync.mockReturnValue(false);

        const manager = createDownloadManager(engine, settings, store);
        await manager.restoreSession();

        const all = manager.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('files-not-found');
    });

    it('does NOT mark completed items as files-not-found even if folder is missing', async () => {
        const item = makePersistedItem({
            status: 'completed',
            destinationFolder: '/missing/folder',
        });
        const store = makeMockStore([item]);
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        // Folder does NOT exist
        mockExistsSync.mockReturnValue(false);

        const manager = createDownloadManager(engine, settings, store);
        await manager.restoreSession();

        const all = manager.getAll();
        expect(all).toHaveLength(1);
        expect(all[0].status).toBe('completed');
    });

    it('auto-resumes items that were downloading (via magnetUri) when folder exists', async () => {
        const magnetUri = 'magnet:?xt=urn:btih:' + 'e'.repeat(40);
        const item = makePersistedItem({
            infoHash: 'e'.repeat(40),
            status: 'downloading',
            magnetUri,
            destinationFolder: '/downloads',
        });
        const store = makeMockStore([item]);

        const resumedInfo = makeTorrentInfo({
            infoHash: 'e'.repeat(40),
            status: 'downloading',
        });
        const engine = makeMockEngine(resumedInfo);
        const settings = makeMockSettings();

        // Folder exists
        mockExistsSync.mockReturnValue(true);

        const manager = createDownloadManager(engine, settings, store);
        await manager.restoreSession();

        expect(engine.addMagnetLink).toHaveBeenCalledWith(magnetUri, false, {
            destinationFolder: '/downloads',
        });
    });

    it('auto-resumes items that were downloading (via torrentFilePath) when folder exists', async () => {
        const torrentFilePath = '/path/to/file.torrent';
        const item = makePersistedItem({
            infoHash: 'f'.repeat(40),
            status: 'downloading',
            torrentFilePath,
            destinationFolder: '/downloads',
        });
        const store = makeMockStore([item]);

        const resumedInfo = makeTorrentInfo({
            infoHash: 'f'.repeat(40),
            status: 'downloading',
        });
        const engine = makeMockEngine(resumedInfo);
        const settings = makeMockSettings();

        mockExistsSync.mockReturnValue(true);

        const manager = createDownloadManager(engine, settings, store);
        await manager.restoreSession();

        expect(engine.addTorrentFile).toHaveBeenCalledWith(torrentFilePath, false, {
            destinationFolder: '/downloads',
        });
    });

    it('does NOT auto-resume items that were downloading when folder is missing', async () => {
        const item = makePersistedItem({
            infoHash: 'g'.repeat(40),
            status: 'downloading',
            magnetUri: 'magnet:?xt=urn:btih:' + 'g'.repeat(40),
            destinationFolder: '/missing',
        });
        const store = makeMockStore([item]);
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        // Folder does NOT exist
        mockExistsSync.mockReturnValue(false);

        const manager = createDownloadManager(engine, settings, store);
        await manager.restoreSession();

        expect(engine.addMagnetLink).not.toHaveBeenCalled();
        const all = manager.getAll();
        expect(all[0].status).toBe('files-not-found');
    });

    it('does NOT auto-resume paused or completed items', async () => {
        const items = [
            makePersistedItem({
                infoHash: 'h'.repeat(40),
                status: 'paused',
                magnetUri: 'magnet:?xt=urn:btih:' + 'h'.repeat(40),
            }),
            makePersistedItem({
                infoHash: 'i'.repeat(40),
                status: 'completed',
                magnetUri: 'magnet:?xt=urn:btih:' + 'i'.repeat(40),
            }),
        ];
        const store = makeMockStore(items);
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        mockExistsSync.mockReturnValue(true);

        const manager = createDownloadManager(engine, settings, store);
        await manager.restoreSession();

        expect(engine.addMagnetLink).not.toHaveBeenCalled();
        expect(engine.addTorrentFile).not.toHaveBeenCalled();
    });

    it('does nothing when store has no downloads', async () => {
        const store = makeMockStore([]);
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        const manager = createDownloadManager(engine, settings, store);
        await manager.restoreSession();

        expect(manager.getAll()).toHaveLength(0);
    });

    it('does nothing when no store is provided', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        // No store passed
        const manager = createDownloadManager(engine, settings);
        await manager.restoreSession();

        expect(manager.getAll()).toHaveLength(0);
    });
});

describe('DownloadManager — persistSession()', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Folder validation: simulate valid (existing + writable) folder
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('saves all current items to the store', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const store = makeMockStore();

        const manager = createDownloadManager(engine, settings, store);

        // Add a magnet link so there's something to persist
        mockExistsSync.mockReturnValue(true);
        await manager.addMagnetLink(VALID_MAGNET);

        manager.persistSession();

        expect(store.set).toHaveBeenCalledWith(
            'downloads',
            expect.arrayContaining([
                expect.objectContaining({
                    infoHash: INFO_HASH,
                    name: expect.any(String),
                    status: 'resolving-metadata',
                }),
            ]),
        );
    });

    it('defers and coalesces session snapshots when asynchronous persistence is enabled', async () => {
        jest.useFakeTimers();
        const engine = makeMockEngine();
        const store = makeMockStore();
        const manager = createDownloadManager(engine, makeMockSettings(), store, undefined, {
            sessionPersistenceDelayMs: 250,
        });

        await manager.addMagnetLink(VALID_MAGNET);
        jest.clearAllMocks();

        manager.persistSession();
        manager.persistSession();
        manager.persistSession();

        expect(engine.getFiles).not.toHaveBeenCalled();
        expect(store.set).not.toHaveBeenCalled();

        await manager.flushSessionPersistence();

        expect(engine.getFiles).toHaveBeenCalledTimes(1);
        expect(store.set).toHaveBeenCalledTimes(2);
        expect(store.set).toHaveBeenCalledWith(
            'downloads',
            expect.arrayContaining([expect.objectContaining({ infoHash: INFO_HASH })]),
        );
    });

    it('keeps a failed asynchronous snapshot pending so shutdown can retry it', async () => {
        const engine = makeMockEngine();
        const store = makeMockStore() as PersistedStore & { flush: jest.Mock };
        store.flush = jest.fn();
        const manager = createDownloadManager(engine, makeMockSettings(), store, undefined, {
            sessionPersistenceDelayMs: 250,
        });

        await manager.addMagnetLink(VALID_MAGNET);
        jest.clearAllMocks();
        store.flush.mockRejectedValueOnce(new Error('disco indisponível'));
        manager.persistSession();

        await expect(manager.flushSessionPersistence()).rejects.toThrow('disco indisponível');

        store.flush.mockResolvedValue(undefined);
        await expect(manager.flushSessionPersistence()).resolves.toBeUndefined();
        expect(store.flush).toHaveBeenCalledTimes(2);
    });

    it('saves an empty array when there are no items', () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const store = makeMockStore();

        const manager = createDownloadManager(engine, settings, store);
        manager.persistSession();

        expect(store.set).toHaveBeenCalledWith('downloads', []);
    });

    it('does nothing when no store is provided', () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();

        // No store passed
        const manager = createDownloadManager(engine, settings);
        // Should not throw
        expect(() => manager.persistSession()).not.toThrow();
    });

    it('persists all required fields for each item', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings('/my/folder');
        const store = makeMockStore();

        const manager = createDownloadManager(engine, settings, store);
        mockExistsSync.mockReturnValue(true);
        await manager.addMagnetLink(VALID_MAGNET);

        manager.persistSession();

        const savedItems = (store.set as jest.Mock).mock.calls[0][1] as PersistedDownloadItem[];
        expect(savedItems).toHaveLength(1);

        const saved = savedItems[0];
        expect(saved).toHaveProperty('infoHash');
        expect(saved).toHaveProperty('name');
        expect(saved).toHaveProperty('totalSize');
        expect(saved).toHaveProperty('downloadedSize');
        expect(saved).toHaveProperty('progress');
        expect(saved).toHaveProperty('status');
        expect(saved).toHaveProperty('destinationFolder');
        expect(saved).toHaveProperty('addedAt');
    });

    it('round-trips: items persisted by persistSession() are restored by restoreSession()', async () => {
        jest.useRealTimers();

        const engine = makeMockEngine();
        const settings = makeMockSettings('/downloads');
        const store = makeMockStore();

        mockExistsSync.mockReturnValue(true);

        const manager = createDownloadManager(engine, settings, store);
        await manager.addMagnetLink(
            'magnet:?dn=Example&xt=urn:btih:VKVKVKVKVKVKVKVKVKVKVKVKVKVKVKVK',
        );
        await expect(manager.addMagnetLink(VALID_MAGNET)).rejects.toThrow('Torrent já existe');

        // Persist current state
        manager.persistSession();

        // Create a fresh manager and restore
        const engine2 = makeMockEngine();
        const manager2 = createDownloadManager(engine2, settings, store);
        await manager2.restoreSession();

        const restored = manager2.getAll();
        expect(restored).toHaveLength(1);
        expect(restored[0].infoHash).toBe(INFO_HASH);
        expect(restored[0].status).toBe('resolving-metadata');
        await expect(manager2.addMagnetLink(VALID_MAGNET)).rejects.toThrow('Torrent já existe');
    });
});

// ─── Property-based tests — Auto-retomada seletiva ───────────────────────────

// Feature: meshy-torrent-client, Property 16: Auto-retomada seletiva na restauração de sessão
describe('DownloadManager — Property 16: Auto-retomada seletiva na restauração de sessão', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * **Validates: Requirements 7.3**
     *
     * Para qualquer array de DownloadItems com statuses mistos, após `restoreSession()`,
     * `resume()` SHALL ser chamado exatamente para os itens cujo status era `downloading`
     * na sessão anterior — e não para itens com outros statuses (`paused`, `completed`,
     * `error`, etc.).
     */
    it('restoreSession() re-adds active downloads and pending metadata while leaving inactive items untouched', async () => {
        // All possible statuses for persisted items
        const allStatuses: TorrentStatus[] = [
            'downloading',
            'paused',
            'completed',
            'error',
            'queued',
            'metadata-failed',
            'resolving-metadata',
        ];

        const arbPersistedItem = fc.record({
            infoHash: fc
                .string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                })
                .map((h) => h.toLowerCase()),
            name: fc.string({ minLength: 1, maxLength: 50 }),
            totalSize: fc.integer({ min: 0, max: 10_000_000_000 }),
            downloadedSize: fc.integer({ min: 0, max: 10_000_000_000 }),
            progress: fc.double({ min: 0, max: 1, noNaN: true }),
            status: fc.constantFrom(...allStatuses),
            destinationFolder: fc.constant('/downloads'),
            addedAt: fc.integer({ min: 1, max: 2_000_000_000_000 }),
            magnetUri: fc.constant(undefined as string | undefined),
        });

        // Generate arrays of 1–8 items with unique infoHashes
        const arbItems = fc
            .array(arbPersistedItem, { minLength: 1, maxLength: 8 })
            .map((items) => {
                const seen = new Set<string>();
                return items.filter((item) => {
                    if (seen.has(item.infoHash)) return false;
                    seen.add(item.infoHash);
                    return true;
                });
            })
            .filter((items) => items.length > 0)
            // Assign magnetUri for each item so restoreSession can re-add
            .map((items) =>
                items.map((item) => ({
                    ...item,
                    magnetUri: `magnet:?xt=urn:btih:${item.infoHash}`,
                })),
            );

        await fc.assert(
            fc.asyncProperty(arbItems, async (items) => {
                mockExistsSync.mockReturnValue(true);
                mockAccessSync.mockReturnValue(undefined);

                const persistedItems: PersistedDownloadItem[] = items.map((item) => ({
                    infoHash: item.infoHash,
                    name: item.name,
                    totalSize: item.totalSize,
                    downloadedSize: item.downloadedSize,
                    progress: item.progress,
                    status: item.status,
                    destinationFolder: item.destinationFolder,
                    addedAt: item.addedAt,
                    magnetUri: item.magnetUri,
                }));

                const store = makeMockStore(persistedItems);
                const engine = makeMockEngine();

                // Usar um limite alto para que todos os itens ativos caibam em slots
                const activeCount = items.filter(
                    (i) => i.status === 'downloading' || i.status === 'resolving-metadata',
                ).length;
                const settings = makeMockSettings('/downloads');
                (settings.get as jest.Mock).mockReturnValue({
                    destinationFolder: '/downloads',
                    downloadSpeedLimit: 0,
                    uploadSpeedLimit: 0,
                    maxConcurrentDownloads: Math.max(activeCount, 10),
                    seedingEnabled: false,
                    maxConcurrentSeeders: 2,
                    notificationsEnabled: true,
                });

                // Make addMagnetLink resolve for each downloading item
                for (const item of items) {
                    if (item.status === 'downloading' || item.status === 'resolving-metadata') {
                        (engine.addMagnetLink as jest.Mock).mockResolvedValueOnce(
                            makeTorrentInfo({
                                infoHash: item.infoHash,
                                name: item.name,
                                status: 'downloading' as TorrentStatus,
                            }),
                        );
                    }
                }

                const manager = createDownloadManager(engine, settings, store);

                await manager.restoreSession();

                // Determine which items should have been re-added (status === 'downloading')
                const downloadingItems = items.filter(
                    (i) => i.status === 'downloading' || i.status === 'resolving-metadata',
                );
                const nonDownloadingItems = items.filter(
                    (i) => i.status !== 'downloading' && i.status !== 'resolving-metadata',
                );

                // engine.addMagnetLink should have been called exactly once per downloading item
                const addMagnetCalls = (engine.addMagnetLink as jest.Mock).mock.calls;
                const addTorrentFileCalls = (engine.addTorrentFile as jest.Mock).mock.calls;
                const totalResumeCalls = addMagnetCalls.length + addTorrentFileCalls.length;

                if (totalResumeCalls !== downloadingItems.length) return false;

                // Each downloading item's magnetUri should appear in the addMagnetLink calls
                const calledMagnetUris = addMagnetCalls.map((call: string[]) => call[0]);
                for (const item of downloadingItems) {
                    if (!calledMagnetUris.includes(item.magnetUri)) return false;
                }

                // Non-downloading items should NOT have triggered any engine add calls
                const calledTorrentPaths = addTorrentFileCalls.map((call: string[]) => call[0]);
                for (const item of nonDownloadingItems) {
                    if (calledMagnetUris.includes(item.magnetUri)) return false;
                    if (calledTorrentPaths.includes(item.magnetUri)) return false;
                }

                return true;
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Property-based tests — Round-trip de persistência de sessão ──────────────

// Feature: meshy-torrent-client, Property 15: Round-trip de persistência de sessão
describe('DownloadManager — Property 15: Round-trip de persistência de sessão', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * **Validates: Requirements 7.1, 7.2**
     *
     * Para qualquer array de DownloadItems, após chamar `persistSession()` seguido
     * de `restoreSession()`, a lista restaurada SHALL conter todos os itens originais
     * com os mesmos campos (`infoHash`, `name`, `status`, `progress`, `destinationFolder`, `addedAt`).
     */
    it('persist then restore preserves infoHash, name, status, progress, destinationFolder, addedAt for all items', async () => {
        // Statuses that do NOT trigger auto-resume in restoreSession.
        // 'downloading' triggers re-add to engine which can change status,
        // so we exclude it to test the pure round-trip property.
        const nonResumableStatuses: TorrentStatus[] = [
            'paused',
            'completed',
            'error',
            'queued',
            'metadata-failed',
        ];

        const arbPersistedItem = fc.record({
            infoHash: fc
                .string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                })
                .map((h) => h.toLowerCase()),
            name: fc.string({ minLength: 1, maxLength: 100 }),
            totalSize: fc.integer({ min: 0, max: 10_000_000_000 }),
            downloadedSize: fc.integer({ min: 0, max: 10_000_000_000 }),
            progress: fc.double({ min: 0, max: 1, noNaN: true }),
            status: fc.constantFrom(...nonResumableStatuses),
            destinationFolder: fc.constant('/downloads'),
            addedAt: fc.integer({ min: 1, max: 2_000_000_000_000 }),
        });

        // Generate arrays of 1–5 items with unique infoHashes
        const arbItems = fc
            .array(arbPersistedItem, { minLength: 1, maxLength: 5 })
            .map((items) => {
                // Deduplicate by infoHash — keep first occurrence
                const seen = new Set<string>();
                return items.filter((item) => {
                    if (seen.has(item.infoHash)) return false;
                    seen.add(item.infoHash);
                    return true;
                });
            })
            .filter((items) => items.length > 0);

        await fc.assert(
            fc.asyncProperty(arbItems, async (items) => {
                mockExistsSync.mockReturnValue(true);
                mockAccessSync.mockReturnValue(undefined);

                // Build persisted items to seed the store directly
                const persistedItems: PersistedDownloadItem[] = items.map((item) => ({
                    infoHash: item.infoHash,
                    name: item.name,
                    totalSize: item.totalSize,
                    downloadedSize: item.downloadedSize,
                    progress: item.progress,
                    status: item.status,
                    destinationFolder: item.destinationFolder,
                    addedAt: item.addedAt,
                }));

                // 1. Create a manager, populate via store, and persist
                const store = makeMockStore(persistedItems);
                const engine1 = makeMockEngine();
                const settings = makeMockSettings('/downloads');
                const manager1 = createDownloadManager(engine1, settings, store);

                // Restore into manager1 so items are in memory, then persist
                await manager1.restoreSession();
                manager1.persistSession();

                // 2. Create a fresh manager with the same store and restore
                const engine2 = makeMockEngine();
                const manager2 = createDownloadManager(engine2, settings, store);
                await manager2.restoreSession();

                const restored = manager2.getAll();

                // All original items must be present
                if (restored.length !== items.length) return false;

                // Each original item must match on the 6 specified fields
                for (const original of items) {
                    const match = restored.find((r) => r.infoHash === original.infoHash);
                    if (!match) return false;
                    if (match.name !== original.name) return false;
                    if (match.status !== original.status) return false;
                    if (match.progress !== original.progress) return false;
                    if (match.destinationFolder !== original.destinationFolder) return false;
                    if (match.addedAt !== original.addedAt) return false;
                }

                return true;
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Property-based tests — Arquivos ausentes resultam em status correto ──────

// Feature: meshy-torrent-client, Property 17: Arquivos ausentes resultam em status correto
describe('DownloadManager — Property 17: Arquivos ausentes resultam em status correto', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * **Validates: Requirements 7.4**
     *
     * Para qualquer DownloadItem restaurado cujo `destinationFolder` não existe no
     * sistema de arquivos, após `restoreSession()`, o item SHALL ter status
     * `files-not-found`.
     */
    it('items with missing destinationFolder get status files-not-found after restoreSession()', async () => {
        // Statuses that are NOT 'completed' — completed items are exempt from the folder check
        const nonCompletedStatuses: TorrentStatus[] = [
            'downloading',
            'paused',
            'error',
            'queued',
            'metadata-failed',
            'resolving-metadata',
        ];

        const arbPersistedItem = fc.record({
            infoHash: fc
                .string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                })
                .map((h) => h.toLowerCase()),
            name: fc.string({ minLength: 1, maxLength: 50 }),
            totalSize: fc.integer({ min: 0, max: 10_000_000_000 }),
            downloadedSize: fc.integer({ min: 0, max: 10_000_000_000 }),
            progress: fc.double({ min: 0, max: 1, noNaN: true }),
            status: fc.constantFrom(...nonCompletedStatuses),
            destinationFolder: fc.constant('/nonexistent/folder'),
            addedAt: fc.integer({ min: 1, max: 2_000_000_000_000 }),
        });

        // Generate arrays of 1–8 items with unique infoHashes
        const arbItems = fc
            .array(arbPersistedItem, { minLength: 1, maxLength: 8 })
            .map((items) => {
                const seen = new Set<string>();
                return items.filter((item) => {
                    if (seen.has(item.infoHash)) return false;
                    seen.add(item.infoHash);
                    return true;
                });
            })
            .filter((items) => items.length > 0);

        await fc.assert(
            fc.asyncProperty(arbItems, async (items) => {
                // Mock fs.existsSync to return false for the destination folder
                mockExistsSync.mockReturnValue(false);

                const persistedItems: PersistedDownloadItem[] = items.map((item) => ({
                    infoHash: item.infoHash,
                    name: item.name,
                    totalSize: item.totalSize,
                    downloadedSize: item.downloadedSize,
                    progress: item.progress,
                    status: item.status,
                    destinationFolder: item.destinationFolder,
                    addedAt: item.addedAt,
                }));

                const store = makeMockStore(persistedItems);
                const engine = makeMockEngine();
                const settings = makeMockSettings('/downloads');
                const manager = createDownloadManager(engine, settings, store);

                await manager.restoreSession();

                const restored = manager.getAll();

                // All items must be present
                if (restored.length !== items.length) return false;

                // Every non-completed item with a missing folder SHALL have status 'files-not-found'
                for (const item of items) {
                    const match = restored.find((r) => r.infoHash === item.infoHash);
                    if (!match) return false;
                    if (match.status !== 'files-not-found') return false;
                }

                return true;
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Aplicação automática de trackers globais ─────────────────────────────────

describe('DownloadManager — Aplicação automática de trackers globais (Requisito 6)', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it('aplica trackers globais ao adicionar torrent file quando autoApply está habilitado', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const globalTrackers = [
            'udp://tracker1.example.com:6969/announce',
            'udp://tracker2.example.com:6969/announce',
        ];
        (settings.get as jest.Mock).mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 3,
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            globalTrackers,
            autoApplyGlobalTrackers: true,
        });
        (settings.getGlobalTrackers as jest.Mock).mockReturnValue(globalTrackers);

        const info = makeTorrentInfo({
            infoHash: INFO_HASH,
            name: 'Test Torrent',
            status: 'downloading',
        });
        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);

        const manager = createDownloadManager(engine, settings);
        await manager.addTorrentFile('/path/to/file.torrent');

        expect(engine.addTracker).toHaveBeenCalledTimes(2);
        expect(engine.addTracker).toHaveBeenCalledWith(INFO_HASH, globalTrackers[0]);
        expect(engine.addTracker).toHaveBeenCalledWith(INFO_HASH, globalTrackers[1]);
    });

    it('aplica trackers globais ao adicionar magnet link quando autoApply está habilitado', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const globalTrackers = ['udp://tracker1.example.com:6969/announce'];
        (settings.get as jest.Mock).mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 3,
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            globalTrackers,
            autoApplyGlobalTrackers: true,
        });
        (settings.getGlobalTrackers as jest.Mock).mockReturnValue(globalTrackers);

        const manager = createDownloadManager(engine, settings);
        await manager.addMagnetLink(VALID_MAGNET);

        expect(engine.addTracker).toHaveBeenCalledTimes(1);
        expect(engine.addTracker).toHaveBeenCalledWith(INFO_HASH, globalTrackers[0]);
    });

    it('NÃO aplica trackers globais quando autoApply está desabilitado', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        // autoApplyGlobalTrackers é false por padrão no makeMockSettings

        const info = makeTorrentInfo({
            infoHash: INFO_HASH,
            name: 'Test Torrent',
            status: 'downloading',
        });
        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);

        const manager = createDownloadManager(engine, settings);
        await manager.addTorrentFile('/path/to/file.torrent');

        expect(engine.addTracker).not.toHaveBeenCalled();
    });

    it('NÃO aplica trackers globais a itens enfileirados (queued)', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const globalTrackers = ['udp://tracker1.example.com:6969/announce'];
        (settings.get as jest.Mock).mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 1, // limite baixo para forçar fila
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            globalTrackers,
            autoApplyGlobalTrackers: true,
        });
        (settings.getGlobalTrackers as jest.Mock).mockReturnValue(globalTrackers);

        const manager = createDownloadManager(engine, settings);

        // Primeiro torrent ocupa o slot
        const info1 = makeTorrentInfo({
            infoHash: '1'.repeat(40),
            name: 'Torrent 1',
            status: 'downloading',
        });
        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info1);
        await manager.addTorrentFile('/path/to/file1.torrent');

        // Resetar contagem de chamadas ao addTracker
        (engine.addTracker as jest.Mock).mockClear();

        // Segundo torrent vai para a fila
        const info2 = makeTorrentInfo({
            infoHash: '2'.repeat(40),
            name: 'Torrent 2',
            status: 'downloading',
        });
        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info2);
        const queuedItem = await manager.addTorrentFile('/path/to/file2.torrent');

        expect(queuedItem.status).toBe('queued');
        // addTracker NÃO deve ter sido chamado para o item enfileirado
        expect(engine.addTracker).not.toHaveBeenCalledWith('2'.repeat(40), expect.any(String));
    });

    it('ignora silenciosamente erros de addTracker individuais (ex: duplicata)', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const globalTrackers = [
            'udp://tracker1.example.com:6969/announce',
            'udp://tracker2.example.com:6969/announce',
            'udp://tracker3.example.com:6969/announce',
        ];
        (settings.get as jest.Mock).mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 3,
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            globalTrackers,
            autoApplyGlobalTrackers: true,
        });
        (settings.getGlobalTrackers as jest.Mock).mockReturnValue(globalTrackers);

        // Segundo tracker lança erro (duplicata)
        (engine.addTracker as jest.Mock)
            .mockImplementationOnce(() => {}) // tracker1 OK
            .mockImplementationOnce(() => {
                throw new Error('Tracker já presente');
            }) // tracker2 falha
            .mockImplementationOnce(() => {}); // tracker3 OK

        const info = makeTorrentInfo({
            infoHash: INFO_HASH,
            name: 'Test Torrent',
            status: 'downloading',
        });
        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);

        const manager = createDownloadManager(engine, settings);
        // Não deve lançar exceção
        const item = await manager.addTorrentFile('/path/to/file.torrent');

        expect(item).toBeDefined();
        expect(item.infoHash).toBe(INFO_HASH);
        // Todos os 3 trackers foram tentados
        expect(engine.addTracker).toHaveBeenCalledTimes(3);
    });

    it('NÃO aplica trackers quando a lista global está vazia', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        (settings.get as jest.Mock).mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 3,
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            globalTrackers: [],
            autoApplyGlobalTrackers: true,
        });
        (settings.getGlobalTrackers as jest.Mock).mockReturnValue([]);

        const info = makeTorrentInfo({
            infoHash: INFO_HASH,
            name: 'Test Torrent',
            status: 'downloading',
        });
        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);

        const manager = createDownloadManager(engine, settings);
        await manager.addTorrentFile('/path/to/file.torrent');

        expect(engine.addTracker).not.toHaveBeenCalled();
    });
});

// ─── Property-based tests — Trackers globais resultam em superset ─────────────

// Feature: tracker-management, Propriedade 7: Após aplicar trackers globais, superset da lista global
describe('DownloadManager — Propriedade 7: Após aplicar trackers globais, superset da lista global', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    /**
     * **Validates: Requirements 6.1**
     *
     * Para qualquer lista de trackers globais válidos e qualquer torrent adicionado
     * com autoApplyGlobalTrackers habilitado, após a adição, o conjunto de trackers
     * do torrent SHALL ser um superset da lista global — ou seja, todo tracker global
     * SHALL ter sido passado ao engine.addTracker.
     */
    it('após aplicar trackers globais, todos os trackers globais são adicionados ao torrent', async () => {
        // Gerador de URLs de tracker válidas únicas
        const arbTrackerUrl = fc
            .record({
                protocol: fc.constantFrom('udp', 'http', 'https'),
                host: fc.stringMatching(/^[a-z][a-z0-9]{2,15}$/).filter((h) => h.length >= 3),
                port: fc.integer({ min: 1024, max: 65535 }),
            })
            .map(
                ({ protocol, host, port }) => `${protocol}://${host}.example.com:${port}/announce`,
            );

        const arbGlobalTrackers = fc
            .array(arbTrackerUrl, { minLength: 1, maxLength: 10 })
            .map((urls) => [...new Set(urls)]); // garantir unicidade

        await fc.assert(
            fc.asyncProperty(
                arbGlobalTrackers,
                fc.string({
                    unit: fc.constantFrom(...'0123456789abcdef'),
                    minLength: 40,
                    maxLength: 40,
                }),
                async (globalTrackers, hash) => {
                    const normalizedHash = hash.toLowerCase();

                    mockExistsSync.mockReturnValue(true);
                    mockAccessSync.mockReturnValue(undefined);

                    const engine = makeMockEngine();
                    const settings = makeMockSettings();

                    (settings.get as jest.Mock).mockReturnValue({
                        destinationFolder: '/downloads',
                        downloadSpeedLimit: 0,
                        uploadSpeedLimit: 0,
                        maxConcurrentDownloads: 3,
                        seedingEnabled: false,
                        maxConcurrentSeeders: 2,
                        notificationsEnabled: true,
                        globalTrackers,
                        autoApplyGlobalTrackers: true,
                    });
                    (settings.getGlobalTrackers as jest.Mock).mockReturnValue(globalTrackers);

                    const info = makeTorrentInfo({
                        infoHash: normalizedHash,
                        name: 'Test Torrent',
                        status: 'downloading',
                    });
                    (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);

                    const manager = createDownloadManager(engine, settings);
                    await manager.addTorrentFile('/path/to/file.torrent');

                    // Verificar que engine.addTracker foi chamado para cada tracker global
                    const addTrackerCalls = (engine.addTracker as jest.Mock).mock.calls;
                    const calledUrls = addTrackerCalls
                        .filter((call: [string, string]) => call[0] === normalizedHash)
                        .map((call: [string, string]) => call[1]);

                    // O conjunto de URLs chamadas deve ser superset da lista global
                    for (const trackerUrl of globalTrackers) {
                        if (!calledUrls.includes(trackerUrl)) return false;
                    }

                    return true;
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── done event populates metadata cache ─────────────────────────────────────

describe('DownloadManager — done event populates _metadataCache', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('getCachedMetadata retorna metadados do engine após evento done', async () => {
        const expectedMeta: TorrentMetadata = {
            infoHash: INFO_HASH,
            creator: 'TestCreator',
            comment: 'Test comment',
            creationDate: 1700000000000,
        };

        const engine = makeMockEngine(makeTorrentInfo({ status: 'downloading' as TorrentStatus }));
        (engine.getMetadata as jest.Mock).mockReturnValue(expectedMeta);
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, undefined, {
            disableCleanupTimer: true,
        });

        const info = makeTorrentInfo({ status: 'downloading' as TorrentStatus });
        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);
        await manager.addTorrentFile('/path/to/file.torrent');

        // Emitir evento done — deve capturar metadados do engine
        engine.emit('done', INFO_HASH);

        expect(manager.getCachedMetadata(INFO_HASH)).toEqual(expectedMeta);
    });
});

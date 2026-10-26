/**
 * Property-Based Tests for TorrentEngine file selection.
 *
 * Feature: torrent-file-selection
 * - Property 1: Extração completa de informações de arquivo
 * - Property 2: Aplicação correta de seleção/desseleção
 */

// Mock webtorrent before importing torrentEngine so Jest (CommonJS) never
// tries to parse the ESM-only webtorrent package.
jest.mock('webtorrent', () => {
    const MockWebTorrent = jest.fn().mockImplementation(() => ({
        torrents: [],
        throttleDownload: jest.fn(),
        throttleUpload: jest.fn(),
        add: jest.fn(),
        remove: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
    }));
    return { __esModule: true, default: MockWebTorrent };
});

import fc from 'fast-check';
import { access, stat } from 'fs/promises';
import { createTorrentEngine } from '../../main/torrentEngine';
import type WebTorrent from 'webtorrent';
import type { Torrent, TorrentFile } from 'webtorrent';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
    downloadPath: '/tmp/downloads',
    downloadSpeedLimit: 0,
    uploadSpeedLimit: 0,
    dhtEnabled: true,
    pexEnabled: true,
    utpEnabled: true,
};

/** Creates a fake WebTorrent File object */
function makeFakeFile(overrides: {
    name: string;
    path: string;
    length: number;
    downloaded: number;
}): TorrentFile {
    return {
        name: overrides.name,
        path: overrides.path,
        length: overrides.length,
        downloaded: overrides.downloaded,
        select: jest.fn(),
        deselect: jest.fn(),
        // Minimal stubs for other TorrentFile properties
        offset: 0,
        createReadStream: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
    } as unknown as TorrentFile;
}

/** Creates a fake Torrent with the given files */
function makeFakeTorrent(infoHash: string, files: TorrentFile[]): Torrent {
    return {
        infoHash,
        name: 'fake-torrent',
        length: files.reduce((sum, f) => sum + f.length, 0),
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        timeRemaining: Infinity,
        downloaded: 0,
        files,
        pause: jest.fn(),
        resume: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
    } as unknown as Torrent;
}

/** Creates a minimal mock WebTorrent client */
function makeMockClient(): WebTorrent & {
    throttleDownload: jest.Mock;
    throttleUpload: jest.Mock;
    torrents: Torrent[];
} {
    const torrents: Torrent[] = [];
    return {
        torrents,
        throttleDownload: jest.fn(),
        throttleUpload: jest.fn(),
        add: jest.fn(),
        remove: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
    } as unknown as WebTorrent & {
        throttleDownload: jest.Mock;
        throttleUpload: jest.Mock;
        torrents: Torrent[];
    };
}

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** Generates a non-empty file name */
const fileNameArb = fc.stringMatching(/^[a-zA-Z0-9_.-]{1,50}$/).filter((s) => s.length > 0);

/** Generates a non-empty file path */
const filePathArb = fc
    .tuple(fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/), fileNameArb)
    .map(([dir, name]) => `${dir}/${name}`);

/** Generates a single fake file descriptor */
const fileDescArb = fc.record({
    name: fileNameArb,
    path: filePathArb,
    length: fc.nat({ max: 10_000_000 }),
    downloaded: fc.nat({ max: 10_000_000 }),
});

/** Generates an array of 1..20 file descriptors */
const fileArrayArb = fc.array(fileDescArb, { minLength: 1, maxLength: 20 });

/** Generates a 40-char hex infoHash */
const infoHashArb = fc.string({
    unit: fc.constantFrom(...'0123456789abcdef'),
    minLength: 40,
    maxLength: 40,
});

// ─── Property 1: Extração completa de informações de arquivo ──────────────────

/**
 * Feature: torrent-file-selection, Property 1: Extração completa de informações de arquivo
 *
 * For any torrent with N files (N ≥ 1), getFiles(infoHash) must return exactly N
 * TorrentFileInfo objects, where each object contains name (non-empty string),
 * path (non-empty string), length (number ≥ 0), and index corresponding to the
 * position in the original array.
 *
 * **Validates: Requirements 1.1**
 */
describe('Feature: torrent-file-selection, Property 1: Extração completa de informações de arquivo', () => {
    it('getFiles returns exactly N TorrentFileInfo objects with correct fields for any torrent with N files', () => {
        fc.assert(
            fc.property(infoHashArb, fileArrayArb, (infoHash, fileDescs) => {
                const mockClient = makeMockClient();
                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                // Build fake files and torrent
                const fakeFiles = fileDescs.map((desc) => makeFakeFile(desc));
                const fakeTorrent = makeFakeTorrent(infoHash, fakeFiles);
                mockClient.torrents.push(fakeTorrent);

                // Initialize the selection map by simulating what addTorrentFile does:
                // We call setFileSelection with all indices to populate the selectionMap
                const allIndices = fileDescs.map((_, i) => i);
                engine.setFileSelection(infoHash, allIndices);

                const result = engine.getFiles(infoHash);

                // Must return exactly N items
                expect(result).toHaveLength(fileDescs.length);

                for (let i = 0; i < fileDescs.length; i++) {
                    const info = result[i];
                    const desc = fileDescs[i];

                    // index corresponds to position in original array
                    expect(info.index).toBe(i);

                    // name is a non-empty string matching the original
                    expect(typeof info.name).toBe('string');
                    expect(info.name.length).toBeGreaterThan(0);
                    expect(info.name).toBe(desc.name);

                    // path is a non-empty string matching the original
                    expect(typeof info.path).toBe('string');
                    expect(info.path.length).toBeGreaterThan(0);
                    expect(info.path).toBe(desc.path);

                    // length is a number >= 0
                    expect(typeof info.length).toBe('number');
                    expect(info.length).toBeGreaterThanOrEqual(0);
                    expect(info.length).toBe(desc.length);
                }
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Property 2: Aplicação correta de seleção/desseleção ─────────────────────

/**
 * Feature: torrent-file-selection, Property 2: Aplicação correta de seleção/desseleção
 *
 * For any torrent with N files and any non-empty subset S of valid indices [0, N-1],
 * after calling setFileSelection(infoHash, S), each file whose index is in S must
 * have selected = true and each file whose index is not in S must have selected = false.
 *
 * **Validates: Requirements 2.1, 2.5**
 */
describe('Feature: torrent-file-selection, Property 2: Aplicação correta de seleção/desseleção', () => {
    it('after setFileSelection(infoHash, S), selected files match S exactly', () => {
        // Generate file array first, then derive a non-empty subset of valid indices
        const testDataArb = fileArrayArb.chain((fileDescs) => {
            const n = fileDescs.length;
            // Generate a non-empty subset of [0, n-1]
            const subsetArb = fc.subarray(
                Array.from({ length: n }, (_, i) => i),
                { minLength: 1, maxLength: n },
            );
            return fc.tuple(fc.constant(fileDescs), subsetArb);
        });

        fc.assert(
            fc.property(infoHashArb, testDataArb, (infoHash, [fileDescs, selectedIndices]) => {
                const n = fileDescs.length;

                const mockClient = makeMockClient();
                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                const fakeFiles = fileDescs.map((desc) => makeFakeFile(desc));
                const fakeTorrent = makeFakeTorrent(infoHash, fakeFiles);
                mockClient.torrents.push(fakeTorrent);

                // Apply selection
                const result = engine.setFileSelection(infoHash, selectedIndices);

                expect(result).toHaveLength(n);

                const selectedSet = new Set(selectedIndices);
                for (let i = 0; i < n; i++) {
                    if (selectedSet.has(i)) {
                        expect(result[i].selected).toBe(true);
                    } else {
                        expect(result[i].selected).toBe(false);
                    }
                }

                // Verify file.select() / file.deselect() were called correctly
                for (let i = 0; i < n; i++) {
                    const file = fakeFiles[i];
                    if (selectedSet.has(i)) {
                        expect(file.select).toHaveBeenCalled();
                    } else {
                        expect(file.deselect).toHaveBeenCalled();
                    }
                }
            }),
            { numRuns: 100 },
        );
    });

    it('setFileSelection with all indices results in all files selected', () => {
        fc.assert(
            fc.property(infoHashArb, fileArrayArb, (infoHash, fileDescs) => {
                const mockClient = makeMockClient();
                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                const fakeFiles = fileDescs.map((desc) => makeFakeFile(desc));
                const fakeTorrent = makeFakeTorrent(infoHash, fakeFiles);
                mockClient.torrents.push(fakeTorrent);

                const allIndices = fileDescs.map((_, i) => i);
                const result = engine.setFileSelection(infoHash, allIndices);

                expect(result).toHaveLength(fileDescs.length);
                for (const info of result) {
                    expect(info.selected).toBe(true);
                }
            }),
            { numRuns: 100 },
        );
    });

    it('setFileSelection with a single index selects only that file', () => {
        fc.assert(
            fc.property(
                infoHashArb,
                fc.array(fileDescArb, { minLength: 2, maxLength: 20 }),
                (infoHash, fileDescs) => {
                    const mockClient = makeMockClient();
                    const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                    const fakeFiles = fileDescs.map((desc) => makeFakeFile(desc));
                    const fakeTorrent = makeFakeTorrent(infoHash, fakeFiles);
                    mockClient.torrents.push(fakeTorrent);

                    // Pick a single index deterministically
                    const singleIndex = infoHash.charCodeAt(0) % fileDescs.length;
                    const result = engine.setFileSelection(infoHash, [singleIndex]);

                    expect(result).toHaveLength(fileDescs.length);
                    for (let i = 0; i < fileDescs.length; i++) {
                        expect(result[i].selected).toBe(i === singleIndex);
                    }
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── DownloadManager file selection tests ─────────────────────────────────────

// We need to mock 'fs' for DownloadManager (folder validation)
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn().mockReturnValue(true),
    accessSync: jest.fn().mockReturnValue(undefined),
}));

beforeEach(() => {
    jest.mocked(stat).mockResolvedValue({ isDirectory: () => true } as Awaited<
        ReturnType<typeof stat>
    >);
    jest.mocked(access).mockResolvedValue(undefined);
});

import { EventEmitter } from 'events';
import { createDownloadManager } from '../../main/downloadManager';
import type { TorrentEngine, TorrentInfo } from '../../main/torrentEngine';
import type { SettingsManager } from '../../main/settingsManager';
import type { PersistedDownloadItem, PersistedStore } from '../../main/downloadManager';
import type { TorrentStatus, TorrentFileInfo as TorrentFileInfoType } from '../../shared/types';

// ─── DownloadManager Helpers ──────────────────────────────────────────────────

function makeDMTorrentInfo(overrides: Partial<TorrentInfo> = {}): TorrentInfo {
    return {
        infoHash: 'a'.repeat(40),
        name: 'Test Torrent',
        totalSize: 0,
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

function makeDMMockEngine(): TorrentEngine & EventEmitter {
    const emitter = new EventEmitter();

    const engine: TorrentEngine & EventEmitter = Object.assign(emitter, {
        addTorrentFile: jest.fn(),

        detachTorrent: jest.fn().mockResolvedValue(undefined),

        getTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn(),
        addMagnetLink: jest.fn(),
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

function makeDMMockSettings(folder = '/downloads'): SettingsManager {
    return {
        get: jest.fn().mockReturnValue({
            destinationFolder: folder,
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
        }),
        set: jest.fn(),
        getDefaultDownloadFolder: jest.fn().mockReturnValue(folder),
    } as unknown as SettingsManager;
}

function makeDMMockStore(initial: PersistedDownloadItem[] = []): PersistedStore {
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

// ─── Arbitraries for DownloadManager tests ────────────────────────────────────

/** Generates a file with length and downloaded amounts */
const dmFileArb = fc
    .record({
        name: fc.stringMatching(/^[a-zA-Z0-9_.-]{1,30}$/).filter((s) => s.length > 0),
        path: fc.stringMatching(/^[a-zA-Z0-9_.-]{1,30}$/).filter((s) => s.length > 0),
        length: fc.integer({ min: 1, max: 10_000_000 }),
        downloaded: fc.integer({ min: 0, max: 10_000_000 }),
    })
    .map((f) => ({
        ...f,
        // Ensure downloaded <= length
        downloaded: Math.min(f.downloaded, f.length),
    }));

/** Generates an array of 1..15 files */
const dmFileArrayArb = fc.array(dmFileArb, { minLength: 1, maxLength: 15 });

// ─── Property 6: Progresso e totalSize refletem apenas arquivos selecionados ──

/**
 * Feature: torrent-file-selection, Property 6: Progresso e totalSize refletem apenas arquivos selecionados
 *
 * For any torrent with files of varying sizes and download states, when some files
 * are deselected: `totalSize` must equal the sum of `length` of selected files,
 * and `progress` must equal `sum(downloaded of selected) / sum(length of selected)`.
 *
 * **Validates: Requirements 4.1, 4.2**
 */
describe('Feature: torrent-file-selection, Property 6: Progresso e totalSize refletem apenas arquivos selecionados', () => {
    it('after setFileSelection, totalSize equals sum of selected file lengths and progress equals sum(downloaded)/sum(length)', async () => {
        // Generate files, then derive a non-empty subset of valid indices
        const testDataArb = dmFileArrayArb.chain((files) => {
            const n = files.length;
            const subsetArb = fc.subarray(
                Array.from({ length: n }, (_, i) => i),
                { minLength: 1, maxLength: n },
            );
            return fc.tuple(fc.constant(files), subsetArb);
        });

        await fc.assert(
            fc.asyncProperty(
                infoHashArb,
                testDataArb,
                async (infoHash, [fileDescs, selectedIndices]) => {
                    const engine = makeDMMockEngine();
                    const settings = makeDMMockSettings();
                    const manager = createDownloadManager(engine, settings);

                    // Set up engine.addTorrentFile to return a valid TorrentInfo
                    const totalSize = fileDescs.reduce((sum, f) => sum + f.length, 0);
                    const info = makeDMTorrentInfo({
                        infoHash,
                        totalSize,
                        status: 'downloading',
                    });
                    (engine.addTorrentFile as jest.Mock).mockResolvedValue(info);

                    // Build the TorrentFileInfo array that engine.setFileSelection will return
                    const selectedSet = new Set(selectedIndices);
                    const updatedFiles: TorrentFileInfoType[] = fileDescs.map((f, i) => ({
                        index: i,
                        name: f.name,
                        path: f.path,
                        length: f.length,
                        downloaded: f.downloaded,
                        selected: selectedSet.has(i),
                    }));

                    (engine.setFileSelection as jest.Mock).mockReturnValue(updatedFiles);
                    (engine.getFiles as jest.Mock).mockReturnValue(updatedFiles);

                    const { existsSync, accessSync } = require('fs');
                    (existsSync as jest.Mock).mockReturnValue(true);
                    (accessSync as jest.Mock).mockReturnValue(undefined);

                    await manager.addTorrentFile('/fake/path.torrent');

                    // Now call setFileSelection
                    manager.setFileSelection(infoHash, selectedIndices);

                    // Get the updated item
                    const all = manager.getAll();
                    const item = all.find((i) => i.infoHash === infoHash);

                    if (!item) return false;

                    // Calculate expected values
                    const selectedFiles = fileDescs.filter((_, i) => selectedSet.has(i));
                    const expectedTotalSize = selectedFiles.reduce((sum, f) => sum + f.length, 0);
                    const expectedDownloaded = selectedFiles.reduce(
                        (sum, f) => sum + f.downloaded,
                        0,
                    );
                    const expectedProgress =
                        expectedTotalSize > 0 ? expectedDownloaded / expectedTotalSize : 0;

                    // Verify totalSize
                    if (item.totalSize !== expectedTotalSize) return false;

                    // Verify progress (with floating point tolerance)
                    if (Math.abs(item.progress - expectedProgress) > 1e-10) return false;

                    return true;
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── Property 7: Round-trip de persistência de seleção ────────────────────────

/**
 * Feature: torrent-file-selection, Property 7: Round-trip de persistência de seleção
 *
 * For any array of valid selected indices, after `persistSession()` followed by
 * `restoreSession()`, the selected file indices must equal the original indices
 * (filtering out invalid ones that exceed the torrent's file count).
 *
 * **Validates: Requirements 5.1, 5.2, 5.3**
 */
describe('Feature: torrent-file-selection, Property 7: Round-trip de persistência de seleção', () => {
    it('persist then restore preserves selectedFileIndices, filtering out invalid indices', async () => {
        // Generate a file count and an array of indices (some possibly out of range)
        const testDataArb = fc.integer({ min: 1, max: 20 }).chain((fileCount) => {
            // Generate indices that may include some out-of-range values
            const indicesArb = fc
                .array(fc.integer({ min: 0, max: fileCount + 5 }), {
                    minLength: 1,
                    maxLength: fileCount + 5,
                })
                .map((indices) => [...new Set(indices)]); // deduplicate

            return fc.tuple(fc.constant(fileCount), indicesArb);
        });

        await fc.assert(
            fc.asyncProperty(
                infoHashArb,
                testDataArb,
                async (infoHash, [fileCount, selectedIndices]) => {
                    const { existsSync, accessSync } = require('fs');
                    (existsSync as jest.Mock).mockReturnValue(true);
                    (accessSync as jest.Mock).mockReturnValue(undefined);

                    // Build fake files for the engine
                    const fakeFiles: TorrentFileInfoType[] = Array.from(
                        { length: fileCount },
                        (_, i) => ({
                            index: i,
                            name: `file${i}.dat`,
                            path: `dir/file${i}.dat`,
                            length: 1000 * (i + 1),
                            downloaded: 0,
                            selected: true,
                        }),
                    );

                    // Filter to valid indices for the initial selection
                    const validIndices = selectedIndices.filter(
                        (idx) => idx >= 0 && idx < fileCount,
                    );
                    if (validIndices.length === 0) return true; // skip if no valid indices

                    // ── Manager 1: add torrent, set selection, persist ──
                    const engine1 = makeDMMockEngine();
                    const settings = makeDMMockSettings();
                    const store = makeDMMockStore();

                    const info = makeDMTorrentInfo({
                        infoHash,
                        totalSize: fakeFiles.reduce((s, f) => s + f.length, 0),
                        status: 'downloading',
                    });
                    (engine1.addTorrentFile as jest.Mock).mockResolvedValue(info);

                    // setFileSelection returns files with updated selection
                    const selectedSet = new Set(validIndices);
                    const updatedFiles = fakeFiles.map((f) => ({
                        ...f,
                        selected: selectedSet.has(f.index),
                    }));
                    (engine1.setFileSelection as jest.Mock).mockReturnValue(updatedFiles);
                    (engine1.getFiles as jest.Mock).mockReturnValue(updatedFiles);

                    const manager1 = createDownloadManager(engine1, settings, store);
                    await manager1.addTorrentFile('/fake/path.torrent');
                    manager1.setFileSelection(infoHash, selectedIndices);
                    manager1.persistSession();

                    // Verify the persisted data contains selectedFileIndices
                    const persistedData = (store.set as jest.Mock).mock
                        .calls[0][1] as PersistedDownloadItem[];
                    const persistedItem = persistedData.find((p) => p.infoHash === infoHash);
                    if (!persistedItem) return false;

                    // The persisted indices should match what was passed to setFileSelection
                    // (the DownloadManager stores the raw indices passed to it)
                    const persistedIndices = persistedItem.selectedFileIndices;
                    if (!persistedIndices) return false;

                    // ── Manager 2: restore session, verify selection reapplied ──
                    const engine2 = makeDMMockEngine();
                    (engine2.addTorrentFile as jest.Mock).mockResolvedValue(info);
                    (engine2.getFiles as jest.Mock).mockReturnValue(fakeFiles);
                    (engine2.setFileSelection as jest.Mock).mockReturnValue(updatedFiles);

                    const manager2 = createDownloadManager(engine2, settings, store);
                    await manager2.restoreSession();

                    // Verify engine2.setFileSelection was called with only valid indices
                    if ((engine2.setFileSelection as jest.Mock).mock.calls.length === 0) {
                        // If no call was made, the persisted indices might have all been invalid
                        // Check that there are no valid indices
                        return validIndices.length === 0;
                    }

                    const restoredCall = (engine2.setFileSelection as jest.Mock).mock.calls[0];
                    const restoredInfoHash = restoredCall[0] as string;
                    const restoredIndices = restoredCall[1] as number[];

                    if (restoredInfoHash !== infoHash) return false;

                    // The restored indices should be exactly the valid subset
                    const sortedRestored = [...restoredIndices].sort((a, b) => a - b);
                    const sortedValid = [...validIndices].sort((a, b) => a - b);

                    if (sortedRestored.length !== sortedValid.length) return false;
                    for (let i = 0; i < sortedRestored.length; i++) {
                        if (sortedRestored[i] !== sortedValid[i]) return false;
                    }

                    return true;
                },
            ),
            { numRuns: 100 },
        );
    });
});

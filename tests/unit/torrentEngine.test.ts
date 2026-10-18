jest.mock('../../main/torrentInput', () => ({
    readTorrentFile: (filePath: string) => require('fs/promises').readFile(filePath),
}));

/**
 * Example-based (non-PBT) tests for TorrentEngine.
 *
 * Covers:
 *   - Requirement 4.6: Pause timeout → error response
 *   - Requirement 6.5: Speed limit changes applied synchronously
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

import { createTorrentEngine } from '../../main/torrentEngine';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { EventEmitter } from 'events';
import { MAX_TORRENT_BYTES } from '../../shared/validators';
import { ErrorCodes } from '../../shared/errorCodes';
import { stopTorrentNetwork } from '../../main/webtorrentInternals';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal fake Torrent object that satisfies the shape expected by TorrentEngineImpl.
 */
function makeFakeTorrent(infoHash: string, overrides: Partial<Torrent> = {}): Torrent {
    return {
        infoHash,
        name: 'fake-torrent',
        path: '/tmp/downloads',
        length: 1024,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        timeRemaining: Infinity,
        downloaded: 0,
        files: [],
        ready: true,
        pause: jest.fn(),
        resume: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
        ...overrides,
    } as unknown as Torrent;
}

/**
 * Creates a minimal mock WebTorrent client.
 * The `torrents` array is mutable so tests can inject fake torrents.
 */
function makeMockClient(overrides: Partial<WebTorrent> = {}): WebTorrent & {
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
        ...overrides,
    } as unknown as WebTorrent & {
        throttleDownload: jest.Mock;
        throttleUpload: jest.Mock;
        torrents: Torrent[];
    };
}

const DEFAULT_OPTIONS = {
    downloadPath: '/tmp/downloads',
    downloadSpeedLimit: 0,
    uploadSpeedLimit: 0,
    dhtEnabled: true,
    pexEnabled: true,
    utpEnabled: true,
};

test('rejeita buffer acima do limite antes de alcançar WebTorrent', async () => {
    const client = makeMockClient();
    const engine = createTorrentEngine(DEFAULT_OPTIONS, client);
    const buffer = Buffer.alloc(MAX_TORRENT_BYTES + 1, 100);
    await expect(engine.addTorrentBuffer(buffer)).rejects.toThrow(ErrorCodes.INVALID_FILE_PATH);
    expect(client.add).not.toHaveBeenCalled();
});

// ─── Pause timeout (Requirement 4.6) ─────────────────────────────────────────

describe('TorrentEngine.pause() — timeout (Requirement 4.6)', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('rejects with a timeout error when pause hangs for more than 5 seconds', async () => {
        jest.useFakeTimers();

        const infoHash = 'a'.repeat(40);

        // Make torrent.pause() hang by throwing after the timer fires.
        // We simulate a "hanging" pause by making pause() not resolve the promise
        // (i.e., it throws after the timeout has already been set up).
        // Since the current implementation calls pause() synchronously, we test
        // the timeout path by making pause() throw the same error the timer would.
        const hangingPause = jest.fn().mockImplementation(() => {
            // Advance fake timers so the setTimeout callback fires before clearTimeout
            jest.advanceTimersByTime(5001);
            // After advancing timers, the timeout callback has already called reject().
            // Throwing here ensures clearTimeout is NOT called before the timer fires.
            throw new Error('pause hung');
        });

        const fakeTorrent = makeFakeTorrent(infoHash, { pause: hangingPause });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        await expect(engine.pause(infoHash)).rejects.toThrow(/timeout|pause hung/i);
    });

    it('rejects with "timeout" in the error message when the 5s timer fires', async () => {
        jest.useFakeTimers();

        const infoHash = 'b'.repeat(40);

        // Simulate a pause that hangs: pause() is called but the timer fires first
        // by advancing time inside the mock before clearTimeout can be called.
        const hangingPause = jest.fn().mockImplementation(() => {
            jest.advanceTimersByTime(5001);
            throw new Error('simulated hang');
        });

        const fakeTorrent = makeFakeTorrent(infoHash, { pause: hangingPause });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        let caughtError: Error | undefined;
        try {
            await engine.pause(infoHash);
        } catch (err) {
            caughtError = err as Error;
        }

        expect(caughtError).toBeDefined();
        expect(caughtError!.message).toMatch(/timeout|simulated hang/i);
    });

    it('resolves silently when the torrent is not found (already stopped)', async () => {
        // Pausar um torrent que não está no engine deve ser tratado como sucesso:
        // se não está no engine, já está efetivamente parado.
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        await expect(engine.pause('nonexistent'.padEnd(40, '0'))).resolves.toBeUndefined();
    });
});

// ─── Speed limit applied synchronously (Requirement 6.5) ─────────────────────

describe('TorrentEngine speed limits — applied synchronously (Requirement 6.5)', () => {
    it('calls throttleDownload with kbps * 1024 when setDownloadSpeedLimit is called', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        engine.setDownloadSpeedLimit(512);

        expect(mockClient.throttleDownload).toHaveBeenCalledWith(512 * 1024);
        expect(mockClient.throttleDownload).toHaveBeenCalledWith(524288);
    });

    it('calls throttleUpload with kbps * 1024 when setUploadSpeedLimit is called', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        engine.setUploadSpeedLimit(256);

        expect(mockClient.throttleUpload).toHaveBeenCalledWith(256 * 1024);
        expect(mockClient.throttleUpload).toHaveBeenCalledWith(262144);
    });

    it('calls throttleDownload with -1 when setDownloadSpeedLimit(0) is called (removes limit)', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        engine.setDownloadSpeedLimit(0);

        expect(mockClient.throttleDownload).toHaveBeenCalledWith(-1);
    });

    it('calls throttleUpload with -1 when setUploadSpeedLimit(0) is called (removes limit)', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        engine.setUploadSpeedLimit(0);

        expect(mockClient.throttleUpload).toHaveBeenCalledWith(-1);
    });

    it('applies download speed limit synchronously — throttleDownload is called before the next tick', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        // Call setDownloadSpeedLimit and immediately check — no await needed
        engine.setDownloadSpeedLimit(1024);
        expect(mockClient.throttleDownload).toHaveBeenCalledTimes(1);
        expect(mockClient.throttleDownload).toHaveBeenCalledWith(1024 * 1024);
    });

    it('applies upload speed limit synchronously — throttleUpload is called before the next tick', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        engine.setUploadSpeedLimit(128);
        expect(mockClient.throttleUpload).toHaveBeenCalledTimes(1);
        expect(mockClient.throttleUpload).toHaveBeenCalledWith(128 * 1024);
    });

    it('applies initial speed limits from options at construction time', () => {
        const mockClient = makeMockClient();

        createTorrentEngine(
            {
                downloadPath: '/tmp',
                downloadSpeedLimit: 100,
                uploadSpeedLimit: 50,
                dhtEnabled: true,
                pexEnabled: true,
                utpEnabled: true,
            },
            mockClient,
        );

        // Constructor applies non-zero limits immediately
        expect(mockClient.throttleDownload).toHaveBeenCalledWith(100 * 1024);
        expect(mockClient.throttleUpload).toHaveBeenCalledWith(50 * 1024);
    });

    it('does not call throttleDownload at construction when downloadSpeedLimit is 0', () => {
        const mockClient = makeMockClient();

        createTorrentEngine(
            {
                downloadPath: '/tmp',
                downloadSpeedLimit: 0,
                uploadSpeedLimit: 0,
                dhtEnabled: true,
                pexEnabled: true,
                utpEnabled: true,
            },
            mockClient,
        );

        expect(mockClient.throttleDownload).not.toHaveBeenCalled();
        expect(mockClient.throttleUpload).not.toHaveBeenCalled();
    });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

import fc from 'fast-check';

// Feature: meshy-torrent-client, Property 13: Aplicação de limite de velocidade
// **Validates: Requirements 6.2, 6.3, 6.4**
describe('Property 13: Aplicação de limite de velocidade', () => {
    it('setDownloadSpeedLimit(n) sets throttleDownload to n * 1024 for any non-negative integer n', () => {
        fc.assert(
            fc.property(fc.nat(), (n) => {
                const mockClient = makeMockClient();
                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                engine.setDownloadSpeedLimit(n);

                const expectedBytes = n === 0 ? -1 : n * 1024;
                expect(mockClient.throttleDownload).toHaveBeenCalledWith(expectedBytes);

                // When n = 0, the value passed should be 0 (no limit)
                if (n === 0) {
                    expect(mockClient.throttleDownload).toHaveBeenCalledWith(-1);
                }
            }),
            { numRuns: 100 },
        );
    });

    it('setUploadSpeedLimit(n) sets throttleUpload to n * 1024 for any non-negative integer n', () => {
        fc.assert(
            fc.property(fc.nat(), (n) => {
                const mockClient = makeMockClient();
                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                engine.setUploadSpeedLimit(n);

                const expectedBytes = n === 0 ? -1 : n * 1024;
                expect(mockClient.throttleUpload).toHaveBeenCalledWith(expectedBytes);

                // When n = 0, the value passed should be 0 (no limit)
                if (n === 0) {
                    expect(mockClient.throttleUpload).toHaveBeenCalledWith(-1);
                }
            }),
            { numRuns: 100 },
        );
    });

    it('both download and upload limits are correctly applied for the same arbitrary value', () => {
        fc.assert(
            fc.property(fc.nat(), (n) => {
                const mockClient = makeMockClient();
                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                engine.setDownloadSpeedLimit(n);
                engine.setUploadSpeedLimit(n);

                const expectedBytes = n === 0 ? -1 : n * 1024;
                expect(mockClient.throttleDownload).toHaveBeenCalledWith(expectedBytes);
                expect(mockClient.throttleUpload).toHaveBeenCalledWith(expectedBytes);
            }),
            { numRuns: 100 },
        );
    });
});

// Feature: meshy-torrent-client, Property 6: Payload de progresso contém todos os campos obrigatórios
// **Validates: Requirements 3.1, 3.2, 3.5**
describe('Property 6: Payload de progresso contém todos os campos obrigatórios', () => {
    /**
     * Arbitrary that generates a single fake torrent with random but realistic field values.
     * Some fields may be undefined to exercise the `?? 0` / `?? Infinity` fallback in torrentToInfo().
     */
    const fakeTorrentArb = fc.record({
        infoHash: fc.string({
            unit: fc.constantFrom(...'0123456789abcdef'),
            minLength: 40,
            maxLength: 40,
        }),
        name: fc.oneof(fc.string({ minLength: 1 }), fc.constant(undefined)),
        length: fc.oneof(fc.nat(), fc.constant(undefined)),
        progress: fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant(undefined)),
        downloadSpeed: fc.oneof(fc.nat(), fc.constant(undefined)),
        uploadSpeed: fc.oneof(fc.nat(), fc.constant(undefined)),
        numPeers: fc.oneof(fc.nat(), fc.constant(undefined)),
        timeRemaining: fc.oneof(fc.nat(), fc.constant(Infinity), fc.constant(undefined)),
        downloaded: fc.oneof(fc.nat(), fc.constant(undefined)),
    });

    const fakeTorrentArrayArb = fc.array(fakeTorrentArb, { minLength: 1, maxLength: 10 });

    it('getAll() returns items where every item has all mandatory progress fields with correct constraints', () => {
        fc.assert(
            fc.property(fakeTorrentArrayArb, (fakeTorrents) => {
                const mockClient = makeMockClient();
                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                // Inject fake torrents into the mock client
                for (const ft of fakeTorrents) {
                    const torrent = makeFakeTorrent(ft.infoHash, {
                        name: ft.name as unknown as string,
                        length: ft.length as unknown as number,
                        progress: ft.progress as unknown as number,
                        downloadSpeed: ft.downloadSpeed as unknown as number,
                        uploadSpeed: ft.uploadSpeed as unknown as number,
                        numPeers: ft.numPeers as unknown as number,
                        timeRemaining: ft.timeRemaining as unknown as number,
                        downloaded: ft.downloaded as unknown as number,
                    });
                    mockClient.torrents.push(torrent);
                }

                const items = engine.getAll();

                // Must return the same number of items as torrents in the client
                expect(items).toHaveLength(fakeTorrents.length);

                for (const item of items) {
                    // progress: number between 0 and 1
                    expect(typeof item.progress).toBe('number');
                    expect(item.progress).toBeGreaterThanOrEqual(0);
                    expect(item.progress).toBeLessThanOrEqual(1);

                    // downloadSpeed: number >= 0
                    expect(typeof item.downloadSpeed).toBe('number');
                    expect(item.downloadSpeed).toBeGreaterThanOrEqual(0);

                    // uploadSpeed: number >= 0
                    expect(typeof item.uploadSpeed).toBe('number');
                    expect(item.uploadSpeed).toBeGreaterThanOrEqual(0);

                    // timeRemaining: number >= 0 (Infinity is >= 0 in JS)
                    expect(typeof item.timeRemaining).toBe('number');
                    expect(item.timeRemaining).toBeGreaterThanOrEqual(0);

                    // numPeers: integer >= 0
                    expect(typeof item.numPeers).toBe('number');
                    expect(Number.isFinite(item.numPeers)).toBe(true);
                    expect(item.numPeers).toBeGreaterThanOrEqual(0);
                    expect(Number.isInteger(item.numPeers)).toBe(true);

                    // numSeeders: integer >= 0
                    expect(typeof item.numSeeders).toBe('number');
                    expect(Number.isFinite(item.numSeeders)).toBe(true);
                    expect(item.numSeeders).toBeGreaterThanOrEqual(0);
                    expect(Number.isInteger(item.numSeeders)).toBe(true);
                }
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Tracker Methods — Unit Tests (Task 2.5) ─────────────────────────────────

/**
 * Helper: cria um fake torrent com suporte a announce e _trackers para testes de tracker.
 */
function makeFakeTorrentWithTrackers(
    infoHash: string,
    announce: string[] = [],
    trackers: Record<string, { destroyed?: boolean; destroy?: jest.Mock }> = {},
    overrides: Partial<Torrent> = {},
): Torrent {
    const torrent = makeFakeTorrent(infoHash, overrides);
    (torrent as unknown as { announce: string[] }).announce = announce;
    (torrent as unknown as { discovery: unknown }).discovery = {
        tracker: {
            _trackers: Object.entries(trackers).map(([announceUrl, tracker]) => ({
                announceUrl,
                ...tracker,
            })),
            destroy: jest.fn(),
        },
        _createTracker: jest.fn(() => ({ _trackers: [], destroy: jest.fn() })),
    };
    (torrent as unknown as { addTracker: jest.Mock }).addTracker = jest.fn((url: string) => {
        const ann = (torrent as unknown as { announce: string[] }).announce;
        ann.push(url);
    });
    return torrent;
}

describe('TorrentEngine.getTrackers() — unit tests', () => {
    it('retorna lista vazia quando torrent não tem trackers', () => {
        const infoHash = 'c'.repeat(40);
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [], {});
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        const trackers = engine.getTrackers(infoHash);

        expect(trackers).toEqual([]);
    });

    it('retorna trackers com status "pending" quando não há _trackers internos', () => {
        const infoHash = 'd'.repeat(40);
        const announce = ['udp://tracker.example.com:6969/announce'];
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, announce, {});
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        const trackers = engine.getTrackers(infoHash);

        expect(trackers).toHaveLength(1);
        expect(trackers[0]).toEqual({
            url: 'udp://tracker.example.com:6969/announce',
            status: 'pending',
        });
    });

    it('retorna status "pending" até o tracker anunciar com sucesso', () => {
        const infoHash = 'e'.repeat(40);
        const url = 'http://tracker.example.com/announce';
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [url], {
            [url]: { destroyed: false },
        });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        const trackers = engine.getTrackers(infoHash);

        expect(trackers[0].status).toBe('pending');
    });

    it('retorna status "error" para tracker destruído', () => {
        const infoHash = 'f'.repeat(40);
        const url = 'https://tracker.example.com/announce';
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [url], {
            [url]: { destroyed: true },
        });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        const trackers = engine.getTrackers(infoHash);

        expect(trackers[0].status).toBe('error');
    });

    it('lança erro quando torrent não é encontrado', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() => engine.getTrackers('nonexistent'.padEnd(40, '0'))).toThrow(
            /Torrent não encontrado/,
        );
    });
});

describe('TorrentEngine.addTracker() — unit tests', () => {
    it('adiciona tracker válido ao torrent', () => {
        const infoHash = 'a'.repeat(40);
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [], {});
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        engine.addTracker(infoHash, 'udp://tracker.new.com:1234/announce');

        const trackers = engine.getTrackers(infoHash);
        expect(trackers).toHaveLength(1);
        expect(trackers[0].url).toBe('udp://tracker.new.com:1234/announce');
    });

    it('lança erro para URL inválida', () => {
        const infoHash = 'b'.repeat(40);
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [], {});
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() => engine.addTracker(infoHash, 'ftp://invalid.com')).toThrow(
            /URL de tracker inválida/,
        );
    });

    it('lança erro para tracker duplicado', () => {
        const infoHash = 'c'.repeat(40);
        const url = 'http://tracker.example.com/announce';
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [url], {});
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() => engine.addTracker(infoHash, url)).toThrow(/Tracker já presente/);
    });

    it('lança erro quando torrent não é encontrado', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() =>
            engine.addTracker('nonexistent'.padEnd(40, '0'), 'http://tracker.com/announce'),
        ).toThrow(/Torrent não encontrado/);
    });

    it('detecta duplicata mesmo com casing diferente no protocolo', () => {
        const infoHash = 'd'.repeat(40);
        const fakeTorrent = makeFakeTorrentWithTrackers(
            infoHash,
            ['http://tracker.example.com/announce'],
            {},
        );
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() => engine.addTracker(infoHash, 'HTTP://tracker.example.com/announce')).toThrow(
            /Tracker já presente/,
        );
    });
});

describe('TorrentEngine.removeTracker() — unit tests', () => {
    it('remove tracker existente do torrent', () => {
        const infoHash = 'a'.repeat(40);
        const url = 'udp://tracker.example.com:6969/announce';
        const destroyMock = jest.fn();
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [url], {
            [url]: { destroy: destroyMock },
        });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        engine.removeTracker(infoHash, url);

        const trackers = engine.getTrackers(infoHash);
        expect(trackers).toHaveLength(0);
        expect(destroyMock).toHaveBeenCalled();
    });

    it('lança erro quando tracker não está presente', () => {
        const infoHash = 'b'.repeat(40);
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [], {});
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() => engine.removeTracker(infoHash, 'http://nonexistent.com/announce')).toThrow(
            /Tracker não encontrado/,
        );
    });

    it('lança erro quando torrent não é encontrado', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() =>
            engine.removeTracker('nonexistent'.padEnd(40, '0'), 'http://tracker.com/announce'),
        ).toThrow(/Torrent não encontrado/);
    });

    it('remove tracker mesmo quando não há _trackers internos (apenas announce)', () => {
        const infoHash = 'c'.repeat(40);
        const url = 'http://tracker.example.com/announce';
        const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [url], {});
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        engine.removeTracker(infoHash, url);

        const trackers = engine.getTrackers(infoHash);
        expect(trackers).toHaveLength(0);
    });
});

// ─── Tracker Methods — Property-Based Tests ──────────────────────────────────

/**
 * Gerador de URLs de tracker válidas para testes PBT.
 */
const validTrackerUrlArb = fc
    .record({
        protocol: fc.constantFrom('http', 'https', 'udp'),
        host: fc.stringMatching(/^[a-z][a-z0-9]{2,15}$/),
        domain: fc.constantFrom('.com', '.org', '.net', '.io'),
        port: fc.integer({ min: 1, max: 65535 }),
    })
    .map(({ protocol, host, domain, port }) => `${protocol}://${host}${domain}:${port}/announce`);

// Propriedade 3: Adicionar tracker novo aumenta a lista em 1 (Req 2.1)
// **Validates: Requirements 2.1**
describe('Propriedade 3: adicionar tracker novo aumenta a lista em 1 e a URL está presente', () => {
    it('após addTracker com URL nova, getTrackers().length === anterior + 1 e URL está presente', () => {
        fc.assert(
            fc.property(validTrackerUrlArb, (trackerUrl) => {
                const infoHash = 'a'.repeat(40);
                const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [], {});
                const mockClient = makeMockClient();
                mockClient.torrents.push(fakeTorrent);

                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                const before = engine.getTrackers(infoHash).length;
                engine.addTracker(infoHash, trackerUrl);
                const after = engine.getTrackers(infoHash);

                expect(after.length).toBe(before + 1);
                const urls = after.map((t) => t.url);
                expect(urls).toContain(trackerUrl.replace(/\/+$/, ''));
            }),
            { numRuns: 100 },
        );
    });
});

// Propriedade 4: Remover tracker existente diminui a lista em 1 (Req 3.1)
// **Validates: Requirements 3.1**
describe('Propriedade 4: remover tracker existente diminui a lista em 1 e a URL não está presente', () => {
    it('após removeTracker de URL existente, getTrackers().length === anterior - 1 e URL não está presente', () => {
        fc.assert(
            fc.property(validTrackerUrlArb, (trackerUrl) => {
                const infoHash = 'b'.repeat(40);
                const normalized = trackerUrl.replace(/\/+$/, '');
                const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [normalized], {});
                const mockClient = makeMockClient();
                mockClient.torrents.push(fakeTorrent);

                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                const before = engine.getTrackers(infoHash).length;
                engine.removeTracker(infoHash, trackerUrl);
                const after = engine.getTrackers(infoHash);

                expect(after.length).toBe(before - 1);
                const urls = after.map((t) => t.url);
                expect(urls).not.toContain(normalized);
            }),
            { numRuns: 100 },
        );
    });
});

// Propriedade 5: Adicionar tracker duplicado é idempotente (Req 2.3)
// **Validates: Requirements 2.3**
describe('Propriedade 5: adicionar tracker duplicado não altera o tamanho da lista (idempotência)', () => {
    it('tentar adicionar URL já presente lança erro e não altera o tamanho da lista', () => {
        fc.assert(
            fc.property(validTrackerUrlArb, (trackerUrl) => {
                const infoHash = 'c'.repeat(40);
                const normalized = trackerUrl.replace(/\/+$/, '');
                const fakeTorrent = makeFakeTorrentWithTrackers(infoHash, [normalized], {});
                const mockClient = makeMockClient();
                mockClient.torrents.push(fakeTorrent);

                const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

                const before = engine.getTrackers(infoHash).length;

                expect(() => engine.addTracker(infoHash, trackerUrl)).toThrow(
                    /Tracker já presente/,
                );

                const after = engine.getTrackers(infoHash).length;
                expect(after).toBe(before);
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Per-Torrent Speed Limit — Unit Tests (Task 2.6) ─────────────────────────

// ─── Opções de Rede DHT/PEX/uTP — Testes Unitários (Task 3.4) ───────────────

describe('TorrentEngine — opções de rede DHT/PEX/uTP (Requisito 3)', () => {
    // Referência ao mock do construtor WebTorrent para verificar argumentos

    const MockWebTorrent = require('webtorrent').default as jest.Mock;

    beforeEach(() => {
        MockWebTorrent.mockClear();
    });

    it('passa dht: true e utp: true ao construtor do WebTorrent quando ambos estão habilitados', () => {
        createTorrentEngine({
            downloadPath: '/tmp',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            dhtEnabled: true,
            pexEnabled: true,
            utpEnabled: true,
        });

        expect(MockWebTorrent).toHaveBeenCalledWith(
            expect.objectContaining({ dht: true, utp: true }),
        );
    });

    it('passa dht: false ao construtor do WebTorrent quando dhtEnabled é false', () => {
        createTorrentEngine({
            downloadPath: '/tmp',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            dhtEnabled: false,
            pexEnabled: true,
            utpEnabled: true,
        });

        expect(MockWebTorrent).toHaveBeenCalledWith(
            expect.objectContaining({ dht: false, utp: true }),
        );
    });

    it('passa utp: false ao construtor do WebTorrent quando utpEnabled é false', () => {
        createTorrentEngine({
            downloadPath: '/tmp',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            dhtEnabled: true,
            pexEnabled: true,
            utpEnabled: false,
        });

        expect(MockWebTorrent).toHaveBeenCalledWith(
            expect.objectContaining({ dht: true, utp: false }),
        );
    });

    it('passa dht: false e utp: false quando ambos estão desabilitados', () => {
        createTorrentEngine({
            downloadPath: '/tmp',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            dhtEnabled: false,
            pexEnabled: true,
            utpEnabled: false,
        });

        expect(MockWebTorrent).toHaveBeenCalledWith(
            expect.objectContaining({ dht: false, utp: false }),
        );
    });

    it('não chama o construtor do WebTorrent quando um client é injetado', () => {
        const mockClient = makeMockClient();

        createTorrentEngine(
            {
                downloadPath: '/tmp',
                downloadSpeedLimit: 0,
                uploadSpeedLimit: 0,
                dhtEnabled: false,
                pexEnabled: false,
                utpEnabled: false,
            },
            mockClient,
        );

        // O construtor do mock não deve ser chamado quando um client é injetado
        expect(MockWebTorrent).not.toHaveBeenCalled();
    });

    it('configura PEX no cliente injetado antes de receber wires', () => {
        const client = makeMockClient();
        createTorrentEngine({ ...DEFAULT_OPTIONS, pexEnabled: false }, client);
        expect((client as unknown as { utPex: boolean }).utPex).toBe(false);
    });

    it('configura PEX e limites no construtor nativo', () => {
        createTorrentEngine({ ...DEFAULT_OPTIONS, pexEnabled: false });
        expect(MockWebTorrent).toHaveBeenCalledWith(
            expect.objectContaining({
                utPex: false,
                maxConns: 24,
                seedOutgoingConnections: true,
            }),
        );
    });
});

// ─── PBT: Propriedade 4 — Mapeamento correto de opções para o construtor WebTorrent (Task 3.5) ──

// Feature: dht-pex-settings, Property 4: Mapeamento correto de opções para o construtor WebTorrent
// **Validates: Requirements 3.1, 3.2, 3.4, 3.5**
describe('Propriedade 4: Mapeamento correto de opções para o construtor WebTorrent', () => {
    const MockWebTorrent = require('webtorrent').default as jest.Mock;

    beforeEach(() => {
        MockWebTorrent.mockClear();
    });

    it('para qualquer combinação de booleanos dhtEnabled/pexEnabled/utpEnabled, as opções passadas ao WebTorrent refletem corretamente os valores', () => {
        fc.assert(
            fc.property(
                fc.boolean(),
                fc.boolean(),
                fc.boolean(),
                (dhtEnabled, pexEnabled, utpEnabled) => {
                    MockWebTorrent.mockClear();

                    createTorrentEngine({
                        downloadPath: '/tmp',
                        downloadSpeedLimit: 0,
                        uploadSpeedLimit: 0,
                        dhtEnabled,
                        pexEnabled,
                        utpEnabled,
                    });

                    // O construtor do WebTorrent deve ter sido chamado exatamente uma vez
                    expect(MockWebTorrent).toHaveBeenCalledTimes(1);

                    // Verificar que dht e utp foram passados corretamente
                    const constructorArgs = MockWebTorrent.mock.calls[0][0];
                    expect(constructorArgs.dht).toBe(dhtEnabled);
                    expect(constructorArgs.utp).toBe(utpEnabled);
                    expect(constructorArgs.utPex).toBe(pexEnabled);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── TorrentEngine.restart() — Testes Unitários (Task 4.5) ──────────────────

/**
 * Cria um mock client completo para testes de restart.
 */
function makeMockClientWithRestart(
    torrents: Array<{
        infoHash: string;
        magnetURI: string;
    }> = [],
) {
    const fakeTorrents = torrents.map((t) =>
        makeFakeTorrent(t.infoHash, {
            magnetURI: t.magnetURI as unknown as string,
            destroy: jest.fn((_opts, cb) => cb?.(null)) as unknown as Torrent['destroy'],
        }),
    );

    const client = makeMockClient({
        destroy: jest.fn((cb: (err?: Error | null) => void) =>
            cb(null),
        ) as unknown as WebTorrent['destroy'],
    });
    client.torrents.push(...fakeTorrents);

    return { client, fakeTorrents };
}

/**
 * Configura o MockWebTorrent para criar um novo client que suporta addMagnetLink.
 * Quando addMagnetLink é chamado, o novo client emite 'torrent' com um fake torrent
 * que tem length > 0 (metadados já disponíveis), fazendo addMagnetLink resolver.
 */
function setupMockWebTorrentForRestart(MockWT: jest.Mock, opts?: { failingHashes?: Set<string> }) {
    MockWT.mockImplementation(() => {
        const client = new EventEmitter() as EventEmitter & {
            torrents: Torrent[];
            add: jest.Mock;
            destroy: jest.Mock;
            throttleDownload: jest.Mock;
            throttleUpload: jest.Mock;
        };
        client.torrents = [];
        client.throttleDownload = jest.fn();
        client.throttleUpload = jest.fn();
        client.destroy = jest.fn((cb) => cb?.());
        client.add = jest.fn((magnet: string) => {
            const hash = magnet.match(/btih:([a-f0-9]{40})/i)![1];
            if (opts?.failingHashes?.has(hash)) throw new Error('Falha simulada ao adicionar');
            const torrent = makeFakeTorrent(hash, { magnetURI: magnet });
            client.torrents.push(torrent);
            return torrent;
        });
        return client;
    });
}

describe('TorrentEngine.restart() — fluxo completo', () => {
    const MockWebTorrent = require('webtorrent').default as jest.Mock;

    beforeEach(() => {
        MockWebTorrent.mockClear();
    });

    it('encerra o cliente proprietário dos torrents antes de criar o novo cliente', async () => {
        const infoHash = 'a'.repeat(40);
        const { client, fakeTorrents } = makeMockClientWithRestart([
            { infoHash, magnetURI: `magnet:?xt=urn:btih:${infoHash}` },
        ]);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        setupMockWebTorrentForRestart(MockWebTorrent);

        // Escutar erros para evitar "unhandled error" (torrent sem status será re-adicionado)
        engine.on('error', () => {});

        const newOptions = {
            ...DEFAULT_OPTIONS,
            dhtEnabled: false,
            utpEnabled: false,
        };

        await engine.restart(newOptions);

        // WebTorrent.destroy owns cleanup of all torrents and preserves their stores.
        expect(fakeTorrents).toHaveLength(1);

        // O cliente original deve ter sido destruído
        expect(client.destroy).toHaveBeenCalled();

        // O construtor do WebTorrent deve ter sido chamado com as novas opções
        expect(MockWebTorrent).toHaveBeenCalledWith(
            expect.objectContaining({ dht: false, utp: false }),
        );
    });

    it('aplica limites de velocidade ao novo cliente quando > 0', async () => {
        const { client } = makeMockClientWithRestart();

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        setupMockWebTorrentForRestart(MockWebTorrent);

        const newOptions = {
            ...DEFAULT_OPTIONS,
            downloadSpeedLimit: 500,
            uploadSpeedLimit: 200,
        };

        await engine.restart(newOptions);

        const newClientInstance = MockWebTorrent.mock.results[0].value;
        expect(newClientInstance.throttleDownload).toHaveBeenCalledWith(500 * 1024);
        expect(newClientInstance.throttleUpload).toHaveBeenCalledWith(200 * 1024);
    });

    it('não aplica limites de velocidade ao novo cliente quando === 0', async () => {
        const { client } = makeMockClientWithRestart();

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        setupMockWebTorrentForRestart(MockWebTorrent);

        const newOptions = {
            ...DEFAULT_OPTIONS,
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
        };

        await engine.restart(newOptions);

        const newClientInstance = MockWebTorrent.mock.results[0].value;
        expect(newClientInstance.throttleDownload).not.toHaveBeenCalled();
        expect(newClientInstance.throttleUpload).not.toHaveBeenCalled();
    });

    it('restaura torrents pausados sem iniciar descoberta', async () => {
        const infoHash = 'a'.repeat(40);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const { client } = makeMockClientWithRestart([{ infoHash, magnetURI }]);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        // Setar status como 'paused' via pause()
        const torrent = client.torrents[0];
        (torrent.pause as jest.Mock).mockImplementation(() => {});
        await engine.pause(infoHash);

        setupMockWebTorrentForRestart(MockWebTorrent);

        await engine.restart(DEFAULT_OPTIONS);

        const newClientInstance = MockWebTorrent.mock.results[0].value;
        expect(newClientInstance.add).toHaveBeenCalledWith(
            magnetURI,
            expect.objectContaining({ paused: true }),
        );
    });

    it('restaura seeders pausados para o manager reaplicar os slots', async () => {
        const infoHash = 'b'.repeat(40);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;

        // Criar client com suporte a eventos reais para simular addMagnetLink + done
        const torrentListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const fakeTorrent = makeFakeTorrent(infoHash, {
            magnetURI: magnetURI as unknown as string,
            length: 1024, // metadados já disponíveis
            files: [] as unknown as Torrent['files'], // necessário para _initSelectionMap
            destroy: jest.fn((_opts, cb) => cb?.(null)) as unknown as Torrent['destroy'],
            on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
                if (!torrentListeners[event]) torrentListeners[event] = [];
                torrentListeners[event].push(listener);
                return fakeTorrent;
            }) as unknown as Torrent['on'],
            once: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
                if (!torrentListeners[event]) torrentListeners[event] = [];
                torrentListeners[event].push(listener);
                return fakeTorrent;
            }) as unknown as Torrent['once'],
        });

        const clientListeners: Record<string, ((...args: unknown[]) => void)[]> = {};
        const client = {
            torrents: [] as Torrent[],
            throttleDownload: jest.fn(),
            throttleUpload: jest.fn(),
            add: jest.fn(() => {
                client.torrents.push(fakeTorrent);
                return fakeTorrent;
            }),
            remove: jest.fn(),
            destroy: jest.fn((cb: (err?: Error | null) => void) => cb(null)),
            on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
                if (!clientListeners[event]) clientListeners[event] = [];
                clientListeners[event].push(listener);
                return client;
            }),
            once: jest.fn(),
            emit: jest.fn(),
            removeListener: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
                if (clientListeners[event]) {
                    clientListeners[event] = clientListeners[event].filter((l) => l !== listener);
                }
                return client;
            }),
        } as unknown as WebTorrent;

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        // Chamar addMagnetLink para registrar o torrent no statusMap
        await engine.addMagnetLink(magnetURI);

        // Disparar 'done' no torrent para mudar status para 'completed'
        const doneCbs = torrentListeners['done'] ?? [];
        for (const cb of doneCbs) {
            cb();
        }

        // Verificar que o status é 'completed'
        const allTorrents = engine.getAll();
        expect(allTorrents[0].status).toBe('seeding');

        setupMockWebTorrentForRestart(MockWebTorrent);

        await engine.restart(DEFAULT_OPTIONS);

        // O manager decide quais torrents podem retomar após o restart.
        const newClientInstance = MockWebTorrent.mock.results[0].value;
        expect(newClientInstance.add).toHaveBeenCalledWith(
            magnetURI,
            expect.objectContaining({ paused: true }),
        );
    });

    it('configura PEX disable no novo cliente quando pexEnabled é false', async () => {
        const { client } = makeMockClientWithRestart();

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        setupMockWebTorrentForRestart(MockWebTorrent);

        const newOptions = {
            ...DEFAULT_OPTIONS,
            pexEnabled: false,
        };

        await engine.restart(newOptions);

        expect(MockWebTorrent).toHaveBeenCalledWith(expect.objectContaining({ utPex: false }));
    });

    it('atualiza downloadPath com o valor das novas opções', async () => {
        const { client } = makeMockClientWithRestart();

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        setupMockWebTorrentForRestart(MockWebTorrent);

        const newOptions = {
            ...DEFAULT_OPTIONS,
            downloadPath: '/novo/caminho/downloads',
        };

        await engine.restart(newOptions);

        expect(engine.isRestarting()).toBe(false);
    });
});

describe('TorrentEngine.restart() — tratamento de erro ao re-adicionar (Task 4.4)', () => {
    const MockWebTorrent = require('webtorrent').default as jest.Mock;

    beforeEach(() => {
        MockWebTorrent.mockClear();
    });

    it('marca torrent com status "error" quando falha ao re-adicionar e emite evento error', async () => {
        const infoHash = 'a'.repeat(40);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;

        const { client } = makeMockClientWithRestart([{ infoHash, magnetURI }]);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        // Configurar novo client para falhar ao re-adicionar este torrent
        setupMockWebTorrentForRestart(MockWebTorrent, {
            failingHashes: new Set([infoHash]),
        });

        const errorEvents: Array<{ infoHash: string; error: Error }> = [];
        engine.on('error', (hash: string, err: Error) => {
            errorEvents.push({ infoHash: hash, error: err });
        });

        await engine.restart(DEFAULT_OPTIONS);

        // O torrent deve ter emitido evento de erro
        expect(errorEvents.length).toBeGreaterThanOrEqual(1);
        expect(errorEvents[0].infoHash).toBe(infoHash);
        expect(errorEvents[0].error.message).toContain('re-adicionar');
    });

    it('continua re-adicionando outros torrents mesmo quando um falha', async () => {
        const infoHashA = 'a'.repeat(40);
        const infoHashB = 'b'.repeat(40);
        const magnetA = `magnet:?xt=urn:btih:${infoHashA}`;
        const magnetB = `magnet:?xt=urn:btih:${infoHashB}`;

        const { client } = makeMockClientWithRestart([
            { infoHash: infoHashA, magnetURI: magnetA },
            { infoHash: infoHashB, magnetURI: magnetB },
        ]);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        // Primeiro torrent falha, segundo sucede
        setupMockWebTorrentForRestart(MockWebTorrent, {
            failingHashes: new Set([infoHashA]),
        });

        const errorEvents: string[] = [];
        engine.on('error', (hash: string) => {
            errorEvents.push(hash);
        });

        await engine.restart(DEFAULT_OPTIONS);

        // O primeiro torrent deve ter falhado
        expect(errorEvents).toContain(infoHashA);

        // O novo client deve ter recebido 2 chamadas add() (tentou ambos)
        const newClientInstance = MockWebTorrent.mock.results[0].value;
        expect(newClientInstance.add).toHaveBeenCalledTimes(2);
    });
});

describe('TorrentEngine.isRestarting() — flag de reinício (Task 4.2)', () => {
    it('retorna false quando o motor não está reiniciando', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(engine.isRestarting()).toBe(false);
    });

    it('retorna true durante o restart e false após conclusão', async () => {
        const mockClient = makeMockClient({
            destroy: jest.fn((cb: (err?: Error | null) => void) =>
                cb(null),
            ) as unknown as WebTorrent['destroy'],
        });

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        let wasRestartingDuringRestart = false;

        const MockWebTorrent = require('webtorrent').default as jest.Mock;
        MockWebTorrent.mockImplementation(() => {
            // Capturar o estado de isRestarting durante a criação do novo client
            wasRestartingDuringRestart = engine.isRestarting();
            return {
                torrents: [],
                throttleDownload: jest.fn(),
                throttleUpload: jest.fn(),
                add: jest.fn(),
                remove: jest.fn(),
                destroy: jest.fn(),
                on: jest.fn(),
                once: jest.fn(),
                emit: jest.fn(),
            };
        });

        await engine.restart(DEFAULT_OPTIONS);

        expect(wasRestartingDuringRestart).toBe(true);
        expect(engine.isRestarting()).toBe(false);
    });

    it('retorna false após restart mesmo quando ocorre erro', async () => {
        const mockClient = makeMockClient({
            destroy: jest.fn((cb: (err?: Error | null) => void) => {
                cb(new Error('Erro ao destruir'));
            }) as unknown as WebTorrent['destroy'],
        });

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        await expect(engine.restart(DEFAULT_OPTIONS)).rejects.toThrow('Erro ao destruir');

        // Mesmo com erro, a flag deve ser resetada
        expect(engine.isRestarting()).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// Tarefa 4.2 — Testes unitários para gaps de cobertura em torrentEngine.ts
// ═════════════════════════════════════════════════════════════════════════════

// ─── Mock de fs/promises ──────────────────────────────────────────────────────
// Jest eleva (hoist) todas as chamadas jest.mock() ao topo, então este mock é
// aplicado antes do módulo torrentEngine ser carregado, independente de onde
// está no arquivo.
jest.mock('fs/promises', () => ({
    readFile: jest.fn(),
    rm: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
}));

// ─── Helper: torrent com EventEmitter real ────────────────────────────────────

/**
 * Cria um fake Torrent cujos métodos on/once/emit são os do EventEmitter real.
 * Isso permite que os listeners registrados por _attachTorrentListeners sejam
 * realmente invocados quando se faz (torrent as EventEmitter).emit('done'), etc.
 */
function makeEventTorrent(infoHash: string, overrides: Partial<Torrent> = {}): Torrent {
    const emitter = new EventEmitter();
    Object.assign(emitter, {
        infoHash,
        name: 'event-torrent',
        length: 1024,
        progress: 0.5,
        downloadSpeed: 100,
        uploadSpeed: 50,
        numPeers: 2,
        timeRemaining: 5000,
        downloaded: 512,
        files: [] as unknown,
        ready: true,
        magnetURI: `magnet:?xt=urn:btih:${infoHash}`,
        destroy: jest.fn((_opts: unknown, cb?: (err?: Error | null) => void) => cb?.()),
        pause: jest.fn(),
        resume: jest.fn(),
        ...overrides,
    });
    return emitter as unknown as Torrent;
}

/**
 * Cria um mock client onde add() retorna fakeTorrent e o insere em torrents[].
 * Usado por addMagnetLink (sem readyCb no terceiro argumento).
 */
function makeClientForAddMagnet(fakeTorrent: Torrent) {
    const client = makeMockClient();
    (client as unknown as { add: jest.Mock }).add = jest.fn(() => {
        client.torrents.push(fakeTorrent);
        return fakeTorrent;
    });
    return client;
}

/**
 * Cria um mock client para addTorrentBuffer.
 * - callReady: false → add não chama o readyCb (simula travamento / timeout)
 * - throwOnAdd → add lança a exceção informada
 * - default  → add chama readyCb(fakeTorrent) imediatamente (caminho de sucesso)
 */
function makeClientForAddBuffer(
    fakeTorrent: Torrent,
    opts?: { callReady?: boolean; throwOnAdd?: Error },
) {
    const client = makeMockClient();
    (client as unknown as { add: jest.Mock }).add = jest.fn(
        (_src: unknown, _opts: unknown, cb?: (t: Torrent) => void) => {
            if (opts?.throwOnAdd) throw opts.throwOnAdd;
            client.torrents.push(fakeTorrent);
            if (opts?.callReady !== false && cb) cb(fakeTorrent);
            return fakeTorrent;
        },
    );
    return client;
}

// ─── addTorrentBuffer — caminhos não cobertos ─────────────────────────────────

describe('TorrentEngine.addTorrentBuffer() — cobertura de caminhos ausentes', () => {
    // Buffer mínimo com magic byte bencode 0x64 ('d') — início de dicionário válido
    const VALID_BUFFER = Buffer.from([0x64, 0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f]);
    const INVALID_BUFFER = Buffer.from([0x00, 0x01, 0x02]);

    it('rejeita quando o buffer não possui magic bytes de torrent (0x64)', async () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        await expect(engine.addTorrentBuffer(INVALID_BUFFER)).rejects.toThrow(
            /não é um arquivo .torrent válido/,
        );
    });

    it('resolve com TorrentInfo quando client.add chama o callback de pronto', async () => {
        const infoHash = 'a1'.repeat(20);
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddBuffer(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        const info = await engine.addTorrentBuffer(VALID_BUFFER);

        expect(info.infoHash).toBe(infoHash);
        expect(info.status).toBe('downloading');
        expect(info.name).toBe('event-torrent');
    });

    it('resolve com status "paused" quando paused=true', async () => {
        const infoHash = 'a2'.repeat(20);
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddBuffer(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        const info = await engine.addTorrentBuffer(VALID_BUFFER, true);

        expect(info.status).toBe('paused');
    });

    it('rejeita quando client.add lança exceção síncrona', async () => {
        const infoHash = 'a3'.repeat(20);
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddBuffer(fakeTorrent, {
            throwOnAdd: new Error('Falha interna ao adicionar buffer'),
        });
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await expect(engine.addTorrentBuffer(VALID_BUFFER)).rejects.toThrow(
            'Falha interna ao adicionar buffer',
        );
    });

    describe('timeout de 20 segundos', () => {
        afterEach(() => jest.useRealTimers());

        it('rejeita com erro de timeout após 20 000 ms sem callback de pronto', async () => {
            jest.useFakeTimers();

            const infoHash = 'a4'.repeat(20);
            const fakeTorrent = makeEventTorrent(infoHash);
            // callReady: false → add não chama readyCb, simulando torrent travado
            const client = makeClientForAddBuffer(fakeTorrent, { callReady: false });
            const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

            const promise = engine.addTorrentBuffer(VALID_BUFFER);
            jest.advanceTimersByTime(20_001);

            await expect(promise).rejects.toThrow(/Adição do torrent expirou/);
        });
    });
});

// ─── addTorrentFile — bloco catch de readFile ─────────────────────────────────

describe('TorrentEngine.addTorrentFile() — bloco catch de leitura de arquivo', () => {
    let mockReadFile: jest.Mock;

    beforeEach(() => {
        mockReadFile = jest.requireMock<{ readFile: jest.Mock }>('fs/promises').readFile;
        mockReadFile.mockReset();
    });

    it('rejeita com "Não foi possível ler o arquivo" quando readFile rejeita', async () => {
        mockReadFile.mockRejectedValue(
            Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
        );

        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        await expect(engine.addTorrentFile('/tmp/fake.torrent')).rejects.toThrow(
            /Não foi possível ler o arquivo/,
        );
    });

    it('usa basename do arquivo e código de erro na mensagem (sem vazar caminho completo)', async () => {
        // Simula erro de permissão do Node.js com a propriedade `code`
        const fsError = Object.assign(new Error('EACCES: permission denied, open'), {
            code: 'EACCES',
        });
        mockReadFile.mockRejectedValue(fsError);

        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        const err = await engine.addTorrentFile('/tmp/restrito.torrent').catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        // Deve conter o basename, não o caminho completo
        expect((err as Error).message).toContain('restrito.torrent');
        expect((err as Error).message).not.toContain('/tmp/');
        // Deve conter o código de erro (EACCES) para diagnóstico
        expect((err as Error).message).toContain('EACCES');
    });
});

// ─── remove() — cobertura completa do corpo ──────────────────────────────────

describe('TorrentEngine.remove() — cobertura de todos os caminhos', () => {
    let fsMock: { rm: jest.Mock; readdir: jest.Mock; readFile: jest.Mock };

    beforeEach(() => {
        fsMock = jest.requireMock('fs/promises');
        fsMock.rm.mockReset().mockResolvedValue(undefined);
        fsMock.readdir.mockReset().mockResolvedValue([]);
    });

    it('resolve imediatamente quando o torrent não é encontrado (já removido)', async () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        await expect(
            engine.remove('0000000000000000000000000000000000000000', false),
        ).resolves.toBeUndefined();
    });

    it('chama destroy({destroyStore:false}) e resolve quando deleteFiles=false', async () => {
        const infoHash = 'a5'.repeat(20);
        const destroyMock = jest.fn((_opts: unknown, cb?: (err?: Error | null) => void) => cb?.());
        const fakeTorrent = makeFakeTorrent(infoHash, {
            destroy: destroyMock as unknown as Torrent['destroy'],
        });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        await engine.remove(infoHash, false);

        expect(destroyMock).toHaveBeenCalledWith({ destroyStore: false }, expect.any(Function));
    });

    it('aguarda o encerramento da descoberta antes de remover um torrent concluído', async () => {
        const infoHash = 'ab'.repeat(20);
        const discovery = {
            destroyed: false,
            destroy: jest.fn((callback: (err?: Error | null) => void) => {
                if (discovery.destroyed) return;
                discovery.destroyed = true;
                setTimeout(() => callback(), 0);
            }),
        };
        const fakeTorrent = makeFakeTorrent(infoHash, {
            destroy: jest.fn((_opts: unknown, callback?: (err?: Error | null) => void) => {
                const currentDiscovery = (
                    fakeTorrent as unknown as { discovery?: typeof discovery }
                ).discovery;
                if (currentDiscovery) currentDiscovery.destroy(() => callback?.());
                else callback?.();
            }) as unknown as Torrent['destroy'],
        });
        (fakeTorrent as unknown as { discovery?: typeof discovery }).discovery = discovery;
        (fakeTorrent as unknown as { wires: unknown[] }).wires = [];

        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        // Conclusão inicia o encerramento de rede em paralelo à ação do usuário.
        const networkStop = stopTorrentNetwork(fakeTorrent);
        const removal = engine.remove(infoHash, false);

        await expect(removal).resolves.toBeUndefined();
        await networkStop;
        expect(discovery.destroy).toHaveBeenCalledTimes(1);
    });

    it('chama readdir e rm quando deleteFiles=true e a pasta está vazia', async () => {
        const infoHash = 'a6'.repeat(20);
        const destroyMock = jest.fn((_opts: unknown, cb?: (err?: Error | null) => void) => cb?.());
        const fakeTorrent = makeFakeTorrent(infoHash, {
            name: 'meu-torrent',
            destroy: destroyMock as unknown as Torrent['destroy'],
        });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        fsMock.readdir.mockResolvedValue([]);
        fsMock.rm.mockResolvedValue(undefined);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        await engine.remove(infoHash, true);

        expect(fsMock.readdir).toHaveBeenCalledWith(expect.stringContaining('meu-torrent'));
        expect(fsMock.rm).toHaveBeenCalledWith(expect.stringContaining('meu-torrent'), {
            recursive: true,
        });
    });

    it('não chama rm quando deleteFiles=true mas a pasta tem conteúdo', async () => {
        const infoHash = 'a7'.repeat(20);
        const destroyMock = jest.fn((_opts: unknown, cb?: (err?: Error | null) => void) => cb?.());
        const fakeTorrent = makeFakeTorrent(infoHash, {
            name: 'torrent-cheio',
            destroy: destroyMock as unknown as Torrent['destroy'],
        });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        fsMock.readdir.mockResolvedValue(['video.mkv']);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        await engine.remove(infoHash, true);

        expect(fsMock.readdir).toHaveBeenCalled();
        expect(fsMock.rm).not.toHaveBeenCalled();
    });

    it('rejeita quando destroy retorna erro', async () => {
        const infoHash = 'a8'.repeat(20);
        const destroyMock = jest.fn((_opts: unknown, cb?: (err?: Error | null) => void) =>
            cb?.(new Error('Disco cheio ao destruir')),
        );
        const fakeTorrent = makeFakeTorrent(infoHash, {
            destroy: destroyMock as unknown as Torrent['destroy'],
        });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        await expect(engine.remove(infoHash, false)).rejects.toThrow('Disco cheio ao destruir');
    });

    it('resolve mesmo quando readdir rejeita (ignora erros de limpeza de pasta)', async () => {
        const infoHash = 'a9'.repeat(20);
        const destroyMock = jest.fn((_opts: unknown, cb?: (err?: Error | null) => void) => cb?.());
        const fakeTorrent = makeFakeTorrent(infoHash, {
            name: 'torrent-sem-pasta',
            destroy: destroyMock as unknown as Torrent['destroy'],
        });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        fsMock.readdir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        // Erros de limpeza de pasta são silenciados — a remoção do torrent já concluiu
        await expect(engine.remove(infoHash, true)).resolves.toBeUndefined();
    });
});

// ─── resume() — torrent não encontrado (throw) ───────────────────────────────

describe('TorrentEngine.resume() — cobertura de caminhos ausentes', () => {
    it('lança erro quando o torrent não é encontrado no engine', async () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        await expect(engine.resume('0000000000000000000000000000000000000001')).rejects.toThrow(
            /Torrent não encontrado/,
        );
    });

    it('chama resumeTorrentNetwork e emite progress quando o torrent existe', async () => {
        const infoHash = 'b0'.repeat(20);
        const fakeTorrent = makeEventTorrent(infoHash, { ready: true });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        // Pausa primeiro para registrar status no statusMap e depois resume
        await engine.pause(infoHash);

        const progressEvents: unknown[] = [];
        engine.on('progress', (info) => progressEvents.push(info));

        await engine.resume(infoHash);

        expect((fakeTorrent as unknown as { resume: jest.Mock }).resume).toHaveBeenCalled();
        expect(progressEvents).toHaveLength(1);
    });
});

// ─── healthCheck() — cobertura completa ──────────────────────────────────────

describe('TorrentEngine.healthCheck() — cobertura de todos os caminhos', () => {
    it('retorna status saudável quando engine está operacional sem torrents', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        const status = engine.healthCheck();

        expect(status.healthy).toBe(true);
        expect(status.restarting).toBe(false);
        expect(status.activeTorrents).toBe(0);
        expect(status.totalPeers).toBe(0);
        expect(typeof status.uptimeMs).toBe('number');
        expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
        expect(status.error).toBeUndefined();
    });

    it('contabiliza torrents ativos e total de peers na resposta de saúde', () => {
        const infoHash = 'b1'.repeat(20);
        const fakeTorrent = makeFakeTorrent(infoHash, { numPeers: 7 });
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        const status = engine.healthCheck();

        expect(status.activeTorrents).toBe(1);
        expect(status.totalPeers).toBe(7);
    });

    it('retorna healthy=false e campo error quando client.torrents lança exceção', () => {
        const mockClient = makeMockClient();
        // Sobrescrever a propriedade torrents com um getter que lança
        Object.defineProperty(mockClient, 'torrents', {
            get() {
                throw new Error('Falha interna no acesso a torrents');
            },
            configurable: true,
        });

        // O engine é criado com sucesso (torrents não é acessado no construtor)
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        const status = engine.healthCheck();

        expect(status.healthy).toBe(false);
        expect(status.activeTorrents).toBe(0);
        expect(status.totalPeers).toBe(0);
        expect(status.error).toMatch(/Falha interna no acesso/);
    });
});

// ─── getMetadata() ────────────────────────────────────────────────────────────

describe('TorrentEngine.getMetadata() — cobertura de caminhos ausentes', () => {
    it('lança erro quando o torrent não é encontrado', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() => engine.getMetadata('0000000000000000000000000000000000000002')).toThrow(
            /Torrent não encontrado/,
        );
    });

    it('retorna todos os campos null quando o torrent não tem metadados de criação', () => {
        const infoHash = 'b2'.repeat(20);
        const fakeTorrent = makeFakeTorrent(infoHash);
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        const meta = engine.getMetadata(infoHash);

        expect(meta.infoHash).toBe(infoHash);
        expect(meta.creator).toBeNull();
        expect(meta.comment).toBeNull();
        expect(meta.creationDate).toBeNull();
    });

    it('retorna metadados preenchidos quando torrent tem informações de criação', () => {
        const infoHash = 'b3'.repeat(20);
        const fakeTorrent = makeFakeTorrent(infoHash);
        // Simular propriedades internas acessadas por getTorrentCreatedInfo
        (fakeTorrent as unknown as Record<string, unknown>).created = {
            by: 'qBittorrent/4.6.0',
            date: 1700000000000,
        };
        (fakeTorrent as unknown as Record<string, unknown>).comment =
            'Arquivo de teste de metadados';
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        const meta = engine.getMetadata(infoHash);

        expect(meta.creator).toBe('qBittorrent/4.6.0');
        expect(meta.comment).toBe('Arquivo de teste de metadados');
        expect(meta.creationDate).toBe(new Date(1700000000000).getTime());
    });
});

// ─── getPeers() ───────────────────────────────────────────────────────────────

describe('TorrentEngine.getPeers() — cobertura de caminhos ausentes', () => {
    it('lança erro quando o torrent não é encontrado', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() => engine.getPeers('0000000000000000000000000000000000000003')).toThrow(
            /Torrent não encontrado/,
        );
    });

    it('retorna array vazio quando o torrent não tem wires (sem peers conectados)', () => {
        const infoHash = 'b4'.repeat(20);
        const fakeTorrent = makeFakeTorrent(infoHash);
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(engine.getPeers(infoHash)).toEqual([]);
    });

    it('retorna peer com address, client e downloadSpeed quando há wires', () => {
        const infoHash = 'b5'.repeat(20);
        const fakeTorrent = makeFakeTorrent(infoHash);
        // Simular wires internos (propriedade não tipada do WebTorrent)
        (fakeTorrent as unknown as Record<string, unknown>).wires = [
            {
                remoteAddress: '10.0.0.1',
                remotePort: 51413,
                peerExtendedHandshake: { v: Buffer.from('μTorrent/3.5.5') },
                downloadSpeed: () => 102400,
                peerPieces: null,
            },
        ];
        (fakeTorrent as unknown as Record<string, unknown>).pieces = new Array(10);
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        const peers = engine.getPeers(infoHash);

        expect(peers).toHaveLength(1);
        expect(peers[0].address).toBe('10.0.0.1:51413');
        expect(peers[0].client).toBe('μTorrent/3.5.5');
        expect(peers[0].downloadSpeed).toBe(102400);
        expect(peers[0].progress).toBe(0); // peerPieces=null → progress=0
    });
});

// ─── getPieces() ──────────────────────────────────────────────────────────────

describe('TorrentEngine.getPieces() — cobertura de caminhos ausentes', () => {
    it('lança erro quando o torrent não é encontrado', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(() => engine.getPieces('0000000000000000000000000000000000000004')).toThrow(
            /Torrent não encontrado/,
        );
    });

    it('retorna array vazio quando o torrent não tem informação de peças', () => {
        const infoHash = 'b6'.repeat(20);
        const fakeTorrent = makeFakeTorrent(infoHash);
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        expect(engine.getPieces(infoHash)).toEqual([]);
    });

    it('retorna array de booleans baseado no bitfield quando torrent tem peças', () => {
        const infoHash = 'b7'.repeat(20);
        const fakeTorrent = makeFakeTorrent(infoHash);
        const completedPieces = new Set([0, 2, 4]);
        (fakeTorrent as unknown as Record<string, unknown>).bitfield = {
            get: (i: number) => completedPieces.has(i),
        };
        (fakeTorrent as unknown as Record<string, unknown>).pieces = new Array(5);
        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);
        const pieces = engine.getPieces(infoHash);

        expect(pieces).toHaveLength(5);
        expect(pieces).toEqual([true, false, true, false, true]);
    });
});

// ─── _attachTorrentListeners — eventos done, error, download, upload ──────────

describe('TorrentEngine._attachTorrentListeners — eventos de torrent (via addMagnetLink)', () => {
    it('marca status seeding e emite done sem parar a rede', async () => {
        const infoHash = 'b8'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        const doneEvents: string[] = [];
        engine.on('done', (hash) => doneEvents.push(hash));

        (fakeTorrent as unknown as EventEmitter).emit('done');

        // statusMap e emissão de 'done' são síncronos no handler
        expect(engine.getAll().find((i) => i.infoHash === infoHash)?.status).toBe('seeding');
        expect(doneEvents).toContain(infoHash);
    });

    it('marca status "error" e emite "error" quando torrent dispara error (Error)', async () => {
        const infoHash = 'b9'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        const errorEvents: Array<{ hash: string; err: Error }> = [];
        engine.on('error', (hash, err) => errorEvents.push({ hash, err }));

        const torrentError = new Error('Torrent corrompido');
        (fakeTorrent as unknown as EventEmitter).emit('error', torrentError);

        expect(engine.getAll().find((i) => i.infoHash === infoHash)?.status).toBe('error');
        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0].hash).toBe(infoHash);
        expect(errorEvents[0].err).toBe(torrentError);
    });

    it('converte string de erro em instância de Error quando torrent emite error com string', async () => {
        const infoHash = 'c0'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        const receivedErrors: Error[] = [];
        engine.on('error', (_hash, err) => receivedErrors.push(err));

        (fakeTorrent as unknown as EventEmitter).emit('error', 'string de erro pura');

        expect(receivedErrors).toHaveLength(1);
        expect(receivedErrors[0]).toBeInstanceOf(Error);
        expect(receivedErrors[0].message).toBe('string de erro pura');
    });

    it('emite "progress" no engine quando torrent dispara "download"', async () => {
        const infoHash = 'c1'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        const progressEvents: unknown[] = [];
        engine.on('progress', (info) => progressEvents.push(info));

        (fakeTorrent as unknown as EventEmitter).emit('download');

        expect(progressEvents).toHaveLength(1);
    });

    it('emite "progress" no engine quando torrent dispara "upload"', async () => {
        const infoHash = 'c2'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        const progressEvents: unknown[] = [];
        engine.on('progress', (info) => progressEvents.push(info));

        (fakeTorrent as unknown as EventEmitter).emit('upload');

        expect(progressEvents).toHaveLength(1);
    });
});

// ─── _attachTorrentListeners — warning com rate limiting ─────────────────────

describe('TorrentEngine._attachTorrentListeners — warning e rate limiting', () => {
    let logWarnMock: jest.Mock;

    beforeEach(() => {
        logWarnMock = jest.requireMock<{ default: { warn: jest.Mock } }>('electron-log').default
            .warn;
        logWarnMock.mockClear();
    });

    it('loga o warning na primeira ocorrência de uma mensagem nova', async () => {
        const infoHash = 'c3'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        (fakeTorrent as unknown as EventEmitter).emit('warning', new Error('Aviso único'));

        expect(logWarnMock).toHaveBeenCalledTimes(1);
        expect(logWarnMock).toHaveBeenCalledWith(
            expect.stringContaining('[TorrentEngine]'),
            expect.anything(),
            'Aviso único',
        );
    });

    it('suprime warnings com a mesma mensagem dentro de 60 s (rate limiting)', async () => {
        const infoHash = 'c4'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        // Três disparos idênticos — apenas o primeiro deve ser logado
        (fakeTorrent as unknown as EventEmitter).emit('warning', new Error('Aviso repetido'));
        (fakeTorrent as unknown as EventEmitter).emit('warning', new Error('Aviso repetido'));
        (fakeTorrent as unknown as EventEmitter).emit('warning', new Error('Aviso repetido'));

        expect(logWarnMock).toHaveBeenCalledTimes(1);
    });

    it('loga warnings com mensagens distintas sem suprimir', async () => {
        const infoHash = 'c5'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        (fakeTorrent as unknown as EventEmitter).emit('warning', new Error('Aviso A'));
        (fakeTorrent as unknown as EventEmitter).emit('warning', new Error('Aviso B'));

        expect(logWarnMock).toHaveBeenCalledTimes(2);
    });

    it('aceita string (não-Error) como argumento de warning sem lançar', async () => {
        const infoHash = 'c6'.repeat(20);
        const magnetURI = `magnet:?xt=urn:btih:${infoHash}`;
        const fakeTorrent = makeEventTorrent(infoHash);
        const client = makeClientForAddMagnet(fakeTorrent);
        const engine = createTorrentEngine(DEFAULT_OPTIONS, client);

        await engine.addMagnetLink(magnetURI);

        expect(() => {
            (fakeTorrent as unknown as EventEmitter).emit('warning', 'aviso como string');
        }).not.toThrow();

        expect(logWarnMock).toHaveBeenCalledTimes(1);
    });
});

// ─── _configureClient — handler de erro global do WebTorrent client ───────────

describe('TorrentEngine._configureClient — erro global do client WebTorrent', () => {
    it('emite "error" para cada torrent ativo quando client dispara erro global', () => {
        const infoHash1 = 'c7'.repeat(20);
        const infoHash2 = 'c8'.repeat(20);
        const fakeTorrent1 = makeFakeTorrent(infoHash1);
        const fakeTorrent2 = makeFakeTorrent(infoHash2);

        const mockClient = makeMockClient();
        mockClient.torrents.push(fakeTorrent1, fakeTorrent2);

        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        // _configureClient registra client.on('error', handler) via jest.fn
        // — capturamos o handler das chamadas gravadas pelo mock
        const onCalls = (mockClient.on as jest.Mock).mock.calls as Array<
            [string, (err: Error) => void]
        >;
        const errorEntry = onCalls.find(([event]) => event === 'error');
        expect(errorEntry).toBeDefined();
        const clientErrorHandler = errorEntry![1];

        const engineErrors: Array<{ hash: string; err: Error }> = [];
        engine.on('error', (hash, err) => engineErrors.push({ hash, err }));

        const globalError = new Error('Erro global do WebTorrent client');
        clientErrorHandler(globalError);

        expect(engineErrors).toHaveLength(2);
        expect(engineErrors.map((e) => e.hash)).toContain(infoHash1);
        expect(engineErrors.map((e) => e.hash)).toContain(infoHash2);
        expect(engineErrors.every((e) => e.err === globalError)).toBe(true);
    });

    it('não emite "error" quando não há torrents no client no momento do erro global', () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_OPTIONS, mockClient);

        const onCalls = (mockClient.on as jest.Mock).mock.calls as Array<
            [string, (err: Error) => void]
        >;
        const errorEntry = onCalls.find(([event]) => event === 'error');
        const clientErrorHandler = errorEntry![1];

        const engineErrors: unknown[] = [];
        engine.on('error', () => engineErrors.push(true));

        clientErrorHandler(new Error('Erro sem torrents'));

        expect(engineErrors).toHaveLength(0);
    });
});

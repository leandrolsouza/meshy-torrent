import { EventEmitter } from 'events';
import type WebTorrent from 'webtorrent';
import { createTorrentEngine } from '../../main/torrentEngine';
import { createDownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import {
    MAX_TRACKERS_PER_TORRENT,
    configureTorrentNetwork,
    resumeTorrentNetwork,
} from '../../main/webtorrentInternals';
import type { Torrent } from 'webtorrent';

jest.mock('fs/promises', () => ({
    ...jest.requireActual('fs/promises'),
    stat: jest.fn().mockResolvedValue({ isDirectory: () => true } as any),
    access: jest.fn().mockResolvedValue(undefined),
}));

const mockClients: MockClient[] = [];
jest.mock('webtorrent', () => ({
    __esModule: true,
    default: jest.fn((opts) => {
        const client = new MockClient();
        client.utPex = opts?.utPex ?? true;
        mockClients.push(client);
        return client;
    }),
}));

class MockTracker extends EventEmitter {
    _trackers: Array<{ announceUrl: string; destroyed: boolean; destroy: jest.Mock }>;
    constructor(urls: string[]) {
        super();
        this._trackers = urls.map((announceUrl) => {
            const tracker = { announceUrl, destroyed: false, destroy: jest.fn() };
            tracker.destroy.mockImplementation((cb) => {
                tracker.destroyed = true;
                cb?.();
            });
            return tracker;
        });
    }
    destroy = jest.fn((cb) => {
        this._trackers.forEach((tracker) => tracker.destroy(() => {}));
        cb?.();
    });
}

class MockTorrent extends EventEmitter {
    name = 'test';
    length = 0;
    ready = false;
    destroyed = false;
    paused = false;
    progress = 0;
    downloaded = 0;
    files: never[] = [];
    wires: Array<{ destroy: jest.Mock }> = [];
    announce: string[] = [];
    _peers = new Map<string, { destroy: jest.Mock }>();
    discovery?: {
        destroyed: boolean;
        _announce: string[];
        tracker: MockTracker;
        _createTracker: jest.Mock;
        destroy: jest.Mock;
    } | null;
    discoveryStarts = 0;
    constructor(
        public infoHash: string,
        public magnetURI: string,
        private client: MockClient,
    ) {
        super();
    }
    _startDiscovery(): void {
        if (this.discovery) return;
        this.discoveryStarts++;
        const discovery: NonNullable<MockTorrent['discovery']> = {
            destroyed: false,
            _announce: this.announce,
            tracker: new MockTracker(this.announce),
            _createTracker: jest.fn(() => new MockTracker(discovery._announce)),
            destroy: jest.fn((cb) => {
                discovery.destroyed = true;
                discovery.tracker.destroy(cb);
            }),
        };
        this.discovery = discovery;
    }
    pause = jest.fn(() => {
        this.paused = true;
    });
    resume = jest.fn(() => {
        this.paused = false;
    });
    destroy = jest.fn((_options, cb) => {
        this.destroyed = true;
        this.client.torrents = this.client.torrents.filter((torrent) => torrent !== this);
        this.emit('close');
        cb?.();
    });
    resolveMetadata(): void {
        this.length = 1024;
        this.ready = true;
        this.emit('metadata');
        this._startDiscovery();
        this.emit('ready');
        this.client.emit('torrent', this);
    }
}

class MockClient extends EventEmitter {
    torrents: MockTorrent[] = [];
    utPex = true;
    throttleDownload = jest.fn();
    throttleUpload = jest.fn();
    nextBufferHash = 100;
    add = jest.fn(
        (
            id: string | Buffer,
            options: { paused?: boolean },
            cb?: (torrent: MockTorrent) => void,
        ) => {
            const hash =
                typeof id === 'string'
                    ? id.match(/btih:([a-f0-9]{40})/i)![1]
                    : hashOf(this.nextBufferHash++);
            const torrent = new MockTorrent(hash, magnet(hash), this);
            torrent.paused = options?.paused ?? false;
            this.torrents.push(torrent);
            queueMicrotask(() => {
                torrent._startDiscovery();
                if (Buffer.isBuffer(id)) {
                    torrent.resolveMetadata();
                    cb?.(torrent);
                }
            });
            return torrent;
        },
    );
    destroy = jest.fn((cb: (err?: Error) => void) => {
        for (const torrent of [...this.torrents])
            torrent.destroy({ destroyStore: false }, () => {});
        cb();
    });
}

const hashOf = (n: number): string => n.toString(16).padStart(40, '0');
const magnet = (hash: string): string => `magnet:?xt=urn:btih:${hash}`;
const options = {
    downloadPath: process.cwd(),
    downloadSpeedLimit: 0,
    uploadSpeedLimit: 0,
    dhtEnabled: true,
    pexEnabled: true,
    utpEnabled: true,
};
function setup(maxConcurrentDownloads = 1) {
    const client = new MockClient();
    const engine = createTorrentEngine(options, client as unknown as WebTorrent);
    const settings = {
        get: () => ({
            destinationFolder: process.cwd(),
            maxConcurrentDownloads,
            autoApplyGlobalTrackers: false,
        }),
        getGlobalTrackers: () => [],
    } as unknown as SettingsManager;
    const manager = createDownloadManager(engine, settings, undefined, undefined, {
        disableCleanupTimer: true,
    });
    return { client, engine, manager };
}

beforeEach(() => {
    jest.useFakeTimers();
    mockClients.length = 0;
});
afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

test('six pending magnets consume one slot and keep five torrents offline', async () => {
    const { client, manager } = setup();
    const added = await Promise.all(
        Array.from({ length: 6 }, (_, i) => manager.addMagnetLink(magnet(hashOf(i + 1)))),
    );
    expect(client.torrents).toHaveLength(1);
    expect(added.filter((item) => item.status === 'queued')).toHaveLength(5);
    expect(manager.getAll().filter((item) => item.status === 'resolving-metadata')).toHaveLength(1);
});

test('concurrent duplicate magnets do not create an untracked torrent', async () => {
    const { client, manager } = setup(3);
    const results = await Promise.allSettled([
        manager.addMagnetLink(magnet(hashOf(1))),
        manager.addMagnetLink(magnet(hashOf(1))),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(client.torrents).toHaveLength(1);
});

test('metadata timeout stops discovery before releasing the slot, and late ready cannot revive it', async () => {
    const { client, manager } = setup();
    await manager.addMagnetLink(magnet(hashOf(1)));
    await manager.addMagnetLink(magnet(hashOf(2)));
    jest.runAllTicks();
    const first = client.torrents[0];
    const discovery = first.discovery!;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(discovery.destroy).toHaveBeenCalled();
    expect(first.paused).toBe(true);
    expect(client.torrents).toHaveLength(2);
    first.resolveMetadata();
    expect(first.discovery).toBeNull();
    expect(manager.getAll().find((item) => item.infoHash === hashOf(1))?.status).toBe(
        'metadata-failed',
    );
});

test('pause stops pending peers and trackers; resume reconstructs discovery once', async () => {
    const { client, engine } = setup();
    await engine.addMagnetLink(magnet(hashOf(1)));
    jest.runAllTicks();
    const torrent = client.torrents[0];
    const discovery = torrent.discovery!;
    const peer = { destroy: jest.fn() };
    torrent._peers.set('pending', peer);
    await engine.pause(torrent.infoHash);
    expect(peer.destroy).toHaveBeenCalledTimes(1);
    expect(discovery.destroy).toHaveBeenCalledTimes(1);
    torrent.resolveMetadata(); // Native ready/store normally tries to start discovery again.
    expect(torrent.discovery).toBeNull();
    await engine.resume(torrent.infoHash);
    expect(torrent.discoveryStarts).toBe(2);
    expect(torrent.discovery?.destroyed).toBe(false);
});

test('queued buffers are born paused, before store initialization can announce', async () => {
    const { client, manager } = setup();
    await manager.addMagnetLink(magnet(hashOf(1)));
    const pending = manager.addTorrentBuffer(Buffer.from('d4:test4:datae'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    jest.runAllTicks();
    const item = await pending;
    expect(item.status).toBe('queued');
    expect(client.torrents[1].paused).toBe(true);
    expect(client.torrents[1].discoveryStarts).toBe(0);
});

test('removing a tracker destroys the actual discovery tracker object', async () => {
    const { client, engine } = setup();
    await engine.addMagnetLink(magnet(hashOf(1)));
    const torrent = client.torrents[0];
    const url = 'udp://tracker.example.com:6969/announce';
    torrent.announce = [url];
    jest.runAllTicks();
    const removed = torrent.discovery!.tracker._trackers[0];
    engine.removeTracker(torrent.infoHash, url);
    expect(removed.destroy).toHaveBeenCalledWith(expect.any(Function));
    expect(torrent.discovery!.tracker._trackers).toHaveLength(0);
    expect(engine.getTrackers(torrent.infoHash)).toHaveLength(0);
});

test('applying multiple favorite trackers creates one tracker client with the updated list', async () => {
    const { client, engine } = setup();
    await engine.addMagnetLink(magnet(hashOf(1)));
    jest.runAllTicks();
    const torrent = client.torrents[0];
    const discovery = torrent.discovery!;
    const old = discovery.tracker;
    engine.addTracker(torrent.infoHash, 'udp://one.example.com:6969/announce');
    engine.addTracker(torrent.infoHash, 'https://two.example.com/announce');
    jest.runAllTicks();
    expect(old.destroy).toHaveBeenCalledTimes(1);
    expect(discovery._createTracker).toHaveBeenCalledTimes(1);
    expect(discovery.tracker._trackers).toHaveLength(2);
    expect(engine.getTrackers(torrent.infoHash)[0].status).toBe('pending');
    discovery.tracker.emit('update', { announce: torrent.announce[0] });
    expect(engine.getTrackers(torrent.infoHash)[0].status).toBe('connected');
    discovery.tracker.emit('warning', new Error('DNS failure (' + torrent.announce[0] + ')'));
    expect(engine.getTrackers(torrent.infoHash)[0].status).toBe('error');
});

test('tracker budget applies to embedded URLs before discovery and to manual additions', async () => {
    const { client, engine } = setup();
    await engine.addMagnetLink(magnet(hashOf(1)));
    const torrent = client.torrents[0];
    torrent.announce = Array.from(
        { length: 100 },
        (_, i) => `udp://tracker${i}.example.com:6969/announce`,
    );
    jest.runAllTicks();
    expect(torrent.announce).toHaveLength(MAX_TRACKERS_PER_TORRENT);
    expect(torrent.discovery!.tracker._trackers).toHaveLength(MAX_TRACKERS_PER_TORRENT);
    expect(() => engine.addTracker(torrent.infoHash, 'https://extra.example.com/announce')).toThrow(
        /Limite/,
    );
});

test.each(['magnet', 'buffer'] as const)(
    'engine filtra trackers do %s antes da primeira descoberta',
    async (kind) => {
        const { client, engine } = setup();
        const work =
            kind === 'magnet'
                ? engine.addMagnetLink(`${magnet(hashOf(1))}&tr=http://127.0.0.1/announce`)
                : engine.addTorrentBuffer(Buffer.from('d4:test4:datae'));
        const torrent = client.torrents[0];
        torrent.announce = ['http://127.0.0.1/announce', 'https://tracker.example.com/announce'];
        jest.runAllTicks();
        await work;
        expect(torrent.discovery!.tracker._trackers.map((tracker) => tracker.announceUrl)).toEqual([
            'https://tracker.example.com/announce',
        ]);
    },
);

test('conclusão mantém a rede para seed e libera o slot de download', async () => {
    const { client, manager } = setup();
    await manager.addMagnetLink(magnet(hashOf(1)));
    await manager.addMagnetLink(magnet(hashOf(2)));
    jest.runAllTicks();
    const first = client.torrents[0];
    first.resolveMetadata();
    first.emit('done');
    await Promise.resolve();
    expect(first.paused).toBe(false);
    expect(first.discovery?.destroyed).toBe(false);
    expect(client.torrents).toHaveLength(2);
    expect(manager.getAll().find((item) => item.infoHash === first.infoHash)?.status).toBe(
        'seeding',
    );
});

test('restart calls share cleanup, and a timeout cannot create a second client later', async () => {
    const { client, engine } = setup();
    let finishDestroy!: () => void;
    client.destroy.mockImplementation((cb) => {
        finishDestroy = cb;
    });
    const first = engine.restart(options);
    const rejected = expect(first).rejects.toThrow(/expirou/);
    expect(engine.restart({ ...options, pexEnabled: false })).toBe(first);
    await jest.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(mockClients).toHaveLength(0);
    expect(engine.isRestarting()).toBe(true);
    finishDestroy();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(mockClients).toHaveLength(0);
    expect(engine.isRestarting()).toBe(false);
    await engine.restart(options);
    expect(mockClients).toHaveLength(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
});

test('restart re-adds metadata-pending magnets without waiting for ready', async () => {
    const { client, engine } = setup();
    await engine.addMagnetLink(magnet(hashOf(1)));
    await engine.restart({ ...options, pexEnabled: false });
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(mockClients).toHaveLength(1);
    expect(mockClients[0].utPex).toBe(false);
    expect(mockClients[0].torrents).toHaveLength(1);
    expect(engine.getAll()[0].status).toBe('resolving-metadata');
    const MockWebTorrent = jest.requireMock('webtorrent').default as jest.Mock;
    expect(MockWebTorrent).toHaveBeenLastCalledWith(expect.objectContaining({ utPex: false }));
});

test('metadata timers are suspended during restart and rearmed for the replacement client', async () => {
    const { client, engine, manager } = setup();
    await manager.addMagnetLink(magnet(hashOf(1)));
    await jest.advanceTimersByTimeAsync(50_000);
    let finishDestroy!: () => void;
    client.destroy.mockImplementation((cb) => {
        for (const torrent of [...client.torrents]) torrent.destroy({}, () => {});
        finishDestroy = cb;
    });
    const restarting = engine.restart(options);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(manager.getAll()[0].status).toBe('resolving-metadata');
    finishDestroy();
    await restarting;
    await jest.advanceTimersByTimeAsync(59_000);
    expect(manager.getAll()[0].status).toBe('resolving-metadata');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(manager.getAll()[0].status).toBe('metadata-failed');
    expect(mockClients[0].torrents[0].paused).toBe(true);
});

test('connection budgets include pending attempts, and disconnection wakes queued peers', () => {
    function swarm() {
        const peers = new Map<
            number,
            EventEmitter & { conn?: object; destroyed?: boolean; destroy: jest.Mock }
        >();
        const queue: Array<
            EventEmitter & { conn?: object; destroyed?: boolean; destroy: jest.Mock }
        > = [];
        return {
            _peers: peers,
            _registerPeer(peer: (typeof queue)[number]) {
                peers.set(peers.size, peer);
            },
            _drain() {
                const peer = queue.shift();
                if (peer) peer.conn = {};
            },
            add(peer: (typeof queue)[number]) {
                this._registerPeer(peer);
                queue.push(peer);
                this._drain();
            },
        };
    }
    const first = swarm();
    const second = swarm();
    const torrents = [first, second] as unknown as Torrent[];
    const budget = { maxPerTorrent: 2, maxTotal: 3, torrents: () => torrents };
    torrents.forEach((torrent) => configureTorrentNetwork(torrent, budget));
    for (let i = 0; i < 100; i++) {
        for (const torrent of [first, second]) {
            const peer = Object.assign(new EventEmitter(), { destroy: jest.fn() });
            torrent.add(peer);
        }
    }
    const connected = (torrent: typeof first) =>
        [...torrent._peers.values()].filter((peer) => peer.conn && !peer.destroyed);
    expect(connected(first)).toHaveLength(2);
    expect(connected(second)).toHaveLength(1);
    const closed = connected(first)[0];
    closed.destroyed = true;
    closed.emit('disconnect');
    jest.runAllTicks();
    expect(connected(first).length + connected(second).length).toBe(3);
    expect(connected(first).length).toBeLessThanOrEqual(2);
    const incoming = Object.assign(new EventEmitter(), { conn: {}, destroy: jest.fn() });
    second._registerPeer(incoming);
    expect(incoming.destroy).toHaveBeenCalledWith(expect.any(Error));
});

test('conclusão de dados verificados em torrent pausado aguarda discovery antes de anunciar', async () => {
    const { client } = setup();
    // Novo objeto para instalar os guards antes do primeiro ready, como na engine.
    const fresh = new MockTorrent(hashOf(2), magnet(hashOf(2)), client) as MockTorrent & {
        _checkDone: () => void;
    };
    fresh.paused = true;
    fresh._checkDone = jest.fn(() => {
        if (!fresh.discovery) throw new Error('discovery ausente');
    });
    const original = fresh._checkDone;
    configureTorrentNetwork(fresh as unknown as Torrent, {
        maxPerTorrent: 24,
        maxTotal: 100,
        torrents: () => [fresh as unknown as Torrent],
    });
    expect(() => fresh._checkDone()).not.toThrow();
    expect(original).not.toHaveBeenCalled();
    await resumeTorrentNetwork(fresh as unknown as Torrent);
    expect(original).toHaveBeenCalledTimes(1);
    expect(fresh.discovery).toBeDefined();
});

test('retomar seed rejeita dados incompletos antes de abrir a rede', async () => {
    const { client, engine } = setup();
    await engine.addMagnetLink(magnet(hashOf(1)), true);
    const torrent = client.torrents[0];
    torrent.resolveMetadata();
    jest.spyOn(engine, 'getFiles').mockReturnValue([
        { index: 0, name: 'a.bin', path: 'a.bin', length: 100, downloaded: 50, selected: true },
    ]);
    await expect(engine.resume(torrent.infoHash, true)).rejects.toThrow(
        'error.files.sourceMissing',
    );
    expect(torrent.resume).not.toHaveBeenCalled();
});

test('arquivos completos alinhados a peças usam bitfield verificado ao retomar seed', async () => {
    const { client, engine } = setup();
    await engine.addMagnetLink(magnet(hashOf(1)), true);
    const torrent = client.torrents[0];
    Object.assign(torrent, {
        ready: true,
        pieceLength: 16384,
        bitfield: { get: () => true },
        files: [
            { name: 'a.bin', path: 'a.bin', offset: 0, length: 16384, downloaded: 0, done: false },
        ],
    });
    expect(engine.getFiles(torrent.infoHash)[0].downloaded).toBe(16384);
    await expect(engine.resume(torrent.infoHash, true)).resolves.toBeUndefined();
});

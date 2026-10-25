import { EventEmitter } from 'events';
import type { Torrent } from 'webtorrent';
import {
    addTrackerToTorrent,
    configureTorrentNetwork,
    MAX_TRACKERS_PER_TORRENT,
    resumeTorrentNetwork,
} from '../../main/webtorrentInternals';

function setup() {
    const requestTracker = jest.fn();
    const requestMetadata = jest.fn();
    const requestWebSeed = jest.fn();
    const torrent = Object.assign(new EventEmitter(), {
        announce: [] as string[],
        xs: undefined as string | string[] | undefined,
        urlList: [] as string[],
        paused: false,
        destroyed: false,
        pause() {
            this.paused = true;
        },
        resume() {
            this.paused = false;
        },
        _startDiscovery() {
            this.announce.forEach((url) => requestTracker(url));
        },
        _getMetadataFromServer() {
            const urls = Array.isArray(this.xs) ? this.xs : [this.xs];
            urls.forEach((url) => requestMetadata(url));
        },
        addWebSeed(url: unknown) {
            requestWebSeed(url);
        },
    });
    const configure = () => configureTorrentNetwork(torrent as unknown as Torrent);
    return { torrent, configure, requestTracker, requestMetadata, requestWebSeed };
}

const blockedUrls = [
    'http://127.0.0.1/announce',
    'http://10.0.0.1/announce',
    'https://172.16.0.1/announce',
    'https://192.168.1.1/announce',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/announce',
    'http://[::1]/announce',
    'file:///private/input.torrent',
    'ftp://tracker.example.com/announce',
    'invalid',
];

test('filtra trackers embutidos antes da descoberta e antes de aplicar a cota', () => {
    const { torrent, configure, requestTracker } = setup();
    const allowed = [
        'https://tracker.example.com/announce',
        'http://tracker.example.com/announce',
        ...Array.from({ length: 25 }, (_, i) => `udp://tracker${i}.example.com:6969/announce`),
    ];
    torrent.announce = [...blockedUrls, ...allowed, allowed[0]!];
    configure();
    torrent._startDiscovery();
    expect(requestTracker.mock.calls.map(([url]) => url)).toEqual(
        allowed.slice(0, MAX_TRACKERS_PER_TORRENT),
    );
    expect(torrent.announce).toEqual(allowed.slice(0, MAX_TRACKERS_PER_TORRENT));
});

test.each(blockedUrls)('não consulta a fonte de metadados bloqueada %s', (url) => {
    const { torrent, configure, requestMetadata } = setup();
    torrent.xs = url;
    configure();
    torrent._getMetadataFromServer();
    expect(requestMetadata).not.toHaveBeenCalled();
});

test('consulta somente fontes HTTP(S) permitidas em magnets com múltiplos xs', () => {
    const { torrent, configure, requestMetadata } = setup();
    const allowed = ['https://metadata.example.com/file.torrent', 'http://metadata.example.com/'];
    torrent.xs = [...blockedUrls, 'udp://metadata.example.com:6969', ...allowed];
    configure();
    torrent._getMetadataFromServer();
    expect(requestMetadata.mock.calls.map(([url]) => url)).toEqual(allowed);
});

test('preserva a consulta de uma fonte de metadados pública escalar', () => {
    const { torrent, configure, requestMetadata } = setup();
    torrent.xs = 'https://metadata.example.com/file.torrent?key=test';
    configure();
    torrent._getMetadataFromServer();
    expect(requestMetadata.mock.calls).toEqual([
        ['https://metadata.example.com/file.torrent?key=test'],
    ]);
});

test.each([...blockedUrls, 'udp://seed.example.com:6969', null, {}])(
    'não cria conexão com o web seed bloqueado %j',
    (url) => {
        const { torrent, configure, requestWebSeed } = setup();
        configure();
        torrent.addWebSeed(url);
        expect(requestWebSeed).not.toHaveBeenCalled();
    },
);

test.each(['https://seed.example.com/Archive/', 'http://seed.example.com/a.bin?key=test'])(
    'preserva o caminho e a query do web seed permitido %s',
    (url) => {
        const { torrent, configure, requestWebSeed } = setup();
        configure();
        torrent.addWebSeed(url);
        expect(requestWebSeed).toHaveBeenCalledWith(url);
    },
);

test('revalida URLs recebidas depois dos metadados e ao retomar o torrent', async () => {
    const { torrent, configure, requestTracker, requestMetadata, requestWebSeed } = setup();
    configure();
    torrent.paused = true;
    torrent.announce = ['http://127.0.0.1/announce', 'udp://tracker.example.com:6969/announce'];
    torrent.xs = ['http://127.0.0.1/metadata', 'https://metadata.example.com/file.torrent'];
    torrent.urlList = ['http://127.0.0.1/file', 'https://seed.example.com/Archive/'];
    torrent._startDiscovery();
    torrent._getMetadataFromServer();
    torrent.urlList.forEach((url) => torrent.addWebSeed(url));
    expect(requestTracker).not.toHaveBeenCalled();
    expect(requestMetadata).not.toHaveBeenCalled();
    expect(requestWebSeed).not.toHaveBeenCalled();
    await resumeTorrentNetwork(torrent as unknown as Torrent);
    expect(requestTracker.mock.calls).toEqual([['udp://tracker.example.com:6969/announce']]);
    expect(requestMetadata.mock.calls).toEqual([['https://metadata.example.com/file.torrent']]);
    expect(requestWebSeed.mock.calls).toEqual([['https://seed.example.com/Archive/']]);
});

test('recriar o cliente de trackers também filtra anúncios recebidos posteriormente', async () => {
    const { torrent, configure } = setup();
    configure();
    const createTracker = jest.fn(() => ({ _trackers: [], destroy: jest.fn() }));
    const discovery = {
        _announce: [] as string[],
        tracker: { _trackers: [], destroy: jest.fn() },
        _createTracker: createTracker,
    };
    Object.assign(torrent, { discovery });
    torrent.announce = ['http://127.0.0.1/announce'];
    addTrackerToTorrent(torrent as unknown as Torrent, 'https://tracker.example.com/announce');
    await Promise.resolve();
    expect(createTracker).toHaveBeenCalledTimes(1);
    expect(discovery._announce).toEqual(['https://tracker.example.com/announce']);
});

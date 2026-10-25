import { lookup } from 'node:dns/promises';
import { Agent } from 'node:http';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { PassThrough } from 'node:stream';
import nodeFetch, { Headers } from 'node-fetch';
import type { Response } from 'node-fetch';
import { createTorrentFetch } from '../../main/torrentHttpTransport';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn(), Headers: global.Headers }));

const request = jest.mocked(nodeFetch);
const dnsLookup = lookup as unknown as jest.MockedFunction<
    (hostname: string) => Promise<LookupAddress[]>
>;
type GuardedAgent = Agent & { options: { lookup: LookupFunction } };
function response(status = 200, location?: string) {
    return {
        status,
        headers: new Headers(location ? { location } : {}),
        body: new PassThrough(),
    } as unknown as Response;
}
beforeEach(() => {
    jest.clearAllMocks();
    request.mockReset().mockResolvedValue(response());
    dnsLookup.mockReset().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});

test.each([
    'http://localhost./',
    'http://[fc00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'file:///etc/passwd',
])('rejeita %s antes do transporte', async (url) => {
    await expect(createTorrentFetch()(url)).rejects.toMatchObject({
        code: 'ERR_NETWORK_DESTINATION_BLOCKED',
    });
    expect(request).not.toHaveBeenCalled();
});

test('o agent efetivo valida o DNS e ignora agents externos', async () => {
    const fetch = createTorrentFetch();
    await fetch('https://tracker.example.com/announce', { agent: new Agent() });
    const options = request.mock.calls[0]![1]!;
    expect(options.redirect).toBe('manual');
    const agent = options.agent as GuardedAgent;
    const publicLookup = agent.options.lookup as LookupFunction;
    dnsLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const result = await new Promise((done) =>
        publicLookup('tracker.example.com', {}, (error, address) => done({ error, address })),
    );
    expect(result).toMatchObject({ error: { code: 'ERR_NETWORK_DESTINATION_BLOCKED' } });
});

test.each([
    'http://127.0.0.1/private',
    'http://[fd00::1]/private',
    'http://localhost./private',
    'file:///private',
])('não segue redirecionamento para %s', async (location) => {
    const redirect = response(302, location);
    request.mockResolvedValueOnce(redirect);
    await expect(createTorrentFetch()('http://tracker.example.com/announce')).rejects.toMatchObject(
        { code: 'ERR_NETWORK_DESTINATION_BLOCKED' },
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect((redirect.body as PassThrough).destroyed).toBe(true);
});

test('segue redirects relativos e públicos, remove credenciais entre origens e preserva Range/signal', async () => {
    request.mockResolvedValueOnce(response(302, '/next'));
    request.mockResolvedValueOnce(response(307, 'https://other.example.com/file'));
    const controller = new AbortController();
    await createTorrentFetch()('https://seed.example.com/file', {
        signal: controller.signal,
        headers: { authorization: 'synthetic', cookie: 'synthetic', range: 'bytes=0-15' },
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
        'https://seed.example.com/file',
        'https://seed.example.com/next',
        'https://other.example.com/file',
    ]);
    const options = request.mock.calls[2]![1]!;
    expect(options.signal).toBe(controller.signal);
    const headers = options.headers as Headers;
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('range')).toBe('bytes=0-15');
});

test('revalida DNS na conexão de cada hop, inclusive redirecionamentos para o mesmo hostname', async () => {
    const connected: string[] = [];
    request.mockImplementation(async (url, options) => {
        const publicLookup = (options!.agent as GuardedAgent).options.lookup;
        await new Promise<void>((done, reject) =>
            publicLookup(new URL(String(url)).hostname, {}, (error, address) => {
                if (error) reject(error);
                else {
                    connected.push(String(address));
                    done();
                }
            }),
        );
        return response(302, '/next');
    });
    dnsLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    dnsLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(
        createTorrentFetch()('https://tracker.example.com/announce'),
    ).rejects.toMatchObject({ code: 'ERR_NETWORK_DESTINATION_BLOCKED' });
    expect(connected).toEqual(['8.8.8.8']);
});

test('limita ciclos de redirects e bloqueia downgrade HTTPS', async () => {
    request.mockResolvedValue(response(302, '/loop'));
    await expect(createTorrentFetch()('https://tracker.example.com/announce')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(6);
    request.mockClear().mockResolvedValueOnce(response(302, 'http://tracker.example.com/announce'));
    await expect(createTorrentFetch()('https://tracker.example.com/announce')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
});

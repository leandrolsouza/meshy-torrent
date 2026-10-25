import log from 'electron-log';
import { EventEmitter } from 'node:events';
import type WebTorrent from 'webtorrent';
import { createScopedLogger, logger, setDebugEnabled } from '../../main/logger';
import { redactLogValue, redactSensitiveText } from '../../main/logRedaction';
import { createTorrentEngine } from '../../main/torrentEngine';

jest.mock('webtorrent', () => jest.fn());
const secret = 'SYNTHETIC_PRIVATE_PASSKEY';
const url = `https://user:password@tracker.example.test/${secret}/announce?token=${secret}`;

afterEach(() => {
    jest.clearAllMocks();
    setDebugEnabled(false);
});

test.each([
    `Non-200 response code 403 from ${url}`,
    `Erro (udp://tracker.example.test/${secret}/announce)`,
    `Erro "wss://tracker.example.test/?passkey=${secret}"`,
    `Erro magnet:?xt=urn:btih:${'a'.repeat(40)}&tr=${encodeURIComponent(url)}`,
    `Erro ${encodeURIComponent(url)}`,
    `Erro ${encodeURIComponent(encodeURIComponent(url))}`,
    `Erro https:\\/\\/tracker.example.test/${secret}/announce`,
    `Erro https://tracker.example.test/key ${secret}/announce`,
    `Erro https://tracker.example.test/key<${secret}>/announce`,
    `Erro https://tracker.example.test/key\n${secret}/announce`,
])('omite URLs completas de avisos, magnets e representações escapadas', (message) => {
    const redacted = redactSensitiveText(message);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('password');
    expect(redacted).toContain('[URL omitida]');
});

test('redige objetos, Errors, causas e campos secretos sem alterar os valores originais', () => {
    const error = Object.assign(new Error(`Falha em ${url}`), { cause: { url, passkey: secret } });
    const data = {
        nested: [error],
        authorization: secret,
        torrentFileBase64: Buffer.from(url).toString('base64'),
    };
    const redacted = JSON.stringify(redactLogValue(data));
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(Buffer.from(url).toString('base64'));
    expect(error.message).toContain(secret);
    expect(data.authorization).toBe(secret);
});

test('ciclos, buffers e accessors não expõem dados nem impedem o registro', () => {
    const data: Record<string, unknown> = { buffer: Buffer.from(secret), url: new URL(url) };
    data.self = data;
    const getter = jest.fn(() => {
        throw new Error(secret);
    });
    Object.defineProperty(data, 'unsafe', { enumerable: true, get: getter });
    const redacted = JSON.stringify(redactLogValue(data));
    expect(redacted).not.toContain(secret);
    expect(getter).not.toHaveBeenCalled();
});

test('todos os níveis e o logger de escopo redigem antes de chamar electron-log', () => {
    setDebugEnabled(true);
    for (const level of ['info', 'warn', 'error', 'debug'] as const) logger[level](url, { url });
    createScopedLogger(logger, { channel: 'tracker:add' }).error(`Falha ${url}`, {
        error: new Error(url),
    });
    const recorded = JSON.stringify([
        jest.mocked(log.info).mock.calls,
        jest.mocked(log.warn).mock.calls,
        jest.mocked(log.error).mock.calls,
    ]);
    expect(recorded).not.toContain(secret);
    expect(recorded).toContain('tracker:add');
});

test('aviso real da interface da engine não leva a passkey ao destino dos logs', async () => {
    const torrent = Object.assign(new EventEmitter(), { infoHash: 'a'.repeat(40), ready: false });
    const client = Object.assign(new EventEmitter(), { torrents: [], add: jest.fn(() => torrent) });
    const engine = createTorrentEngine(
        {
            downloadPath: '/fixture',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            dhtEnabled: false,
            pexEnabled: false,
            utpEnabled: false,
        },
        client as unknown as WebTorrent,
    );
    await engine.addMagnetLink(`magnet:?xt=urn:btih:${torrent.infoHash}`);
    torrent.emit('warning', new Error(`Non-200 response code 403 from ${url}`));
    const recorded = JSON.stringify(jest.mocked(log.warn).mock.calls);
    expect(recorded).toContain('Aviso de rede');
    expect(recorded).not.toContain(secret);
});

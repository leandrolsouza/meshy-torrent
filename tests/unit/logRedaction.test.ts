import log from 'electron-log';
import { EventEmitter } from 'node:events';
import type WebTorrent from 'webtorrent';
import { createScopedLogger, logger, setDebugEnabled } from '../../main/logger';
import { redactLogValue, redactSensitiveText, serializeLogError } from '../../main/logRedaction';
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

test.each([
    String.raw`EACCES: open 'C:\Users\PessoaSintetica\Downloads\documento privado.torrent'`,
    String.raw`Erro ao ler C:\Users\PessoaSintetica\Meus Documentos\documento.torrent`,
    String.raw`Erro ao ler C:/Users/PessoaSintetica/Downloads/documento.torrent`,
    String.raw`Erro ao ler \\servidor\PessoaSintetica\documento privado.torrent`,
    `Erro ao ler //servidor/PessoaSintetica/documento privado.torrent`,
    `EACCES: open '/home/PessoaSintetica/Meus documentos/documento.torrent'`,
    `Erro ao ler /Users/PessoaSintetica/Downloads/documento.torrent`,
    `Erro ao ler file:///C:/Users/PessoaSintetica/documento.torrent`,
    `Erro ao ler file:///home/PessoaSintetica/documento.torrent`,
])('omite caminhos pessoais completos, inclusive espaços: %s', (message) => {
    const redacted = redactSensitiveText(message);
    expect(redacted).not.toContain('PessoaSintetica');
    expect(redacted).not.toContain('documento');
    expect(redacted).toContain('[caminho omitido]');
});

test('preserva frames e códigos sem caminho ao redigir stacks e causas', () => {
    const error = Object.assign(
        new Error(String.raw`EACCES: open 'C:\Users\PessoaSintetica\documento.torrent'`),
        { cause: new Error('EIO: open /home/PessoaSintetica/documento.torrent') },
    );
    error.stack = `${error.message}\n    at readFile (C:\\Users\\PessoaSintetica\\app.js:12:3)\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)`;
    const redacted = JSON.stringify(redactLogValue(error));
    expect(redacted).not.toContain('PessoaSintetica');
    expect(redacted).not.toContain('documento.torrent');
    expect(redacted).toContain('EACCES');
    expect(redacted).toContain('EIO');
    expect(redacted).toContain('at readFile');
    expect(redacted).toContain('node:internal/process/task_queues:105:5');
    expect(error.message).toContain('PessoaSintetica');
});

test.each([
    'Falha para pessoa.sintetica@example.test',
    'Conexão recusada 192.0.2.42:6881',
    'Conexão recusada [2001:db8::42]:6881',
    'Conexão recusada ::ffff:192.0.2.42',
    'Conexão recusada fe80::42%eth0',
])('redige e-mails e endereços IP em texto: %s', (message) => {
    const redacted = redactSensitiveText(message);
    expect(redacted).not.toContain('pessoa.sintetica@example.test');
    expect(redacted).not.toContain('192.0.2.42');
    expect(redacted).not.toContain('2001:db8::42');
    expect(redacted).not.toContain('::ffff:');
    expect(redacted).not.toContain('fe80::42');
    expect(redacted).toMatch(/\[(?:e-mail|IP) omitido\]/);
});

test('preserva identificadores operacionais, versões, horários e durações', () => {
    const message =
        'torrent:pause cid=abc12345 error.operation.failed v1.2.3 12:34:56 durationMs=250';
    expect(redactSensitiveText(message)).toBe(message);
    expect(redactLogValue({ infoHash: 'abc12345', durationMs: 250, errorCode: 'EACCES' })).toEqual({
        infoHash: 'abc12345',
        durationMs: 250,
        errorCode: 'EACCES',
    });
});

test('omite campos pessoais aninhados mesmo quando o valor não tem formato reconhecível', () => {
    const personal = {
        name: 'PRIVATE_NAME',
        full_name: 'PRIVATE_FULL_NAME',
        userId: 'PRIVATE_USER_ID',
        address: 'PRIVATE_ADDRESS',
        phoneNumber: 'PRIVATE_PHONE',
        cpf: 'PRIVATE_CPF',
        cnpj: 'PRIVATE_CNPJ',
    };
    const redacted = JSON.stringify(redactLogValue({ details: [personal] }));
    for (const value of Object.values(personal)) expect(redacted).not.toContain(value);
    expect(personal.name).toBe('PRIVATE_NAME');
});

test.each(['info', 'warn', 'error', 'debug'] as const)(
    'logger de escopo sanitiza campos antes de formatar em %s, inclusive com base injetada',
    (level) => {
        const base = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        const getter = jest.fn(() => secret);
        const toString = jest.fn(() => secret);
        const context = {
            token: secret,
            password: secret,
            nested: { authorization: secret, toString },
            username: 'PessoaSintetica',
            email: 'pessoa@example.test',
            ip: '192.0.2.42',
            peerId: 'PRIVATE_PEER_ID',
            durationMs: 25,
        };
        Object.defineProperty(context, 'unsafe', { enumerable: true, get: getter });
        const scoped = createScopedLogger(base, { channel: 'torrent:pause', passkey: secret });
        scoped[level]('Falha EACCES', context);
        const recorded = JSON.stringify(base[level].mock.calls);
        expect(recorded).not.toContain(secret);
        expect(recorded).not.toContain('PessoaSintetica');
        expect(recorded).not.toContain('pessoa@example.test');
        expect(recorded).not.toContain('192.0.2.42');
        expect(recorded).not.toContain('PRIVATE_PEER_ID');
        expect(recorded).toContain('torrent:pause');
        expect(base[level]).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ durationMs: 25, channel: 'torrent:pause', schemaVersion: 1 }),
        );
        expect(recorded).toContain('EACCES');
        expect(getter).not.toHaveBeenCalled();
        expect(toString).not.toHaveBeenCalled();
        expect(context.token).toBe(secret);
    },
);

test('sanitiza accessors do contexto base e preserva contexto útil após um caminho na mensagem', () => {
    const base = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const channel = jest.fn(() => secret);
    const baseContext = { token: secret };
    Object.defineProperty(baseContext, 'channel', { enumerable: true, get: channel });
    const scoped = createScopedLogger(base, baseContext);
    scoped.error(String.raw`EACCES: open 'C:\Users\PessoaSintetica\documento.torrent'`, {
        durationMs: 25,
        nested: { bytes: 100n },
    });
    const recorded = JSON.stringify(base.error.mock.calls);
    expect(recorded).not.toContain(secret);
    expect(recorded).not.toContain('PessoaSintetica');
    expect(base.error).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ durationMs: 25, nested: { bytes: '100' } }),
    );
    expect(recorded).toContain('100');
    expect(channel).not.toHaveBeenCalled();
});

test.each(['info', 'warn', 'error', 'debug'] as const)(
    'destino electron-log não recebe caminhos, dados pessoais ou segredos em %s',
    (level) => {
        setDebugEnabled(true);
        const message = String.raw`EACCES: open 'C:\Users\PessoaSintetica\documento.torrent'`;
        logger[level](message, new Error(message), { email: 'pessoa@example.test', token: secret });
        createScopedLogger(logger, { channel: 'renderer:report-error', token: secret })[level](
            'Falha para pessoa@example.test',
            { path: '/home/PessoaSintetica/documento.torrent', password: secret },
        );
        const recorded = JSON.stringify([
            jest.mocked(log.info).mock.calls,
            jest.mocked(log.warn).mock.calls,
            jest.mocked(log.error).mock.calls,
        ]);
        expect(recorded).not.toContain('PessoaSintetica');
        expect(recorded).not.toContain('documento.torrent');
        expect(recorded).not.toContain('pessoa@example.test');
        expect(recorded).not.toContain(secret);
        expect(recorded).toContain('EACCES');
    },
);

test('diagnóstico preserva tipo, stack, códigos e causas sem repassar objetos originais', () => {
    const cause = Object.assign(new Error('Falha de disco'), {
        code: 'ENOSPC',
        errno: -28,
        syscall: 'write',
    });
    const error = Object.assign(new TypeError('Falha na operação'), {
        code: 'EIO',
        errno: -5,
        syscall: 'read',
        cause,
        token: secret,
        path: String.raw`C:\Users\PessoaSintetica\arquivo.torrent`,
    });
    const safe = serializeLogError(error);
    expect(safe).toMatchObject({
        type: 'TypeError',
        message: 'Falha na operação',
        code: 'EIO',
        errno: -5,
        syscall: 'read',
        stack: expect.stringContaining('TypeError: Falha na operação'),
        cause: {
            type: 'Error',
            code: 'ENOSPC',
            errno: -28,
            syscall: 'write',
            stack: expect.any(String),
        },
    });
    expect(safe).not.toBe(error);
    expect(safe.cause).not.toBe(cause);
    expect(redactLogValue(safe)).toEqual(safe);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(JSON.stringify(safe)).not.toContain('PessoaSintetica');
    expect(error.cause).toBe(cause);
    expect(error.token).toBe(secret);
});

test('causas cíclicas e AggregateError são serializáveis e preservam falhas componentes', () => {
    const cause = Object.assign(new Error('Causa'), { cause: undefined as unknown });
    cause.cause = cause;
    const first = Object.assign(new Error(`Falha ${url}`), { code: 'ECONNRESET' });
    // O runtime Node suporta AggregateError; o projeto Jest mantém lib ES2020.
    const NativeAggregateError = Reflect.get(globalThis, 'AggregateError') as new (
        errors: unknown[],
        message: string,
    ) => Error;
    const aggregate = new NativeAggregateError([first, cause], 'Falhas múltiplas');
    const safe = serializeLogError(aggregate);
    expect(safe).toMatchObject({
        type: 'AggregateError',
        errors: [
            { type: 'Error', code: 'ECONNRESET', message: 'Falha [URL omitida]' },
            { type: 'Error', cause: '[objeto omitido]' },
        ],
    });
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(JSON.stringify(safe)).not.toContain(secret);
});

test('arrays de erros e strings encapsuladas não executam map, getters ou conversores próprios', () => {
    const getter = jest.fn(() => {
        throw new Error(secret);
    });
    const map = jest.fn(() => secret);
    const errors = [new Error('Componente')];
    Object.defineProperty(errors, '1', { enumerable: true, get: getter });
    Object.defineProperty(errors, 'map', { value: map });
    const error = Object.assign(new Error('Falhas'), { errors });
    expect(serializeLogError(error)).toMatchObject({
        errors: [{ type: 'Error', message: 'Componente' }, '[acessor omitido]'],
    });
    const boxed = Object(url);
    Object.defineProperty(boxed, 'toString', { get: getter });
    Object.defineProperty(boxed, 'valueOf', { get: getter });
    expect(redactLogValue(boxed)).toBe('[URL omitida]');
    expect(getter).not.toHaveBeenCalled();
    expect(map).not.toHaveBeenCalled();
});

test.each(['name', 'message', 'stack', 'code', 'errno', 'syscall', 'cause'])(
    'não executa accessor substituído em Error.%s',
    (field) => {
        const error = new Error('Falha');
        const getter = jest.fn(() => {
            throw new Error(secret);
        });
        Object.defineProperty(error, field, { configurable: true, get: getter });
        expect(() => serializeLogError(error)).not.toThrow();
        expect(JSON.stringify(serializeLogError(error))).not.toContain(secret);
        expect(getter).not.toHaveBeenCalled();
    },
);

test.each([
    undefined,
    null,
    'Falha sintética',
    42,
    { message: 'Falha sintética', code: 'EIO' },
    [{ toString: (): string => secret }],
])('normaliza valores lançados que não são Error: %p', (value) => {
    const safe = serializeLogError(value);
    expect(safe.type).toBe('NonError');
    expect(typeof safe.message).toBe('string');
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(JSON.stringify(safe)).not.toContain(secret);
});

test.each(['info', 'warn', 'error', 'debug'] as const)(
    'logger de escopo entrega evento como objeto estruturado em %s',
    (level) => {
        const base = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        const scoped = createScopedLogger(base, { channel: 'torrent:pause' });
        const error = Object.assign(new Error('Mesma mensagem'), { code: 'EACCES' });
        scoped[level]('Falha na operação IPC', { event: 'ipc.operation.failed', error });
        expect(base[level]).toHaveBeenCalledWith('[torrent:pause] Falha na operação IPC', {
            schemaVersion: 1,
            event: 'ipc.operation.failed',
            channel: 'torrent:pause',
            error: expect.objectContaining({
                type: 'Error',
                message: 'Mesma mensagem',
                code: 'EACCES',
                stack: expect.any(String),
            }),
        });
    },
);

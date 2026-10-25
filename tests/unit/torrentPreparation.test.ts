import { EventEmitter } from 'events';
import WebTorrent from 'webtorrent';
import { createTorrentPreparation, MetadataOnlyStore } from '../../main/torrentPreparation';
import { ErrorCodes } from '../../shared/errorCodes';
jest.mock('webtorrent', () => jest.fn());

function setup(automatic = true) {
    const torrent = Object.assign(new EventEmitter(), {
        infoHash: 'a'.repeat(40),
        name: 'Archive',
        magnetURI: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
        torrentFile: Buffer.from('d4:test4:datae'),
        metadata: null,
        files: [{ name: 'a.bin', path: 'Archive/a.bin', length: 123 }],
        wires: [],
        announce: [],
    });
    const client = Object.assign(new EventEmitter(), {
        add: jest.fn(() => {
            if (automatic) Promise.resolve().then(() => torrent.emit('metadata'));
            return torrent;
        }),
        destroy: jest.fn((callback: (error?: Error) => void) => {
            torrent.emit('close');
            callback();
        }),
    });
    const service = createTorrentPreparation({
        createClient: () => client as unknown as WebTorrent,
        metadataTimeoutMs: 100,
        cleanupTimeoutMs: 50,
    });
    return { service, torrent, client };
}
test('obtém metadados com zero seleção, armazenamento sem disco e encerra a rede antes de apresentar a revisão', async () => {
    const { service, client } = setup();
    const preview = await service.prepare('request-123', {
        kind: 'buffer',
        buffer: Buffer.from('de'),
    });
    expect(client.add).toHaveBeenCalledWith(
        Buffer.from('de'),
        expect.objectContaining({
            deselect: true,
            uploads: false,
            storeCacheSlots: 0,
            store: MetadataOnlyStore,
        }),
    );
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(preview).toMatchObject({
        requestId: 'request-123',
        name: 'Archive',
        files: [{ index: 0, length: 123, downloaded: 0 }],
    });
    expect(service.get('request-123').buffer).toEqual(Buffer.from('d4:test4:datae'));
    service.dispose();
});

describe('encerramento limitado da preparação', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test.each([
        ['timeout', ErrorCodes.METADATA_TIMEOUT],
        ['cancelamento', ErrorCodes.PREPARATION_CANCELLED],
        ['erro de rede', 'rede indisponível'],
        ['metadados prontos', ErrorCodes.OPERATION_FAILED],
    ])('%s conclui mesmo se destroy não chamar o callback', async (trigger, expected) => {
        const { service, client, torrent } = setup(false);
        client.destroy.mockImplementation(() => {});
        let result: string | undefined;
        const work = service.prepare('request-123', {
            kind: 'buffer',
            buffer: Buffer.from('de'),
        });
        const observed = work.then(
            () => {
                result = 'success';
            },
            (error: Error) => {
                result = error.message;
            },
        );
        if (trigger === 'timeout') await jest.advanceTimersByTimeAsync(100);
        else if (trigger === 'cancelamento') service.cancel('request-123');
        else if (trigger === 'erro de rede') client.emit('error', new Error('rede indisponível'));
        else torrent.emit('metadata');

        await jest.advanceTimersByTimeAsync(49);
        expect(result).toBeUndefined();
        await jest.advanceTimersByTimeAsync(1);
        expect(result).toBe(expected);
        await observed;
        expect(client.destroy).toHaveBeenCalledTimes(1);
        expect(() => service.get('request-123')).toThrow('preparationExpired');
        service.dispose();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('aguarda o callback de encerramento antes de publicar metadados e limpa o timer', async () => {
        const { service, client, torrent } = setup(false);
        let finishCleanup!: (error?: Error) => void;
        client.destroy.mockImplementation((callback) => {
            finishCleanup = callback;
        });
        let published = false;
        const work = service.prepare('request-123', {
            kind: 'buffer',
            buffer: Buffer.from('de'),
        });
        void work.then(() => {
            published = true;
        });
        torrent.emit('metadata');
        await jest.advanceTimersByTimeAsync(49);
        expect(published).toBe(false);
        expect(() => service.get('request-123')).toThrow('preparationExpired');
        finishCleanup();
        await expect(work).resolves.toMatchObject({ requestId: 'request-123' });
        await jest.advanceTimersByTimeAsync(51);
        expect(service.get('request-123').preview.name).toBe('Archive');
        service.dispose();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('quatro encerramentos travados liberam as vagas para uma nova preparação', async () => {
        const clients = Array.from({ length: 5 }, () => setup(false));
        clients.slice(0, 4).forEach(({ client }) => client.destroy.mockImplementation(() => {}));
        let index = 0;
        const service = createTorrentPreparation({
            createClient: () => clients[index++]!.client as unknown as WebTorrent,
            metadataTimeoutMs: 100,
            cleanupTimeoutMs: 50,
        });
        const errors: string[] = [];
        const pending = Array.from({ length: 4 }, (_, request) =>
            service
                .prepare(`request-${request}`, { kind: 'buffer', buffer: Buffer.from('de') })
                .catch((error: Error) => {
                    errors.push(error.message);
                }),
        );
        await expect(
            service.prepare('fifth', {
                kind: 'buffer',
                buffer: Buffer.from('de'),
            }),
        ).rejects.toThrow('params.invalid');
        await jest.advanceTimersByTimeAsync(150);
        expect(errors).toHaveLength(4);
        expect(errors.every((error) => error.includes('metadataTimeout'))).toBe(true);
        await Promise.all(pending);

        const retry = service.prepare('fifth', { kind: 'buffer', buffer: Buffer.from('de') });
        clients[4]!.torrent.emit('metadata');
        await expect(retry).resolves.toMatchObject({ requestId: 'fifth' });
        service.dispose();
        expect(jest.getTimerCount()).toBe(0);
    });

    test.each(['metadados', 'cancelamento'])(
        'uma exceção síncrona de destroy não escapa do evento de %s',
        async (trigger) => {
            const { service, client, torrent } = setup(false);
            client.destroy.mockImplementation(() => {
                throw new Error('destroy falhou');
            });
            const work = service.prepare('request-123', {
                kind: 'buffer',
                buffer: Buffer.from('de'),
            });
            const rejection = expect(work).rejects.toThrow(
                trigger === 'cancelamento' ? 'preparationCancelled' : 'destroy falhou',
            );
            expect(() => {
                if (trigger === 'cancelamento') service.cancel('request-123');
                else torrent.emit('metadata');
            }).not.toThrow();
            await rejection;
            expect(jest.getTimerCount()).toBe(0);
        },
    );

    test('cancelamento durante o encerramento impede um rascunho tardio', async () => {
        const { service, client, torrent } = setup(false);
        let finishCleanup!: (error?: Error) => void;
        client.destroy.mockImplementation((callback) => {
            finishCleanup = callback;
        });
        const work = service.prepare('request-123', {
            kind: 'buffer',
            buffer: Buffer.from('de'),
        });
        const rejection = expect(work).rejects.toThrow('preparationCancelled');
        torrent.emit('metadata');
        service.cancel('request-123');
        await jest.advanceTimersByTimeAsync(50);
        await rejection;
        finishCleanup();
        torrent.emit('metadata');
        expect(() => service.get('request-123')).toThrow('preparationExpired');
        expect(client.destroy).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('callback tardio não interfere em uma nova preparação com o mesmo identificador', async () => {
        const clients = [setup(false), setup(false)];
        let finishOldCleanup!: (error?: Error) => void;
        clients[0]!.client.destroy.mockImplementation((callback) => {
            finishOldCleanup = callback;
        });
        let index = 0;
        const service = createTorrentPreparation({
            createClient: () => clients[index++]!.client as unknown as WebTorrent,
            metadataTimeoutMs: 100,
            cleanupTimeoutMs: 50,
        });
        const old = service.prepare('request-123', {
            kind: 'buffer',
            buffer: Buffer.from('de'),
        });
        const rejection = expect(old).rejects.toThrow(ErrorCodes.OPERATION_FAILED);
        clients[0]!.torrent.emit('metadata');
        await jest.advanceTimersByTimeAsync(50);
        await rejection;

        const retry = service.prepare('request-123', {
            kind: 'buffer',
            buffer: Buffer.from('de'),
        });
        clients[1]!.torrent.emit('metadata');
        const preview = await retry;
        finishOldCleanup(new Error('falha tardia'));
        clients[0]!.torrent.emit('metadata');
        clients[0]!.client.emit('error', new Error('erro tardio'));
        expect(service.get('request-123').preview).toEqual(preview);
        service.dispose();
        expect(jest.getTimerCount()).toBe(0);
    });
});
test('cancelar enquanto aguarda metadados encerra o cliente e não deixa rascunho', async () => {
    const { service, client, torrent } = setup(false);
    const work = service.prepare('request-123', {
        kind: 'magnet',
        magnetUri: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    });
    const rejection = expect(work).rejects.toThrow('preparationCancelled');
    service.cancel('request-123');
    torrent.emit('metadata');
    await rejection;
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(() => service.get('request-123')).toThrow('preparationExpired');
});
test('timeout e erro de rede liberam os recursos', async () => {
    jest.useFakeTimers();
    try {
        const { service, client } = setup(false);
        const work = service.prepare('request-123', { kind: 'buffer', buffer: Buffer.from('de') });
        const rejection = expect(work).rejects.toThrow('metadataTimeout');
        await jest.advanceTimersByTimeAsync(101);
        await rejection;
        expect(client.destroy).toHaveBeenCalledTimes(1);
        service.dispose();
    } finally {
        jest.useRealTimers();
    }
    const { service, client } = setup(false);
    const work = service.prepare('request-456', { kind: 'buffer', buffer: Buffer.from('de') });
    const rejection = expect(work).rejects.toThrow('rede indisponível');
    client.emit('error', new Error('rede indisponível'));
    await rejection;
    expect(client.destroy).toHaveBeenCalledTimes(1);
});
test('rascunhos cancelados e entradas inválidas não criam clientes adicionais', async () => {
    const invalid = setup();
    await expect(
        invalid.service.prepare('request-123', { kind: 'buffer', buffer: Buffer.from('invalid') }),
    ).rejects.toThrow('invalidFilePath');
    expect(invalid.client.add).not.toHaveBeenCalled();
    const { service } = setup();
    await service.prepare('request-456', { kind: 'buffer', buffer: Buffer.from('de') });
    await expect(
        service.prepare('request-456', { kind: 'buffer', buffer: Buffer.from('de') }),
    ).rejects.toThrow('params.invalid');
    service.cancel('request-456');
    expect(() => service.get('request-456')).toThrow('preparationExpired');
});

test('rascunhos expiram após dez minutos sem confirmação', async () => {
    jest.useFakeTimers();
    try {
        const { service } = setup();
        await service.prepare('request-123', { kind: 'buffer', buffer: Buffer.from('de') });
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(() => service.get('request-123')).toThrow('preparationExpired');
        service.dispose();
    } finally {
        jest.useRealTimers();
    }
});

test('a preparação respeita as configurações de rede atuais', async () => {
    const { client } = setup();
    jest.mocked(WebTorrent).mockImplementation(() => client as unknown as WebTorrent);
    const getNetworkOptions = jest.fn(() => ({
        dhtEnabled: false,
        pexEnabled: false,
        utpEnabled: false,
    }));
    const service = createTorrentPreparation({ getNetworkOptions });
    await service.prepare('request-123', { kind: 'buffer', buffer: Buffer.from('de') });
    expect(WebTorrent).toHaveBeenLastCalledWith(
        expect.objectContaining({ dht: false, utp: false, utPex: false }),
    );
    expect((client as unknown as WebTorrent).utPex).toBe(false);
    service.dispose();
});
test('o armazenamento de preparação recusa conteúdo e não devolve peças', async () => {
    const store = new MetadataOnlyStore();
    await new Promise<void>((resolve) =>
        store.get(0, {}, (error) => {
            expect(error).toBeInstanceOf(Error);
            resolve();
        }),
    );
    await new Promise<void>((resolve) =>
        store.put(0, new Uint8Array([1]), (error) => {
            expect(error.message).toMatch(/não transfere/);
            resolve();
        }),
    );
});

import type { LookupAddress } from 'node:dns';
import { createPublicLookup } from '../../main/torrentNetworkPolicy';

function setup(records: LookupAddress[]) {
    const resolveAll = jest.fn(async () => records);
    const lookup = createPublicLookup(resolveAll);
    const resolve = (host = 'tracker.example.com', options = {}) =>
        new Promise<{
            error: NodeJS.ErrnoException | null;
            address: string | LookupAddress[];
            family?: number;
        }>((done) =>
            lookup(host, options, (error, address, family) => done({ error, address, family })),
        );
    return { resolveAll, resolve };
}

test.each(
    [
        [],
        [{ address: '127.0.0.1', family: 4 }],
        [{ address: '10.0.0.1', family: 4 }],
        [{ address: 'fc00::1', family: 6 }],
        [{ address: '::ffff:192.168.1.1', family: 6 }],
        [
            { address: '8.8.8.8', family: 4 },
            { address: 'fe80::1', family: 6 },
        ],
    ].map((records) => ({ records })),
)('falha fechada para respostas DNS vazias, privadas ou mistas: %j', async ({ records }) => {
    const { resolve } = setup(records);
    expect(await resolve()).toMatchObject({ error: { code: 'ERR_NETWORK_DESTINATION_BLOCKED' } });
});

test('entrega ao socket os próprios IPs validados e respeita family/all', async () => {
    const addresses = [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
    ];
    const { resolve, resolveAll } = setup(addresses);
    expect(await resolve()).toMatchObject({ error: null, address: '8.8.8.8', family: 4 });
    expect(await resolve('tracker.example.com', { family: 6, all: true })).toMatchObject({
        error: null,
        address: [addresses[1]],
    });
    expect(resolveAll).toHaveBeenCalledTimes(2);
});

test('revalida a cada conexão e bloqueia DNS rebinding', async () => {
    const { resolve, resolveAll } = setup([{ address: '8.8.8.8', family: 4 }]);
    expect((await resolve()).error).toBeNull();
    resolveAll.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    expect((await resolve()).error?.code).toBe('ERR_NETWORK_DESTINATION_BLOCKED');
});

test('não consulta DNS para IP literal ou hostname local bloqueado', async () => {
    const { resolve, resolveAll } = setup([]);
    expect((await resolve('8.8.8.8')).address).toBe('8.8.8.8');
    expect((await resolve('localhost.')).error?.code).toBe('ERR_NETWORK_DESTINATION_BLOCKED');
    expect(resolveAll).not.toHaveBeenCalled();
});

test('rejeita falha de resolução e ausência de endereço da família pedida', async () => {
    const { resolve, resolveAll } = setup([{ address: '8.8.8.8', family: 4 }]);
    expect((await resolve('tracker.example.com', { family: 6 })).error).not.toBeNull();
    resolveAll.mockRejectedValueOnce(new Error('DNS indisponível'));
    expect((await resolve()).error?.code).toBe('ERR_NETWORK_DESTINATION_BLOCKED');
});

test('hostname ausente é bloqueado sem chamar replace em undefined', async () => {
    const lookup = createPublicLookup();
    const result = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
        lookup(undefined as unknown as string, {}, (error) => resolve(error)),
    );
    expect(result?.code).toBe('ERR_NETWORK_DESTINATION_BLOCKED');
});

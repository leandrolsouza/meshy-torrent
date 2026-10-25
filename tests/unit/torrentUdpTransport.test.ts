import { EventEmitter } from 'node:events';
import type dgram from 'node:dgram';
import type { LookupAddress } from 'node:dns';
import { createPublicLookup } from '../../main/torrentNetworkPolicy';
import { createTorrentUdpTransport } from '../../main/torrentUdpTransport';

function setup(addresses: LookupAddress[] = [{ address: '8.8.8.8', family: 4 }]) {
    const send = jest.fn();
    const raw = Object.assign(new EventEmitter(), { send, close: jest.fn() });
    const error = jest.fn();
    raw.on('error', error);
    const resolveAll = jest.fn(async () => addresses);
    const createSocket = jest.fn(() => raw) as unknown as typeof dgram.createSocket;
    const transport = createTorrentUdpTransport(createSocket, createPublicLookup(resolveAll));
    const socket = transport.createSocket('udp4');
    return { raw, socket, send, error, resolveAll };
}

test('envia ao IP público validado sem resolver novamente o hostname', async () => {
    const { socket, send, resolveAll } = setup();
    const payload = new Uint8Array([1, 2]);
    socket.send(payload, 0, 2, 6969, 'tracker.example.com');
    await new Promise((done) => setImmediate(done));
    expect(send).toHaveBeenCalledWith(payload, 0, 2, 6969, '8.8.8.8');
    expect(resolveAll).toHaveBeenCalledTimes(1);
});

test('rejeita resolução privada e rebinding antes de enviar datagramas', async () => {
    const { socket, send, error, resolveAll } = setup();
    const payload = new Uint8Array([1]);
    socket.send(payload, 0, 1, 6969, 'tracker.example.com');
    await new Promise((done) => setImmediate(done));
    resolveAll.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    socket.send(payload, 0, 1, 6969, 'tracker.example.com');
    await new Promise((done) => setImmediate(done));
    expect(send).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ERR_NETWORK_DESTINATION_BLOCKED' }),
    );
});

test('encerrar o socket enquanto resolve DNS impede envio tardio', async () => {
    const { socket, send, resolveAll } = setup();
    let finish!: (addresses: LookupAddress[]) => void;
    resolveAll.mockImplementationOnce(
        () =>
            new Promise((done) => {
                finish = done;
            }),
    );
    socket.send(new Uint8Array([1]), 0, 1, 6969, 'tracker.example.com');
    await Promise.resolve();
    // Simula close antes do bind: o socket ainda não emite o evento close.
    socket.close();
    finish([{ address: '8.8.8.8', family: 4 }]);
    await new Promise((done) => setImmediate(done));
    expect(send).not.toHaveBeenCalled();
});

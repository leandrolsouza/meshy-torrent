import dgram from 'node:dgram';
import type { LookupFunction } from 'node:net';
import { createPublicLookup } from './torrentNetworkPolicy';

/** Apenas o tracker UDP usa este adaptador; DHT/LSD e o bind local são preservados. */
export function createTorrentUdpTransport(
    createSocket = dgram.createSocket,
    lookup: LookupFunction = createPublicLookup(),
) {
    return {
        createSocket(type: dgram.SocketType) {
            const socket = createSocket(type);
            const send = socket.send.bind(socket);
            const close = socket.close.bind(socket);
            let closed = false;
            socket.once('close', () => {
                closed = true;
            });
            Object.defineProperty(socket, 'close', {
                value(callback?: () => void) {
                    // close pode lançar antes do primeiro bind; ainda assim cancele o DNS pendente.
                    closed = true;
                    return close(callback);
                },
            });
            // O tracker usa exclusivamente a assinatura (msg, offset, length, port, host).
            Object.defineProperty(socket, 'send', {
                value(
                    message: Uint8Array,
                    offset: number,
                    length: number,
                    port: number,
                    host: string,
                ) {
                    if (closed) return;
                    lookup(host, { family: type === 'udp6' ? 6 : 4 }, (error, address) => {
                        if (closed) return;
                        if (error) {
                            socket.emit('error', error);
                            return;
                        }
                        try {
                            if (typeof address !== 'string') throw new Error('Resolução inválida');
                            send(message, offset, length, port, address);
                        } catch (sendError) {
                            socket.emit('error', sendError);
                        }
                    });
                },
            });
            return socket;
        },
    };
}

export default createTorrentUdpTransport();

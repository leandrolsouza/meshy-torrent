import dgram from 'node:dgram';
import type { LookupFunction } from 'node:net';
import { createPublicLookup, blockedNetworkDestination } from './torrentNetworkPolicy';

/** Apenas o tracker UDP usa este adaptador; DHT/LSD e o bind local são preservados. */
export function createTorrentUdpTransport(
    createSocket = dgram.createSocket,
    lookup: LookupFunction = createPublicLookup(),
) {
    return {
        createSocket(type: dgram.SocketType) {
            const socket = createSocket(type);
            const send = socket.send.bind(socket) as (...args: unknown[]) => void;
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
            // Após o bind, Node reenvia a fila com (msg[], port, host, callback).
            // Validar ambas as formas também impede que esse reenvio contorne a política.
            Object.defineProperty(socket, 'send', {
                value(message: unknown, ...args: unknown[]) {
                    if (closed) return;
                    const hasOffset = typeof args[1] === 'number';
                    const port = args[hasOffset ? 2 : 0];
                    const host = args[hasOffset ? 3 : 1];
                    const last = args[args.length - 1];
                    const callback = typeof last === 'function' ? last : undefined;
                    const fail = (error: unknown): void => {
                        if (callback) callback(error, 0);
                        else socket.emit('error', error);
                    };
                    if (typeof host !== 'string' || !host) {
                        queueMicrotask(() => {
                            if (!closed) fail(blockedNetworkDestination());
                        });
                        return;
                    }
                    lookup(host, { family: type === 'udp6' ? 6 : 4 }, (error, address) => {
                        if (closed) return;
                        if (error) {
                            fail(error);
                            return;
                        }
                        try {
                            if (typeof address !== 'string') throw new Error('Resolução inválida');
                            send(
                                message,
                                ...(hasOffset ? args.slice(0, 2) : []),
                                port,
                                address,
                                ...(callback ? [callback] : []),
                            );
                        } catch (sendError) {
                            fail(sendError);
                        }
                    });
                },
            });
            return socket;
        },
    };
}

export default createTorrentUdpTransport();

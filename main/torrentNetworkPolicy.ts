import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { isPublicIpAddress, isValidTrackerUrl } from '../shared/validators';

export function blockedNetworkDestination(): NodeJS.ErrnoException {
    return Object.assign(new Error('Destino de rede não permitido'), {
        code: 'ERR_NETWORK_DESTINATION_BLOCKED',
    });
}

/** Valida a resposta entregue ao socket, sem uma segunda resolução após a checagem. */
export function createPublicLookup(
    resolveAll: (hostname: string) => Promise<LookupAddress[]> = (hostname) =>
        lookup(hostname, { all: true, verbatim: true }),
): LookupFunction {
    return (hostname, options, callback) => {
        if (typeof hostname !== 'string' || !hostname) {
            queueMicrotask(() => callback(blockedNetworkDestination(), ''));
            return;
        }
        const host = hostname.replace(/^\[|\]$/g, '');
        const literalFamily = isIP(host);
        const urlHost = literalFamily === 6 ? `[${host}]` : host;
        if (!isValidTrackerUrl(`http://${urlHost}`)) {
            queueMicrotask(() => callback(blockedNetworkDestination(), ''));
            return;
        }
        const resolved = literalFamily
            ? Promise.resolve([{ address: host, family: literalFamily }])
            : Promise.resolve().then(() => resolveAll(host));
        void resolved.then(
            (addresses) => {
                // Uma resposta mista também falha: nenhum fallback pode escolher IP privado.
                if (
                    !addresses.length ||
                    addresses.some(({ address }) => !isPublicIpAddress(address))
                ) {
                    callback(blockedNetworkDestination(), '');
                    return;
                }
                const family =
                    options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
                const matching = addresses.filter(
                    (address) => !family || address.family === family,
                );
                const first = matching[0];
                if (!first) callback(blockedNetworkDestination(), '');
                else if (options.all) callback(null, matching);
                else callback(null, first.address, first.family);
            },
            () => callback(blockedNetworkDestination(), ''),
        );
    };
}

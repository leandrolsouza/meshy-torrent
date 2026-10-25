import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import nodeFetch, { Headers } from 'node-fetch';
import type { RequestInit } from 'node-fetch';
import type { Readable } from 'node:stream';
import { MAX_TORRENT_BYTES, isValidTrackerUrl } from '../shared/validators';
import { blockedNetworkDestination, createPublicLookup } from './torrentNetworkPolicy';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** Transporte exclusivo de trackers HTTP, xs e web seeds; não altera o fetch global. */
export function createTorrentFetch(request: typeof nodeFetch = nodeFetch) {
    const lookup = createPublicLookup();
    const http = new HttpAgent({ keepAlive: false, lookup });
    const https = new HttpsAgent({ keepAlive: false, lookup });
    return async (input: string | URL, options: RequestInit = {}) => {
        let url = new URL(input);
        const method = (options.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') throw blockedNetworkDestination();
        const headers = new Headers(options.headers);
        for (let redirects = 0; ; redirects++) {
            if (!['http:', 'https:'].includes(url.protocol) || !isValidTrackerUrl(url.href))
                throw blockedNetworkDestination();
            // Não aceite agents/dispatchers/hostname alternativos vindos da biblioteca.
            const response = await request(url.href, {
                method,
                headers,
                signal: options.signal ?? null,
                agent: url.protocol === 'https:' ? https : http,
                redirect: 'manual',
                size: MAX_TORRENT_BYTES,
            });
            if (!REDIRECT_STATUSES.has(response.status)) return response;
            const location = response.headers.get('location');
            (response.body as Readable | null)?.destroy();
            if (!location || redirects >= MAX_REDIRECTS) throw blockedNetworkDestination();
            const next = new URL(location, url);
            if (url.protocol === 'https:' && next.protocol !== 'https:')
                throw blockedNetworkDestination();
            if (next.origin !== url.origin) {
                for (const name of ['authorization', 'proxy-authorization', 'cookie', 'host'])
                    headers.delete(name);
            }
            url = next;
        }
    };
}

export default createTorrentFetch();

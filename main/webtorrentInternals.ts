// ─── Abstração de propriedades internas do WebTorrent ─────────────────────────
//
// O WebTorrent 2.x expõe propriedades internas não tipadas (announce, discovery,
// wires, _startDiscovery) que o Meshy Torrent precisa acessar. Este módulo centraliza todos
// os acessos inseguros com type guards, evitando casts `as unknown as { ... }`
// espalhados pelo código.
//
// Se uma atualização do WebTorrent quebrar essas propriedades, apenas este
// módulo precisa ser atualizado.

import type { Torrent } from 'webtorrent';
import type { TrackerStatus } from '../shared/types';

// ─── Tipos internos ──────────────────────────────────────────────────────────

/** Representação interna de um tracker no WebTorrent */
export interface InternalTracker {
    announceUrl?: string;
    destroyed?: boolean;
    destroy?: (callback: (err?: Error | null) => void) => void;
}

interface Discovery {
    destroyed?: boolean;
    tracker?: {
        _trackers: InternalTracker[];
        destroy(callback: (err?: Error | null) => void): void;
    } | null;
    _announce: string[];
    _createTracker(): NonNullable<Discovery['tracker']>;
    destroy(callback: (err?: Error | null) => void): void;
}

export const MAX_TRACKERS_PER_TORRENT = 20;
const configured = new WeakSet<Torrent>();
const stopping = new WeakMap<Torrent, Promise<void>>();
const trackerUpdates = new WeakSet<Torrent>();
const trackerStatuses = new WeakMap<InternalTracker, TrackerStatus>();
const watchedTrackers = new WeakSet<object>();
const scheduledBudgets = new WeakSet<NetworkBudget>();
const watchedConnections = new WeakSet<object>();

export interface NetworkBudget {
    maxPerTorrent: number;
    maxTotal: number;
    torrents(): Torrent[];
}

function connectionCount(torrent: Torrent, limit: number): number {
    const peers = asRecord(torrent)._peers;
    if (!(peers instanceof Map)) return 0;
    let count = 0;
    for (const peer of peers.values()) {
        if (!peer.destroyed && (peer.conn || peer.connected) && ++count >= limit) break;
    }
    return count;
}

function hasConnectionSlot(torrent: Torrent, budget: NetworkBudget): boolean {
    if (connectionCount(torrent, budget.maxPerTorrent) >= budget.maxPerTorrent) return false;
    let total = 0;
    for (const item of budget.torrents()) {
        total += connectionCount(item, budget.maxTotal - total);
        if (total >= budget.maxTotal) return false;
    }
    return true;
}

function scheduleDrain(budget: NetworkBudget): void {
    if (scheduledBudgets.has(budget)) return;
    scheduledBudgets.add(budget);
    queueMicrotask(() => {
        scheduledBudgets.delete(budget);
        for (const torrent of budget.torrents()) {
            const t = asRecord(torrent);
            if (!t.destroyed && !t.paused && typeof t._drain === 'function') t._drain.call(torrent);
        }
    });
}

function watchConnection(conn: unknown, budget: NetworkBudget): void {
    if (!conn || typeof conn !== 'object' || watchedConnections.has(conn)) return;
    const socket = conn as { once?: (event: string, fn: () => void) => void };
    if (!socket.once) return;
    watchedConnections.add(conn);
    socket.once('close', () => scheduleDrain(budget));
}

export function getInternalTrackerStatus(tracker: InternalTracker): TrackerStatus {
    return tracker.destroyed ? 'error' : (trackerStatuses.get(tracker) ?? 'pending');
}

function watchTrackerStatus(torrent: Torrent): void {
    const discovery = asRecord(torrent).discovery as Discovery | undefined;
    const client = discovery?.tracker as
        | (NonNullable<Discovery['tracker']> & {
            on?: (
                event: string,
                listener: (value: { announce?: string } | Error) => void,
            ) => void;
        })
        | undefined;
    if (!client?.on || watchedTrackers.has(client)) return;
    watchedTrackers.add(client);
    client.on('update', (value) => {
        const url = (value as { announce?: string }).announce;
        const tracker = client._trackers.find((item) => item.announceUrl === url);
        if (tracker) trackerStatuses.set(tracker, 'connected');
    });
    client.on('warning', (value) => {
        for (const tracker of client._trackers) {
            if (tracker.announceUrl && String(value).includes(tracker.announceUrl))
                trackerStatuses.set(tracker, 'error');
        }
    });
}

/** Guard discovery before metadata is available, including torrents born paused. */
export function configureTorrentNetwork(torrent: Torrent, budget?: NetworkBudget): void {
    if (configured.has(torrent)) return;
    configured.add(torrent);
    const t = asRecord(torrent);
    if (budget) {
        const drain = t._drain;
        if (typeof drain === 'function') {
            t._drain = function () {
                if (!hasConnectionSlot(torrent, budget)) return;
                const queue = t._queue as Array<{ conn?: unknown }> | undefined;
                const peer = queue?.[0];
                const result = drain.call(torrent);
                watchConnection(peer?.conn, budget);
                return result;
            };
        }
        const register = t._registerPeer;
        if (typeof register === 'function') {
            t._registerPeer = function (peer: {
                conn?: unknown;
                connected?: boolean;
                once(event: string, fn: () => void): void;
                destroy(err?: Error): void;
            }) {
                // Incoming and WebRTC peers already own a connection at registration.
                if ((peer.conn || peer.connected) && !hasConnectionSlot(torrent, budget)) {
                    peer.destroy(new Error('Limite de conexões atingido'));
                    return;
                }
                peer.once('disconnect', () => scheduleDrain(budget));
                watchConnection(peer.conn, budget);
                return register.call(torrent, peer);
            };
        }
    }
    // WebTorrent chama discovery.complete() em _checkDone sem verificar se
    // discovery existe. Torrents completos carregados pausados ainda não têm
    // discovery; a conclusão será reconciliada depois de retomar a rede.
    const checkDone = t._checkDone;
    if (typeof checkDone === 'function') {
        t._checkDone = function (...args: unknown[]) {
            if (t.paused && !t.discovery) return;
            return checkDone.apply(torrent, args);
        };
    }
    for (const method of ['_startDiscovery', '_getMetadataFromServer', 'addWebSeed']) {
        const original = t[method];
        if (typeof original !== 'function') continue;
        t[method] = function (...args: unknown[]) {
            if (t.paused || t.destroyed) return;
            if (method === '_startDiscovery') {
                setAnnounceList(
                    torrent,
                    [...new Set(getAnnounceList(torrent).map(normalizeUrl))].slice(
                        0,
                        MAX_TRACKERS_PER_TORRENT,
                    ),
                );
            }
            const result = original.apply(torrent, args);
            if (method === '_startDiscovery') watchTrackerStatus(torrent);
            return result;
        };
    }
}

function normalizeUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

/** Stop future announces, pending sockets and connected wires without deleting data. */
export function stopTorrentNetwork(torrent: Torrent): Promise<void> {
    const pending = stopping.get(torrent);
    if (pending) return pending;
    configureTorrentNetwork(torrent);
    torrent.pause();
    const t = asRecord(torrent);
    const peers = t._peers;
    if (peers instanceof Map) {
        for (const peer of [...peers.values()]) peer.destroy();
    }
    // Peer.destroy removes the map entry but leaves outgoing queue entries behind.
    if (Array.isArray(t._queue)) t._queue.length = 0;
    destroyAllWires(torrent);
    clearInterval(t._noPeersIntervalId as ReturnType<typeof setInterval>);
    (t._xsRequestsController as AbortController | undefined)?.abort();
    const discovery = t.discovery as Discovery | undefined;
    const result = new Promise<void>((resolve, reject) => {
        if (!discovery || discovery.destroyed) return resolve();
        discovery.destroy((err) => {
            if (t.discovery === discovery) t.discovery = null;
            if (err) reject(err);
            else resolve();
        });
    });
    stopping.set(torrent, result);
    result.finally(() => stopping.delete(torrent)).catch(() => { });
    return result;
}

export async function resumeTorrentNetwork(torrent: Torrent): Promise<void> {
    await stopping.get(torrent);
    const t = asRecord(torrent);
    torrent.resume();
    if (typeof t._startDiscovery === 'function') t._startDiscovery.call(torrent);
    if (typeof t._checkDone === 'function') t._checkDone.call(torrent);
    if (!t.metadata && t.xs && typeof t._getMetadataFromServer === 'function') {
        t._getMetadataFromServer.call(torrent);
    }
    if (Array.isArray(t.urlList) && typeof t.addWebSeed === 'function') {
        for (const url of t.urlList) t.addWebSeed.call(torrent, url);
    }
}

/** Wire com extensão ut_pex */
export interface WireWithPex {
    destroy(): void;
    ut_pex?: {
        destroy?: () => void;
    };
}

/** Wire com propriedades de peer para mapeamento de PeerInfo */
export interface WireWithPeerInfo {
    remoteAddress?: string;
    remotePort?: number;
    peerExtendedHandshake?: { v?: Buffer | Uint8Array };
    downloadSpeed?: () => number;
    peerPieces?: { get(index: number): boolean; buffer?: Uint8Array };
}

// ─── Helper para cast seguro ──────────────────────────────────────────────────

/**
 * Cast de Torrent para Record<string, unknown> via `unknown`.
 * Necessário porque o @types/webtorrent não declara index signature,
 * e o tsconfig.jest.json é mais restritivo que o tsconfig.node.json.
 */
function asRecord(torrent: Torrent): Record<string, unknown> {
    return torrent as unknown as Record<string, unknown>;
}

// ─── Announce (lista de tracker URLs) ─────────────────────────────────────────

/**
 * Retorna a lista de tracker URLs (announce) de um torrent.
 * Retorna array vazio se a propriedade não existir.
 */
export function getAnnounceList(torrent: Torrent): string[] {
    const t = asRecord(torrent);
    if (Array.isArray(t.announce)) {
        return t.announce as string[];
    }
    return [];
}

/**
 * Define a lista de tracker URLs (announce) de um torrent.
 */
export function setAnnounceList(torrent: Torrent, urls: string[]): void {
    asRecord(torrent).announce = urls;
}

// ─── discovery.tracker._trackers (array interno de conexões) ──────────────────

/**
 * Indexa por URL o array de trackers da descoberta do torrent.
 * Retorna objeto vazio se a propriedade não existir.
 */
export function getInternalTrackers(torrent: Torrent): Record<string, InternalTracker> {
    const t = asRecord(torrent);
    const trackers = (t.discovery as Discovery | undefined)?.tracker?._trackers ?? [];
    return Object.fromEntries(
        trackers
            .filter((tracker) => tracker.announceUrl)
            .map((tracker) => [tracker.announceUrl!, tracker]),
    );
}

/**
 * Remove um tracker do mapa interno e destrói a conexão.
 * Retorna true se o tracker foi encontrado e removido.
 */
export function destroyInternalTracker(
    torrent: Torrent,
    normalizedUrl: string,
    matchFn: (existingUrl: string) => string,
): boolean {
    const discovery = asRecord(torrent).discovery as Discovery | undefined;
    const trackers = discovery?.tracker?._trackers;
    const index =
        trackers?.findIndex((tracker) => matchFn(tracker.announceUrl ?? '') === normalizedUrl) ??
        -1;
    if (trackers && index >= 0) {
        const [tracker] = trackers.splice(index, 1);
        if (!tracker) return false;
        tracker.destroy?.(() => { });
        if (discovery) discovery._announce = [...getAnnounceList(torrent)];
        return true;
    }
    return false;
}

// ─── Atualização do cliente de trackers ──────────────────────────────────────

/**
 * Atualiza announce e recria o cliente de trackers uma vez por lote.
 * Torrents pausados só aplicam a lista ao retomar a descoberta.
 */
export function addTrackerToTorrent(torrent: Torrent, url: string): boolean {
    const announce = getAnnounceList(torrent);
    if (announce.length >= MAX_TRACKERS_PER_TORRENT) {
        throw new Error(`Limite de ${MAX_TRACKERS_PER_TORRENT} trackers por torrent atingido`);
    }
    announce.push(url);
    setAnnounceList(torrent, announce);
    // Batch favorites applied in the same tick into one tracker client update.
    if (!trackerUpdates.has(torrent)) {
        trackerUpdates.add(torrent);
        queueMicrotask(() => {
            trackerUpdates.delete(torrent);
            const t = asRecord(torrent);
            const discovery = t.discovery as Discovery | undefined;
            if (t.paused || t.destroyed || !discovery || discovery.destroyed || !discovery.tracker)
                return;
            discovery._announce = [...getAnnounceList(torrent)];
            try {
                const old = discovery.tracker;
                if (old) old.destroy(() => { });
                discovery.tracker = discovery._createTracker();
                watchTrackerStatus(torrent);
            } catch (err) {
                torrent.emit('warning', err);
            }
        });
    }
    return true;
}

// ─── Wires (conexões de peers) ────────────────────────────────────────────────

/**
 * Retorna a lista de wires (conexões de peers) de um torrent.
 * Retorna array vazio se a propriedade não existir.
 */
export function getWires(torrent: Torrent): WireWithPex[] {
    const t = asRecord(torrent);
    if (Array.isArray(t.wires)) {
        return t.wires as WireWithPex[];
    }
    return [];
}

/**
 * Destrói todos os wires de um torrent (usado para pausar efetivamente).
 * Retorna o número de wires destruídos.
 */
export function destroyAllWires(torrent: Torrent): number {
    const wires = getWires(torrent);
    // Copia o array para evitar problemas de mutação durante iteração
    const wiresCopy = [...wires];
    for (const wire of wiresCopy) {
        wire.destroy();
    }
    return wiresCopy.length;
}

// ─── Bitfield (progresso de peças) ────────────────────────────────────────────

/** Interface para o bitfield do torrent */
export interface TorrentBitfield {
    get(index: number): boolean;
}

/**
 * Retorna o bitfield do torrent (mapa de peças completas/pendentes).
 * Retorna null se a propriedade não existir.
 */
export function getBitfield(torrent: Torrent): TorrentBitfield | null {
    const t = asRecord(torrent);
    if (t.bitfield && typeof (t.bitfield as TorrentBitfield).get === 'function') {
        return t.bitfield as TorrentBitfield;
    }
    return null;
}

/**
 * Retorna o número total de peças do torrent.
 * Retorna 0 se a propriedade não existir.
 */
export function getPiecesCount(torrent: Torrent): number {
    const t = asRecord(torrent);
    if (Array.isArray(t.pieces)) {
        return (t.pieces as unknown[]).length;
    }
    return 0;
}

/**
 * Retorna os metadados de criação do torrent (created.by, comment, created.date).
 */
export function getTorrentCreatedInfo(torrent: Torrent): {
    createdBy: string | undefined;
    comment: string | undefined;
    creationDate: string | number | Date | undefined;
} {
    const t = asRecord(torrent);
    const created = t.created as { by?: string; date?: string | number | Date } | undefined;
    return {
        createdBy: created?.by ?? (t.createdBy as string | undefined),
        comment: t.comment as string | undefined,
        creationDate: created?.date ?? (t.creationDate as string | number | Date | undefined),
    };
}

/**
 * Retorna os wires com informações de peer (remoteAddress, remotePort, etc.).
 */
export function getWiresWithPeerInfo(torrent: Torrent): WireWithPeerInfo[] {
    const t = asRecord(torrent);
    if (Array.isArray(t.wires)) {
        return t.wires as WireWithPeerInfo[];
    }
    return [];
}

// ─── numSeeders ───────────────────────────────────────────────────────────────

/**
 * Retorna o número de seeders de um torrent.
 * A propriedade não é tipada no @types/webtorrent.
 */
export function getNumSeeders(torrent: Torrent): number {
    const t = asRecord(torrent);
    if (typeof t.numSeeders === 'number') {
        return t.numSeeders;
    }
    return 0;
}

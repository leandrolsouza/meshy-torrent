import { readTorrentFile } from './torrentInput';
import WebTorrent from 'webtorrent';
import type { Torrent, TorrentOptions } from 'webtorrent';
import type { AppSettings, TorrentPreview, TorrentSource } from '../shared/types';
import { ErrorCodes } from '../shared/errorCodes';
import {
    hasTorrentMagicBytes,
    normalizeMagnetUri,
    isValidTorrentFile,
    MAX_TORRENT_BYTES,
} from './validators';
import { configureTorrentNetwork } from './webtorrentInternals';
import { performance } from 'node:perf_hooks';
import { metrics } from './metrics';
import type { MetadataOutcome } from './metrics';

const PREVIEW_TTL_MS = 10 * 60_000;
const CLEANUP_TIMEOUT_MS = 5_000;

/** A preparação nunca abre arquivos no disco nem armazena conteúdo de peças. */
export class MetadataOnlyStore {
    get(_index: number, options: unknown, callback?: (error: Error) => void): void {
        const cb = typeof options === 'function' ? (options as (error: Error) => void) : callback;
        queueMicrotask(() => cb?.(new Error('Peça ausente')));
    }
    put(_index: number, _data: Uint8Array, callback: (error: Error) => void): void {
        queueMicrotask(() => callback(new Error('Preparação não transfere conteúdo')));
    }
    close(callback: () => void): void {
        queueMicrotask(callback);
    }
    destroy(callback: () => void): void {
        queueMicrotask(callback);
    }
}

export interface PreparedTorrent {
    preview: TorrentPreview;
    buffer: Buffer;
    magnetUri: string;
}

export interface TorrentPreparation {
    prepare(requestId: string, source: TorrentSource): Promise<TorrentPreview>;
    get(requestId: string): PreparedTorrent;
    cancel(requestId: string): void;
    dispose(): void;
}

export function createTorrentPreparation(
    options: {
        createClient?: () => WebTorrent;
        metadataTimeoutMs?: number;
        cleanupTimeoutMs?: number;
        getNetworkOptions?: () => Pick<AppSettings, 'dhtEnabled' | 'pexEnabled' | 'utpEnabled'>;
        telemetry?: Pick<typeof metrics, 'recordMetadataPreparation'>;
        clock?: () => number;
    } = {},
): TorrentPreparation {
    const drafts = new Map<string, PreparedTorrent>();
    const pending = new Map<string, () => void>();
    const expiry = new Map<string, ReturnType<typeof setTimeout>>();
    const telemetry = options.telemetry ?? metrics;
    const clock = options.clock ?? (() => performance.now());
    const createClient =
        options.createClient ??
        (() => {
            const network = options.getNetworkOptions?.();
            const networkOptions = {
                dht: network?.dhtEnabled ?? true,
                utp: network?.utpEnabled ?? true,
                utPex: network?.pexEnabled ?? true,
                maxConns: 12,
                seedOutgoingConnections: false,
                webSeeds: false,
            };
            const client = new WebTorrent(networkOptions);
            client.utPex = networkOptions.utPex;
            return client;
        });

    const cancel = (requestId: string): void => {
        pending.get(requestId)?.();
        drafts.delete(requestId);
        clearTimeout(expiry.get(requestId));
        expiry.delete(requestId);
    };

    return {
        async prepare(requestId, source) {
            if (
                pending.has(requestId) ||
                drafts.has(requestId) ||
                pending.size + drafts.size >= 4
            ) {
                throw new Error(ErrorCodes.INVALID_PARAMS);
            }
            let cancelled = false;
            const startedAt = clock();
            let outcome: MetadataOutcome = 'failed';
            pending.set(requestId, () => {
                cancelled = true;
            });
            try {
                let input: string | Buffer;
                if (source.kind === 'magnet') {
                    const magnet = normalizeMagnetUri(source.magnetUri);
                    if (!magnet) throw new Error(ErrorCodes.INVALID_MAGNET_URI);
                    input = magnet.uri;
                } else {
                    if (source.kind === 'file') {
                        if (!isValidTorrentFile(source.filePath)) {
                            throw new Error(ErrorCodes.INVALID_FILE_PATH);
                        }
                        input = await readTorrentFile(source.filePath);
                    } else {
                        if (source.buffer.byteLength > MAX_TORRENT_BYTES)
                            throw new Error(ErrorCodes.INVALID_FILE_PATH);
                        input = Buffer.from(source.buffer);
                    }
                    if (input.length > MAX_TORRENT_BYTES || !hasTorrentMagicBytes(input)) {
                        throw new Error(ErrorCodes.INVALID_FILE_PATH);
                    }
                }
                if (cancelled) throw new Error(ErrorCodes.PREPARATION_CANCELLED);
                const client = createClient();
                const prepared = await new Promise<PreparedTorrent>((resolve, reject) => {
                    let settled = false;
                    let torrent: Torrent;
                    const finish = (error?: Error, value?: PreparedTorrent): void => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        let completed = false;
                        const complete = (cleanupError?: Error): void => {
                            if (completed) return;
                            completed = true;
                            clearTimeout(cleanupTimer);
                            const failure = cancelled
                                ? new Error(ErrorCodes.PREPARATION_CANCELLED)
                                : (error ?? cleanupError);
                            if (failure) reject(failure);
                            else if (value) resolve(value);
                        };
                        // O callback de destroy pode nunca retornar. Nesse caso,
                        // falhar e liberar a vaga, sem publicar metadados como sucesso.
                        const cleanupTimer = setTimeout(
                            () =>
                                complete(
                                    Object.assign(new Error(ErrorCodes.OPERATION_FAILED), {
                                        code: 'ERR_REQUEST_TIMEOUT',
                                    }),
                                ),
                            options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
                        );
                        try {
                            client.destroy(complete);
                        } catch (cleanupError) {
                            complete(
                                cleanupError instanceof Error
                                    ? cleanupError
                                    : new Error(String(cleanupError)),
                            );
                        }
                    };
                    const timer = setTimeout(
                        () => finish(new Error(ErrorCodes.METADATA_TIMEOUT)),
                        options.metadataTimeoutMs ?? 60_000,
                    );
                    pending.set(requestId, () => {
                        cancelled = true;
                        finish(new Error(ErrorCodes.PREPARATION_CANCELLED));
                    });
                    client.on('error', (error) =>
                        finish(error instanceof Error ? error : new Error(String(error))),
                    );
                    const metadataReady = (): void => {
                        if (settled) return;
                        if (
                            !torrent.torrentFile ||
                            torrent.torrentFile.length > MAX_TORRENT_BYTES
                        ) {
                            finish(new Error(ErrorCodes.INVALID_FILE_PATH));
                            return;
                        }
                        finish(undefined, {
                            buffer: Buffer.from(torrent.torrentFile),
                            magnetUri: torrent.magnetURI,
                            preview: {
                                requestId,
                                infoHash: torrent.infoHash,
                                name: torrent.name,
                                files: torrent.files.map((file, index) => ({
                                    index,
                                    name: file.name,
                                    path: file.path,
                                    length: file.length,
                                    downloaded: 0,
                                    selected: true,
                                })),
                            },
                        });
                    };
                    try {
                        torrent = client.add(input, {
                            deselect: true,
                            store: MetadataOnlyStore as unknown as NonNullable<
                                TorrentOptions['store']
                            >,
                            storeCacheSlots: 0,
                            uploads: false,
                        });
                        configureTorrentNetwork(torrent);
                        torrent.once('metadata', metadataReady);
                        torrent.once('error', (error) =>
                            finish(error instanceof Error ? error : new Error(String(error))),
                        );
                        torrent.once('close', () => {
                            if (!settled) finish(new Error(ErrorCodes.PREPARATION_CANCELLED));
                        });
                        if (torrent.metadata) metadataReady();
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                });
                if (cancelled) throw new Error(ErrorCodes.PREPARATION_CANCELLED);
                drafts.set(requestId, prepared);
                const timer = setTimeout(() => cancel(requestId), PREVIEW_TTL_MS);
                timer.unref?.();
                expiry.set(requestId, timer);
                outcome = 'resolved';
                return prepared.preview;
            } catch (error) {
                if (cancelled) outcome = 'cancelled';
                throw error;
            } finally {
                pending.delete(requestId);
                if (['magnet', 'file', 'buffer'].includes(source?.kind))
                    telemetry.recordMetadataPreparation(
                        source.kind,
                        outcome,
                        Math.max(0, clock() - startedAt),
                    );
            }
        },
        get(requestId) {
            const prepared = drafts.get(requestId);
            if (!prepared) throw new Error(ErrorCodes.PREPARATION_EXPIRED);
            return prepared;
        },
        cancel,
        dispose() {
            for (const requestId of new Set([...pending.keys(), ...drafts.keys()]))
                cancel(requestId);
        },
    };
}

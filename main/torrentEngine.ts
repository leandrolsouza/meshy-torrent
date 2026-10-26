import { EventEmitter } from 'events';
import { rm, readdir } from 'fs/promises';
import { readTorrentFile } from './torrentInput';
import { join, basename } from 'path';
import WebTorrent, { type TorrentOptions } from 'webtorrent';
import type { Torrent } from 'webtorrent';
import { isValidMagnetUri, hasTorrentMagicBytes, MAX_TORRENT_BYTES } from './validators';
import { ErrorCodes } from '../shared/errorCodes';
import { isValidTrackerUrl, normalizeTrackerUrl } from '../shared/validators';
import { logger } from './logger';
import { getOperationContext, runWithOperationContext } from './operationContext';
import type { OperationContext } from './operationContext';
import { traceOperation } from './tracing';
import { metrics } from './metrics';
import type { TransferMetrics } from './metrics';
import type {
    TorrentStatus,
    TorrentFileInfo,
    TrackerInfo,
    TrackerStatus,
    TorrentMetadata,
    PeerInfo,
    PieceStatus,
} from '../shared/types';
import {
    getAnnounceList,
    setAnnounceList,
    getInternalTrackers,
    getInternalTrackerStatus,
    destroyInternalTracker,
    addTrackerToTorrent,
    configureTorrentNetwork,
    stopTorrentNetwork,
    resumeTorrentNetwork,
    getNumSeeders,
    getBitfield,
    getPiecesCount,
    getTorrentCreatedInfo,
    getWiresWithPeerInfo,
} from './webtorrentInternals';
import type { NetworkBudget } from './webtorrentInternals';

export type { TorrentStatus } from '../shared/types';
export type { TorrentFileInfo } from '../shared/types';
export type { TrackerInfo } from '../shared/types';

export interface TorrentEngineOptions {
    downloadPath: string;
    downloadSpeedLimit: number; // KB/s, 0 = sem limite
    uploadSpeedLimit: number; // KB/s, 0 = sem limite
    dhtEnabled: boolean; // DHT — Distributed Hash Table (padrão: true)
    pexEnabled: boolean; // PEX — Peer Exchange (padrão: true)
    utpEnabled: boolean; // uTP — Micro Transport Protocol (padrão: true)
}

export interface TorrentAddOptions {
    destinationFolder: string;
    selectedFileIndices?: number[];
    verifyExisting?: boolean;
}

export interface TorrentInfo {
    infoHash: string;
    name: string;
    totalSize: number; // bytes
    progress: number; // 0.0 – 1.0
    downloadSpeed: number; // bytes/s
    uploadSpeed: number; // bytes/s
    numPeers: number;
    numSeeders: number;
    timeRemaining: number; // ms, Infinity se desconhecido
    downloaded: number; // bytes
    status: TorrentStatus;
}

export interface TorrentEngine {
    addTorrentFile(
        filePath: string,
        paused?: boolean,
        options?: TorrentAddOptions,
    ): Promise<TorrentInfo>;
    addTorrentBuffer(
        buffer: Buffer,
        paused?: boolean,
        options?: TorrentAddOptions,
    ): Promise<TorrentInfo>;
    addMagnetLink(
        magnetUri: string,
        paused?: boolean,
        options?: TorrentAddOptions,
    ): Promise<TorrentInfo>;
    pause(infoHash: string): Promise<void>;
    resume(infoHash: string, seeding?: boolean): Promise<void>;
    remove(infoHash: string, deleteFiles: boolean): Promise<void>;
    detachTorrent(infoHash: string): Promise<void>;
    getTorrentFile(infoHash: string): Buffer | undefined;
    setDownloadSpeedLimit(kbps: number): void;
    setUploadSpeedLimit(kbps: number): void;
    getAll(): TorrentInfo[];
    /** Retorna a lista de arquivos de um torrent */
    getFiles(infoHash: string): TorrentFileInfo[];
    /** Aplica seleção de arquivos: seleciona os índices fornecidos, desseleciona os demais */
    setFileSelection(infoHash: string, selectedIndices: number[]): TorrentFileInfo[];
    /** Retorna a lista de trackers de um torrent com status de conexão */
    getTrackers(infoHash: string): TrackerInfo[];
    /** Adiciona um tracker a um torrent (valida URL e rejeita duplicatas) */
    addTracker(infoHash: string, trackerUrl: string): void;
    /** Remove um tracker de um torrent e encerra a conexão */
    removeTracker(infoHash: string, trackerUrl: string): void;
    /** Retorna metadados detalhados do torrent (creator, comment, creationDate) */
    getMetadata(infoHash: string): TorrentMetadata;
    /** Retorna a lista de peers conectados ao torrent */
    getPeers(infoHash: string): PeerInfo[];
    /** Retorna o status de cada peça do torrent (true = completa, false = pendente) */
    getPieces(infoHash: string): PieceStatus;
    /** Reinicia o motor com novas opções, re-adicionando torrents ativos */
    restart(options: TorrentEngineOptions): Promise<void>;
    /** Indica se o motor está em processo de reinício */
    isRestarting(): boolean;
    /** Verifica se o engine está saudável e responsivo */
    healthCheck(): EngineHealthStatus;
    on(event: 'progress', listener: (info: TorrentInfo) => void): void;
    on(event: 'done', listener: (infoHash: string) => void): void;
    on(event: 'error', listener: (infoHash: string, err: Error) => void): void;
    on(event: 'restarted', listener: () => void): void;
    on(event: 'restarting', listener: () => void): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    removeListener(event: string, listener: (...args: any[]) => void): void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Status de saúde do engine */
export interface EngineHealthStatus {
    healthy: boolean;
    restarting: boolean;
    activeTorrents: number;
    totalPeers: number;
    uptimeMs: number;
    error?: string;
}

const PAUSE_RESUME_TIMEOUT_MS = 5_000;

/** Timeout para o restart do engine (30 segundos) */
const RESTART_TIMEOUT_MS = 30_000;

// ─── Helper ───────────────────────────────────────────────────────────────────

function torrentToInfo(torrent: Torrent, status: TorrentStatus): TorrentInfo {
    return {
        infoHash: torrent.infoHash,
        name: torrent.name ?? torrent.infoHash,
        totalSize: torrent.length ?? 0,
        progress: torrent.progress ?? 0,
        downloadSpeed: torrent.downloadSpeed ?? 0,
        uploadSpeed: torrent.uploadSpeed ?? 0,
        numPeers: torrent.numPeers ?? 0,
        numSeeders: getNumSeeders(torrent),
        timeRemaining: torrent.timeRemaining ?? Infinity,
        downloaded: torrent.downloaded ?? 0,
        status,
    };
}

// ─── Implementation ───────────────────────────────────────────────────────────

class TorrentEngineImpl extends EventEmitter implements TorrentEngine {
    private readonly operationContexts = new WeakMap<Torrent, OperationContext>();
    private client: WebTorrent;
    private downloadPath: string;
    /** Tracks the current status for each infoHash */
    private readonly statusMap = new Map<string, TorrentStatus>();
    /** Tracks selected file indices per torrent */
    private readonly selectionMap = new Map<string, Set<number>>();
    private readonly pendingMagnets = new Map<string, Torrent>();
    private readonly warningTimes = new Map<string, number>();
    private clientClosed = false;
    private readonly networkBudget: NetworkBudget = {
        maxPerTorrent: 24,
        maxTotal: 96,
        torrents: () => this.client.torrents,
    };
    /** Armazena as opções para uso posterior (ex: restart) */
    private options: TorrentEngineOptions;
    /** Timestamp de criação do engine (para health check) */
    private readonly createdAt = Date.now();

    constructor(
        options: TorrentEngineOptions,
        client?: WebTorrent,
        private readonly transferMetrics: TransferMetrics = metrics,
    ) {
        super();
        // Evitar warnings de memory leak com muitos torrents.
        // Cada torrent registra listeners de progress, done, error, wire.
        this.setMaxListeners(0);
        this.downloadPath = options.downloadPath;
        this.options = options;

        this.client = client ?? this._createClient(options);
        this.client.utPex = options.pexEnabled;
        this._configureClient();
    }

    private _createClient(options: TorrentEngineOptions): WebTorrent {
        const networkOptions = {
            dht: options.dhtEnabled,
            utp: options.utpEnabled,
            utPex: options.pexEnabled,
            maxConns: 24,
            seedOutgoingConnections: true,
        };
        return new WebTorrent(networkOptions);
    }

    private _configureClient(): void {
        if (this.options.downloadSpeedLimit > 0)
            this.setDownloadSpeedLimit(this.options.downloadSpeedLimit);
        if (this.options.uploadSpeedLimit > 0)
            this.setUploadSpeedLimit(this.options.uploadSpeedLimit);
        this.client.on('error', (err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            const stack = error.stack?.split('\n').slice(0, 3).join(' | ') ?? '';
            logger.error(
                '[TorrentEngine] Erro global do cliente WebTorrent:',
                error.message,
                stack,
            );
            for (const torrent of this.client.torrents) {
                this._withTorrentContext(torrent, () =>
                    traceOperation('torrent.client.error', () =>
                        this.emit('error', torrent.infoHash, err),
                    ),
                );
            }
        });
    }

    // ── addTorrentFile ──────────────────────────────────────────────────────────

    async addTorrentFile(
        filePath: string,
        paused = false,
        options?: TorrentAddOptions,
    ): Promise<TorrentInfo> {
        logger.info('[TorrentEngine] Adicionando torrent via arquivo:', basename(filePath));
        // Leitura assíncrona para não bloquear o event loop com arquivos grandes
        let buffer: Buffer;
        try {
            buffer = await readTorrentFile(filePath);
        } catch (err) {
            if (err instanceof Error && err.message === ErrorCodes.INVALID_FILE_PATH) throw err;
            // Usar basename para evitar vazar o caminho completo no log/mensagem de erro
            const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
            logger.error('[TorrentEngine] Falha ao ler arquivo torrent:', basename(filePath), code);
            const wrapped = new Error(
                `Não foi possível ler o arquivo ${basename(filePath)}: ${code}`,
            );
            (wrapped as unknown as { cause: unknown }).cause = err;
            throw wrapped;
        }

        return this.addTorrentBuffer(buffer, paused, options);
    }

    // ── addTorrentBuffer ────────────────────────────────────────────────────────

    addTorrentBuffer(
        buffer: Buffer,
        paused = false,
        options?: TorrentAddOptions,
    ): Promise<TorrentInfo> {
        const origin = getOperationContext();
        if (buffer.length > MAX_TORRENT_BYTES)
            return Promise.reject(new Error(ErrorCodes.INVALID_FILE_PATH));
        if (!hasTorrentMagicBytes(buffer)) {
            return Promise.reject(new Error('Arquivo inválido: não é um arquivo .torrent válido'));
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            let torrent: Torrent;
            const finish = (err?: Error, ready?: Torrent): void =>
                runWithOperationContext(origin, () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    if (err) {
                        logger.error(
                            '[TorrentEngine] Falha ao adicionar torrent via buffer:',
                            err.message,
                        );
                        if (torrent && !(torrent as Torrent & { destroyed?: boolean }).destroyed)
                            torrent.destroy({ destroyStore: false }, () => {});
                        reject(err);
                    } else if (ready) {
                        const status = paused ? 'paused' : 'downloading';
                        this.statusMap.set(ready.infoHash, status);
                        logger.info(
                            '[TorrentEngine] Status:',
                            ready.infoHash.slice(0, 8),
                            '->',
                            status,
                        );
                        logger.info(
                            '[TorrentEngine] Torrent adicionado via buffer:',
                            ready.infoHash.slice(0, 8),
                        );
                        if (options?.selectedFileIndices)
                            this.selectionMap.set(
                                ready.infoHash,
                                new Set(options.selectedFileIndices),
                            );
                        this._initSelectionMap(ready);
                        resolve(torrentToInfo(ready, status));
                    }
                });
            const timer = setTimeout(
                () =>
                    finish(
                        Object.assign(new Error('Adição do torrent expirou'), {
                            code: 'ERR_REQUEST_TIMEOUT',
                        }),
                    ),
                options?.verifyExisting ? 30 * 60_000 : 20_000,
            );
            try {
                torrent = this.client.add(
                    buffer,
                    {
                        path: options?.destinationFolder ?? this.downloadPath,
                        paused,
                        deselect: options?.selectedFileIndices !== undefined,
                        skipVerify: false,
                    } as TorrentOptions,
                    (ready) => finish(undefined, ready),
                );
                configureTorrentNetwork(torrent, this.networkBudget);
                this._attachTorrentListeners(torrent);
                torrent.once('error', (err) =>
                    finish(err instanceof Error ? err : new Error(String(err))),
                );
                torrent.once('close', () => finish(new Error('Adição do torrent cancelada')));
            } catch (err) {
                finish(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    // client 'torrent' fires after metadata. Use the immediate return value instead.
    addMagnetLink(
        magnetUri: string,
        paused = false,
        options?: TorrentAddOptions,
    ): Promise<TorrentInfo> {
        if (!isValidMagnetUri(magnetUri)) {
            return Promise.reject(
                new Error('Formato inválido. Esperado: magnet:?xt=urn:btih:<40 hex chars>'),
            );
        }
        // noUncheckedIndexedAccess: isValidMagnetUri acima garante o padrão; grupo 1 sempre presente
        const hash = magnetUri.match(/xt=urn:btih:([a-fA-F0-9]{40})/i)![1]!.toLowerCase();
        if (this._getTorrent(hash)) return Promise.reject(new Error('Torrent já existe na lista'));
        logger.info('[TorrentEngine] Adicionando torrent via magnet:', hash.slice(0, 8));
        try {
            const torrent = this.client.add(magnetUri, {
                path: options?.destinationFolder ?? this.downloadPath,
                paused,
                deselect: options?.selectedFileIndices !== undefined,
            } as TorrentOptions);
            this.pendingMagnets.set(hash, torrent);
            if (options?.selectedFileIndices)
                this.selectionMap.set(hash, new Set(options.selectedFileIndices));
            torrent.once('close', () => {
                if (this.pendingMagnets.get(hash) === torrent) this.pendingMagnets.delete(hash);
            });
            configureTorrentNetwork(torrent, this.networkBudget);
            const initialStatus = paused ? 'paused' : 'resolving-metadata';
            this.statusMap.set(hash, initialStatus);
            logger.info('[TorrentEngine] Status:', hash.slice(0, 8), '->', initialStatus);
            this._attachTorrentListeners(torrent);
            const ready = (): void =>
                this._withTorrentContext(torrent, () =>
                    traceOperation('torrent.metadata.ready', () => {
                        if ((torrent as Torrent & { destroyed?: boolean }).destroyed) return;
                        const previous = this.statusMap.get(hash);
                        const newStatus =
                            previous === 'paused' ||
                            previous === 'completed' ||
                            previous === 'seeding'
                                ? previous
                                : 'downloading';
                        this.statusMap.set(hash, newStatus);
                        logger.info(
                            '[TorrentEngine] Status:',
                            hash.slice(0, 8),
                            '->',
                            newStatus,
                            '(metadados resolvidos)',
                        );
                        this._initSelectionMap(torrent);
                        this.emit('progress', {
                            ...torrentToInfo(torrent, this.statusMap.get(hash)!),
                            infoHash: hash,
                        });
                    }),
                );
            torrent.once('ready', ready);
            if (torrent.ready) ready();
            logger.info(
                '[TorrentEngine] Torrent via magnet registrado:',
                hash.slice(0, 8),
                `status=${this.statusMap.get(hash)}`,
            );
            return Promise.resolve({
                ...torrentToInfo(torrent, this.statusMap.get(hash)!),
                infoHash: hash,
            });
        } catch (err) {
            return Promise.reject(err);
        }
    }

    // ── pause ───────────────────────────────────────────────────────────────────

    async pause(infoHash: string): Promise<void> {
        const torrent = this._getTorrent(infoHash);
        if (torrent) this._rememberOperation(torrent);
        this.statusMap.set(infoHash, 'paused');
        logger.info('[TorrentEngine] Status:', infoHash.slice(0, 8), '-> paused');
        if (torrent) await this._stopNetwork(torrent);
    }

    private async _stopNetwork(torrent: Torrent): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                stopTorrentNetwork(torrent),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                Object.assign(new Error('Falha ao pausar: timeout'), {
                                    code: 'ERR_REQUEST_TIMEOUT',
                                }),
                            ),
                        PAUSE_RESUME_TIMEOUT_MS,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    async resume(infoHash: string, seeding = false): Promise<void> {
        const torrent = this._getTorrent(infoHash);
        if (torrent) this._rememberOperation(torrent);
        if (!torrent) throw new Error('Torrent não encontrado: ' + infoHash);
        if (seeding) {
            if (!torrent.ready) throw new Error(ErrorCodes.FILE_METADATA_UNAVAILABLE);
            if (
                this.getFiles(infoHash).some(
                    (file) => file.selected && file.downloaded < file.length,
                )
            )
                throw new Error(ErrorCodes.FILE_SOURCE_MISSING);
        }
        await resumeTorrentNetwork(torrent);
        const status =
            seeding || torrent.done
                ? 'seeding'
                : torrent.ready
                  ? 'downloading'
                  : 'resolving-metadata';
        this.statusMap.set(infoHash, status);
        logger.info('[TorrentEngine] Status:', infoHash.slice(0, 8), '->', status);
        this.emit('progress', torrentToInfo(torrent, status));
    }

    // ── remove ──────────────────────────────────────────────────────────────────

    async remove(infoHash: string, deleteFiles: boolean): Promise<void> {
        const torrent = this._getTorrent(infoHash);
        if (torrent) this._rememberOperation(torrent);
        if (!torrent) {
            // Already removed — treat as success
            this.statusMap.delete(infoHash);
            this.selectionMap.delete(infoHash);
            return;
        }

        // Capturar o nome do torrent antes de destruir para limpar a pasta depois
        const torrentName = torrent.name;
        const torrentPath = torrent.path;

        // Torrents concluídos já podem estar encerrando a descoberta de peers.
        // Aguarde esse cleanup antes de destroy(): o discovery do WebTorrent
        // ignora uma segunda chamada a destroy() sem invocar o callback, o que
        // deixaria a remoção pendurada.
        try {
            await stopTorrentNetwork(torrent);
        } catch (err) {
            logger.warn(
                '[TorrentEngine] Falha ao encerrar a rede antes de remover:',
                infoHash.slice(0, 8),
                err instanceof Error ? err.message : String(err),
            );
        }

        await new Promise<void>((resolve, reject) => {
            torrent.destroy({ destroyStore: deleteFiles }, (err) => {
                if (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
                this.statusMap.delete(infoHash);
                this.selectionMap.delete(infoHash);
                resolve();
            });
        });

        // Remover a pasta do torrent se ficou vazia após deletar os arquivos.
        // O WebTorrent só apaga os arquivos, não a pasta que os contém.
        if (deleteFiles && torrentName) {
            const torrentFolder = join(torrentPath, torrentName);
            try {
                const entries = await readdir(torrentFolder);
                if (entries.length === 0) await rm(torrentFolder, { recursive: true });
            } catch {
                // Pasta pode já não existir ou não ter permissão — ignorar
            }
        }
    }

    /** Fecha store e rede sem remover dados ou a pasta escolhida pelo usuário. */
    async detachTorrent(infoHash: string): Promise<void> {
        const torrent = this._getTorrent(infoHash);
        if (torrent) this._rememberOperation(torrent);
        if (torrent) {
            await new Promise<void>((resolve, reject) =>
                torrent.destroy({ destroyStore: false }, (error) =>
                    error ? reject(error) : resolve(),
                ),
            );
        }
        this.statusMap.delete(infoHash);
        this.selectionMap.delete(infoHash);
        this.pendingMagnets.delete(infoHash);
    }

    getTorrentFile(infoHash: string): Buffer | undefined {
        const metadata = this._getTorrent(infoHash)?.torrentFile;
        return metadata ? Buffer.from(metadata) : undefined;
    }

    // ── setDownloadSpeedLimit ───────────────────────────────────────────────────

    setDownloadSpeedLimit(kbps: number): void {
        // kbps === 0 means no limit; WebTorrent uses 0 to remove the limit as well
        this.client.throttleDownload(kbps === 0 ? -1 : kbps * 1024);
    }

    // ── setUploadSpeedLimit ─────────────────────────────────────────────────────

    setUploadSpeedLimit(kbps: number): void {
        this.client.throttleUpload(kbps === 0 ? -1 : kbps * 1024);
    }

    // ── getAll ──────────────────────────────────────────────────────────────────

    getAll(): TorrentInfo[] {
        return this.client.torrents.map((torrent) => {
            const status = this.statusMap.get(torrent.infoHash) ?? 'queued';
            return torrentToInfo(torrent, status);
        });
    }

    // ── EventEmitter overloads (type-safe) ──────────────────────────────────────

    on(event: 'progress', listener: (info: TorrentInfo) => void): this;
    on(event: 'done', listener: (infoHash: string) => void): this;
    on(event: 'error', listener: (infoHash: string, err: Error) => void): this;
    on(event: 'restarted', listener: () => void): this;
    on(event: 'restarting', listener: () => void): this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    // ── getFiles ────────────────────────────────────────────────────────────────

    getFiles(infoHash: string): TorrentFileInfo[] {
        const torrent = this._getTorrent(infoHash);
        if (!torrent) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        const selected = this.selectionMap.get(infoHash) ?? new Set<number>();

        const bitfield = getBitfield(torrent);
        return torrent.files.map((file, index) => {
            // file.downloaded do WebTorrent subconta a última peça quando o
            // tamanho é múltiplo exato de pieceLength. O bitfield é a evidência
            // de verificação, inclusive antes de _checkDone num torrent pausado.
            let verified = file.done || file.length === 0;
            if (!verified && bitfield && torrent.pieceLength > 0 && Number.isFinite(file.offset)) {
                verified = true;
                const first = Math.floor(file.offset / torrent.pieceLength);
                const last = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
                for (let piece = first; piece <= last; piece++) {
                    if (!bitfield.get(piece)) {
                        verified = false;
                        break;
                    }
                }
            }
            return {
                index,
                name: file.name,
                path: file.path,
                length: file.length,
                // Clamp: o WebTorrent pode retornar valores negativos ou acima do
                // tamanho real após falhas de verificação de peças ou desseleção
                // dinâmica de arquivos.
                downloaded: verified
                    ? file.length
                    : Math.max(0, Math.min(file.downloaded, file.length)),
                selected: selected.has(index),
            };
        });
    }

    // ── setFileSelection ────────────────────────────────────────────────────────

    setFileSelection(infoHash: string, selectedIndices: number[]): TorrentFileInfo[] {
        const torrent = this._getTorrent(infoHash);
        if (torrent) this._rememberOperation(torrent);
        if (!torrent) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        const selectedSet = new Set(selectedIndices);
        this.selectionMap.set(infoHash, selectedSet);

        for (let i = 0; i < torrent.files.length; i++) {
            const file = torrent.files[i];
            if (!file) continue;
            if (selectedSet.has(i)) {
                file.select();
            } else {
                file.deselect();
            }
        }

        return this.getFiles(infoHash);
    }

    // ── getTrackers ─────────────────────────────────────────────────────────────

    getTrackers(infoHash: string): TrackerInfo[] {
        const torrent = this._getTorrent(infoHash);
        if (!torrent) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        const announce = getAnnounceList(torrent);
        const internalTrackers = getInternalTrackers(torrent);

        return announce.map((url) => {
            const tracker = internalTrackers[url];
            let status: TrackerStatus = 'pending';

            if (tracker) status = getInternalTrackerStatus(tracker);

            return { url, status };
        });
    }

    // ── addTracker ──────────────────────────────────────────────────────────────

    addTracker(infoHash: string, trackerUrl: string): void {
        const torrent = this._getTorrent(infoHash);
        if (torrent) this._rememberOperation(torrent);
        if (!torrent) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        if (!isValidTrackerUrl(trackerUrl)) {
            throw new Error(
                'URL de tracker inválida. Protocolos aceitos: http://, https://, udp://',
            );
        }

        const normalized = normalizeTrackerUrl(trackerUrl);
        const announce = getAnnounceList(torrent);
        const alreadyExists = announce.some(
            (existing) => normalizeTrackerUrl(existing) === normalized,
        );

        if (alreadyExists) {
            throw new Error(`Tracker já presente: ${normalized}`);
        }

        addTrackerToTorrent(torrent, normalized);
    }

    // ── removeTracker ───────────────────────────────────────────────────────────

    removeTracker(infoHash: string, trackerUrl: string): void {
        const torrent = this._getTorrent(infoHash);
        if (torrent) this._rememberOperation(torrent);
        if (!torrent) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        const normalized = normalizeTrackerUrl(trackerUrl);
        const announce = getAnnounceList(torrent);
        const index = announce.findIndex(
            (existing) => normalizeTrackerUrl(existing) === normalized,
        );

        if (index === -1) {
            throw new Error(`Tracker não encontrado: ${normalized}`);
        }

        // Remove do array announce
        announce.splice(index, 1);
        setAnnounceList(torrent, announce);

        // Destrói a conexão com o tracker, se existir
        destroyInternalTracker(torrent, normalized, normalizeTrackerUrl);
    }

    // ── getMetadata ─────────────────────────────────────────────────────────────

    getMetadata(infoHash: string): TorrentMetadata {
        const torrent = this._getTorrent(infoHash);
        if (!torrent) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        const { createdBy, comment, creationDate } = getTorrentCreatedInfo(torrent);

        return {
            infoHash: torrent.infoHash,
            creator: createdBy ?? null,
            comment: comment ?? null,
            creationDate: creationDate ? new Date(creationDate).getTime() : null,
        };
    }

    // ── getPeers ────────────────────────────────────────────────────────────────

    getPeers(infoHash: string): PeerInfo[] {
        const torrent = this._getTorrent(infoHash);
        if (!torrent) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        const wires = getWiresWithPeerInfo(torrent);
        const totalPieces = getPiecesCount(torrent);

        return wires.map((wire) => {
            // Calcular progresso do peer a partir do peerPieces bitfield
            let progress = 0;
            if (wire.peerPieces && totalPieces > 0) {
                let completedCount = 0;
                for (let i = 0; i < totalPieces; i++) {
                    if (wire.peerPieces.get(i)) {
                        completedCount++;
                    }
                }
                progress = completedCount / totalPieces;
            }

            // Extrair nome do cliente do peer extended handshake
            let client = 'Desconhecido';
            if (wire.peerExtendedHandshake?.v) {
                const v = wire.peerExtendedHandshake.v;
                client = Buffer.from(v).toString('utf8') || 'Desconhecido';
            }

            return {
                address: `${wire.remoteAddress ?? '0.0.0.0'}:${wire.remotePort ?? 0}`,
                client,
                downloadSpeed: typeof wire.downloadSpeed === 'function' ? wire.downloadSpeed() : 0,
                progress,
            };
        });
    }

    // ── getPieces ───────────────────────────────────────────────────────────────

    getPieces(infoHash: string): PieceStatus {
        const torrent = this._getTorrent(infoHash);
        if (!torrent) {
            throw new Error(`Torrent não encontrado: ${infoHash}`);
        }

        const bitfield = getBitfield(torrent);
        const totalPieces = getPiecesCount(torrent);
        const result: boolean[] = new Array(totalPieces);

        for (let i = 0; i < totalPieces; i++) {
            result[i] = bitfield ? bitfield.get(i) : false;
        }

        return result;
    }

    // ── Private helpers ─────────────────────────────────────────────────────────

    /** Flag que indica se o motor está em processo de reinício */
    private _restarting = false;

    // ── isRestarting ────────────────────────────────────────────────────────────

    isRestarting(): boolean {
        return this._restarting;
    }

    // ── healthCheck ─────────────────────────────────────────────────────────────

    healthCheck(): EngineHealthStatus {
        try {
            const torrents = this.client.torrents;
            const activeTorrents = torrents.length;
            const totalPeers = torrents.reduce((sum, t) => sum + (t.numPeers ?? 0), 0);

            return {
                healthy: !this._restarting && !this.clientClosed,
                restarting: this._restarting,
                activeTorrents,
                totalPeers,
                uptimeMs: Date.now() - this.createdAt,
            };
        } catch (err) {
            return {
                healthy: false,
                restarting: this._restarting,
                activeTorrents: 0,
                totalPeers: 0,
                uptimeMs: Date.now() - this.createdAt,
                error: (err as Error).message,
            };
        }
    }

    // ── restart ─────────────────────────────────────────────────────────────────

    private restartPromise: Promise<void> | undefined = undefined;

    restart(options: TorrentEngineOptions): Promise<void> {
        if (this.restartPromise) return this.restartPromise;
        this._restarting = true;
        this.emit('restarting');
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const work = this._doRestart(options, () => cancelled);
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                cancelled = true;
                reject(
                    Object.assign(
                        new Error('Restart do engine expirou após ' + RESTART_TIMEOUT_MS + 'ms'),
                        { code: 'ERR_REQUEST_TIMEOUT' },
                    ),
                );
            }, RESTART_TIMEOUT_MS);
        });
        const result = Promise.race([work, timeout])
            .catch((err) => {
                cancelled = true;
                for (const torrent of this.client.torrents) {
                    if (!(torrent as Torrent & { destroyed?: boolean }).destroyed) {
                        void stopTorrentNetwork(torrent).catch((stopError) =>
                            logger.warn('[TorrentEngine] Falha ao suspender reinício:', stopError),
                        );
                    }
                }
                for (const [hash, status] of this.statusMap) {
                    if (
                        status === 'downloading' ||
                        status === 'resolving-metadata' ||
                        status === 'seeding'
                    ) {
                        this.statusMap.set(hash, 'error');
                        logger.info(
                            '[TorrentEngine] Status:',
                            hash.slice(0, 8),
                            '-> error (falha no restart)',
                        );
                        this.emit('error', hash, err);
                    }
                }
                throw err;
            })
            .finally(() => clearTimeout(timer));
        this.restartPromise = result;
        // On timeout retain ownership until cleanup actually finishes.
        work.catch(() => {}).finally(() => {
            this._restarting = false;
            this.restartPromise = undefined;
            if (!cancelled) this.emit('restarted');
        });
        return result;
    }

    private async _doRestart(
        options: TorrentEngineOptions,
        cancelled: () => boolean,
    ): Promise<void> {
        const previous = this.client;
        const saved = previous.torrents.map((t) => ({
            infoHash: t.infoHash,
            magnetURI: t.magnetURI,
            status: this.statusMap.get(t.infoHash),
            selection: this.selectionMap.get(t.infoHash),
            torrentFile: (t as Torrent & { torrentFile?: Uint8Array }).torrentFile,
            destinationFolder: t.path,
        }));
        // The client owns its torrents. Wait for every socket/store to close.
        if (!this.clientClosed) {
            await new Promise<void>((resolve, reject) =>
                previous.destroy((err) => (err ? reject(err) : resolve())),
            );
            this.clientClosed = true;
        }
        if (cancelled()) throw new Error('Reinício cancelado');
        this.downloadPath = options.downloadPath;
        this.options = options;
        this.pendingMagnets.clear();
        this.client = this._createClient(options);
        this.clientClosed = false;
        this._configureClient();
        for (const item of saved) {
            if (cancelled()) throw new Error('Reinício cancelado');
            if (item.status === 'completed' || item.status === 'error') continue;
            try {
                if ((item.status === 'paused' || item.status === 'seeding') && item.torrentFile) {
                    await this.addTorrentBuffer(Buffer.from(item.torrentFile), true, {
                        destinationFolder: item.destinationFolder,
                        ...(item.selection ? { selectedFileIndices: [...item.selection] } : {}),
                    });
                } else {
                    await this.addMagnetLink(
                        item.magnetURI,
                        item.status === 'paused' || item.status === 'seeding',
                        {
                            destinationFolder: item.destinationFolder,
                            ...(item.selection ? { selectedFileIndices: [...item.selection] } : {}),
                        },
                    );
                }
                if (item.selection) {
                    const torrent = this._getTorrent(item.infoHash);
                    torrent?.once('ready', () =>
                        this.setFileSelection(item.infoHash, [...item.selection!]),
                    );
                    if (torrent?.ready) this.setFileSelection(item.infoHash, [...item.selection]);
                }
            } catch (err) {
                this.statusMap.set(item.infoHash, 'error');
                this.emit(
                    'error',
                    item.infoHash,
                    new Error('Falha ao re-adicionar torrent: ' + String(err)),
                );
            }
        }
    }

    // ── _getTorrent ─────────────────────────────────────────────────────────────

    private _getTorrent(infoHash: string): Torrent | undefined {
        return (
            this.client.torrents.find((t) => t.infoHash === infoHash) ??
            this.pendingMagnets.get(infoHash)
        );
    }

    /** Initializes the selection map with all file indices (all selected by default) */
    private _initSelectionMap(torrent: Torrent): void {
        const previous = this.selectionMap.get(torrent.infoHash);
        if (previous) {
            this.setFileSelection(
                torrent.infoHash,
                [...previous].filter((index) => index < torrent.files.length),
            );
            return;
        }
        const allIndices = new Set<number>();
        for (let i = 0; i < torrent.files.length; i++) {
            allIndices.add(i);
        }
        this.selectionMap.set(torrent.infoHash, allIndices);
    }

    private _rememberOperation(torrent: Torrent): void {
        const context = getOperationContext();
        if (context) this.operationContexts.set(torrent, context);
    }

    private _withTorrentContext<T>(torrent: Torrent, callback: () => T): T {
        return runWithOperationContext(this.operationContexts.get(torrent), callback);
    }

    private _attachTorrentListeners(torrent: Torrent): void {
        this._rememberOperation(torrent);
        torrent.on('warning', (err) =>
            this._withTorrentContext(torrent, () => {
                const message = err instanceof Error ? err.message : String(err);
                const now = Date.now();
                if (now - (this.warningTimes.get(message) ?? -Infinity) < 60_000) return;
                if (this.warningTimes.size >= 256) this.warningTimes.clear();
                this.warningTimes.set(message, now);
                logger.warn(
                    '[TorrentEngine] Aviso de rede:',
                    torrent.infoHash.slice(0, 8),
                    message,
                );
            }),
        );
        torrent.on('download', (bytes: number) =>
            this._withTorrentContext(torrent, () => {
                this.transferMetrics.recordTransfer('download', bytes);
                const status = this.statusMap.get(torrent.infoHash) ?? 'downloading';
                this.emit('progress', torrentToInfo(torrent, status));
            }),
        );

        torrent.on('upload', (bytes: number) =>
            this._withTorrentContext(torrent, () => {
                this.transferMetrics.recordTransfer('upload', bytes);
                const status = this.statusMap.get(torrent.infoHash) ?? 'downloading';
                this.emit('progress', torrentToInfo(torrent, status));
            }),
        );

        torrent.on('done', () =>
            this._withTorrentContext(torrent, () =>
                traceOperation('torrent.event.done', () => {
                    this.statusMap.set(torrent.infoHash, 'seeding');
                    logger.info(
                        '[TorrentEngine] Status:',
                        torrent.infoHash.slice(0, 8),
                        '-> seeding',
                    );
                    this.emit('done', torrent.infoHash);
                }),
            ),
        );

        torrent.on('error', (err) =>
            this._withTorrentContext(torrent, () =>
                traceOperation('torrent.event.error', () => {
                    const active = this._getTorrent(torrent.infoHash);
                    // WebTorrent destroys a duplicate before emitting its error. Keep the
                    // original torrent's state intact; the addition promise handles rejection.
                    if (active && active !== torrent) return;
                    this.statusMap.set(torrent.infoHash, 'error');
                    logger.info(
                        '[TorrentEngine] Status:',
                        torrent.infoHash.slice(0, 8),
                        '-> error',
                    );
                    const error = err instanceof Error ? err : new Error(String(err));
                    const stack = error.stack?.split('\n').slice(0, 3).join(' | ') ?? '';
                    logger.error(
                        '[TorrentEngine] Erro de torrent:',
                        torrent.infoHash.slice(0, 8),
                        error.message,
                        stack,
                    );
                    this.emit('error', torrent.infoHash, error);
                    return { success: false };
                }),
            ),
        );
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a new TorrentEngine instance.
 *
 * @param options  Engine configuration (download path, speed limits).
 * @param webTorrentClient  Optional WebTorrent client for dependency injection
 *                          (useful in tests to avoid real network activity).
 */
export function createTorrentEngine(
    options: TorrentEngineOptions,
    webTorrentClient?: WebTorrent,
    transferMetrics?: TransferMetrics,
): TorrentEngine {
    return new TorrentEngineImpl(options, webTorrentClient, transferMetrics);
}

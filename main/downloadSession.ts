import type {
    DownloadItem,
    PersistedDownloadItem,
    TorrentFileInfo,
    TorrentMetadata,
    TorrentStatus,
} from '../shared/types';
import { MAX_TORRENT_BYTES, hasTorrentMagicBytes } from '../shared/validators';
import type { Logger } from './logger';
import { isSafeTorrentPath } from './torrentFiles';

/** Versão do formato de sessão persistido. */
export const DOWNLOADS_SCHEMA_VERSION = 1;

/** Interface mínima do armazenamento usada pela persistência da sessão. */
export interface PersistedStore {
    get(key: 'downloads'): PersistedDownloadItem[] | undefined;
    get(key: 'downloadsSchemaVersion'): number | undefined;
    set(key: 'downloads', value: PersistedDownloadItem[]): void;
    set(key: 'downloadsSchemaVersion', value: number): void;
}

export interface DownloadSessionRepository {
    read(): PersistedDownloadItem[];
    write(items: PersistedDownloadItem[], queueOrder: readonly string[]): void;
}

export type PersistedDownloadValidationReason =
    | 'info-hash'
    | 'status'
    | 'magnet-uri'
    | 'torrent-file-path'
    | 'metadata-encoding'
    | 'metadata-content';

export type PersistedDownloadValidation =
    | {
          valid: true;
          metadata?: Buffer;
          files?: TorrentFileInfo[];
      }
    | { valid: false; reason: PersistedDownloadValidationReason };

const VALID_PERSISTED_STATUSES: TorrentStatus[] = [
    'queued',
    'resolving-metadata',
    'downloading',
    'paused',
    'completed',
    'seeding',
    'error',
    'metadata-failed',
    'files-not-found',
];

/** Valida campos que pertencem ao formato salvo, sem iniciar operações do engine. */
export function validatePersistedDownloadItem(
    item: PersistedDownloadItem,
): PersistedDownloadValidation {
    if (typeof item.infoHash !== 'string' || item.infoHash.length !== 40)
        return { valid: false, reason: 'info-hash' };
    if (!VALID_PERSISTED_STATUSES.includes(item.status)) return { valid: false, reason: 'status' };
    if (
        item.magnetUri !== undefined &&
        (typeof item.magnetUri !== 'string' || !item.magnetUri.startsWith('magnet:'))
    )
        return { valid: false, reason: 'magnet-uri' };
    if (
        item.torrentFilePath !== undefined &&
        (typeof item.torrentFilePath !== 'string' || item.torrentFilePath.length === 0)
    )
        return { valid: false, reason: 'torrent-file-path' };

    let metadata: Buffer | undefined;
    if (item.torrentFileBase64 !== undefined) {
        const encoded = item.torrentFileBase64;
        if (
            typeof encoded !== 'string' ||
            encoded.length > Math.ceil(MAX_TORRENT_BYTES / 3) * 4 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
        )
            return { valid: false, reason: 'metadata-encoding' };
        metadata = Buffer.from(encoded, 'base64');
        if (!hasTorrentMagicBytes(metadata)) return { valid: false, reason: 'metadata-content' };
    }

    const files =
        Array.isArray(item.files) &&
        item.files.every(
            (file, index) =>
                file &&
                file.index === index &&
                isSafeTorrentPath(file.path) &&
                typeof file.name === 'string' &&
                Number.isSafeInteger(file.length) &&
                file.length >= 0 &&
                typeof file.downloaded === 'number' &&
                Number.isFinite(file.downloaded) &&
                file.downloaded >= 0 &&
                typeof file.selected === 'boolean',
        )
            ? item.files.map((file) => ({
                  ...file,
                  downloaded: Math.min(file.length, file.downloaded),
              }))
            : undefined;

    return {
        valid: true,
        ...(metadata ? { metadata } : {}),
        ...(files ? { files } : {}),
    };
}

export interface PersistedDownloadSnapshot {
    item: DownloadItem;
    files: TorrentFileInfo[];
    selectedFileIndices?: number[];
    magnetUri?: string;
    torrentFileBase64?: string;
    cachedMetadata?: TorrentMetadata;
}

/** Converte o snapshot do domínio para o DTO estável gravado na sessão. */
export function serializePersistedDownloadItem({
    item,
    files,
    selectedFileIndices,
    magnetUri,
    torrentFileBase64,
    cachedMetadata,
}: PersistedDownloadSnapshot): PersistedDownloadItem {
    return {
        infoHash: item.infoHash,
        name: item.name,
        totalSize: item.totalSize,
        downloadedSize: item.downloadedSize,
        progress: item.progress,
        status: item.status,
        destinationFolder: item.destinationFolder,
        addedAt: item.addedAt,
        ...(item.seedingDisabled !== undefined ? { seedingDisabled: item.seedingDisabled } : {}),
        ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
        ...(item.elapsedMs !== undefined ? { elapsedMs: item.elapsedMs } : {}),
        ...(selectedFileIndices !== undefined ? { selectedFileIndices } : {}),
        ...(magnetUri !== undefined ? { magnetUri } : {}),
        ...(item.errorMessage !== undefined ? { errorMessage: item.errorMessage } : {}),
        ...(item.pauseReason ? { pauseReason: item.pauseReason } : {}),
        ...(files.length ? { files } : {}),
        ...(torrentFileBase64 !== undefined ? { torrentFileBase64 } : {}),
        ...(item.selectedFileCount !== undefined
            ? { selectedFileCount: item.selectedFileCount }
            : {}),
        ...(item.totalFileCount !== undefined ? { totalFileCount: item.totalFileCount } : {}),
        ...(cachedMetadata !== undefined
            ? {
                  creator: cachedMetadata.creator,
                  comment: cachedMetadata.comment,
                  creationDate: cachedMetadata.creationDate,
              }
            : {}),
    };
}

/**
 * Encapsula o formato versionado e a ordem persistida da fila.
 * O gerenciador continua responsável por converter seu estado de domínio
 * em DTOs e por restaurar cada download no engine.
 */
export function createDownloadSessionRepository(
    store: PersistedStore,
    log: Logger,
): DownloadSessionRepository {
    return {
        read(): PersistedDownloadItem[] {
            const persistedVersion = store.get('downloadsSchemaVersion') ?? 1;
            if (persistedVersion > DOWNLOADS_SCHEMA_VERSION) {
                log.warn(
                    '[DownloadManager] Schema de downloads mais recente que o esperado:',
                    `persistido=${persistedVersion}`,
                    `atual=${DOWNLOADS_SCHEMA_VERSION}`,
                    '— tentando carregar mesmo assim',
                );
            }

            // Dados sem versão são o formato legado atual. Migrações futuras
            // devem ser aplicadas aqui antes de retornar os itens.
            return store.get('downloads') ?? [];
        },

        write(items: PersistedDownloadItem[], queueOrder: readonly string[]): void {
            const queuedItems = items.filter((item) => item.status === 'queued');
            const nonQueuedItems = items.filter((item) => item.status !== 'queued');

            queuedItems.sort(
                (a, b) => queueOrder.indexOf(a.infoHash) - queueOrder.indexOf(b.infoHash),
            );

            store.set('downloads', [...nonQueuedItems, ...queuedItems]);
            store.set('downloadsSchemaVersion', DOWNLOADS_SCHEMA_VERSION);
        },
    };
}

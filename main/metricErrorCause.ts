import { ErrorCodes } from '../shared/errorCodes';
import { serializeLogError } from './logRedaction';

export const ERROR_CAUSES = [
    'validation',
    'duplicate',
    'not_found',
    'timeout',
    'cancelled',
    'disk_space',
    'filesystem',
    'permission',
    'network',
    'network_policy',
    'engine_unavailable',
    'out_of_memory',
    'rate_limit',
    'unauthorized',
    'unknown',
] as const;
export type ErrorCause = (typeof ERROR_CAUSES)[number];
export type ErrorCauseCounts = Record<ErrorCause, number>;

export function emptyErrorCauses(): ErrorCauseCounts {
    return Object.fromEntries(ERROR_CAUSES.map((cause) => [cause, 0])) as ErrorCauseCounts;
}

const codes: Partial<Record<ErrorCause, ReadonlySet<string>>> = {
    validation: new Set([
        ErrorCodes.INVALID_PARAMS,
        ErrorCodes.INVALID_FILE_PATH,
        ErrorCodes.INVALID_MAGNET_URI,
        ErrorCodes.INVALID_SPEED_LIMIT,
        ErrorCodes.INVALID_TRACKER_URL,
        ErrorCodes.INVALID_SETTINGS,
        ErrorCodes.INVALID_SETTINGS_PAYLOAD,
        ErrorCodes.INVALID_LOCALE,
        ErrorCodes.FILE_SELECTION_EMPTY,
        ErrorCodes.FILE_INDEX_INVALID,
        ErrorCodes.FILE_PATH_UNSAFE,
    ]),
    duplicate: new Set([
        ErrorCodes.TORRENT_DUPLICATE,
        ErrorCodes.TRACKER_DUPLICATE,
        ErrorCodes.FILE_DESTINATION_CONFLICT,
    ]),
    not_found: new Set([
        ErrorCodes.TORRENT_NOT_FOUND,
        ErrorCodes.TRACKER_NOT_FOUND,
        ErrorCodes.QUEUE_NOT_FOUND,
        ErrorCodes.DESTINATION_FILE_NOT_FOUND,
        ErrorCodes.DESTINATION_FOLDER_NOT_FOUND,
        ErrorCodes.FILE_SOURCE_MISSING,
        'ENOENT',
    ]),
    timeout: new Set([ErrorCodes.METADATA_TIMEOUT, 'ETIMEDOUT', 'ERR_REQUEST_TIMEOUT']),
    cancelled: new Set([
        ErrorCodes.PREPARATION_CANCELLED,
        ErrorCodes.NO_FILE_SELECTED,
        ErrorCodes.NO_FOLDER_SELECTED,
        'ABORT_ERR',
    ]),
    disk_space: new Set([ErrorCodes.DISK_SPACE_LOW, 'ENOSPC', 'EDQUOT']),
    filesystem: new Set([
        ErrorCodes.DISK_SPACE_UNAVAILABLE,
        ErrorCodes.FILE_MOVE_SOURCE_RETAINED,
        'EIO',
        'EROFS',
        'EMFILE',
        'ENFILE',
    ]),
    permission: new Set(['EACCES', 'EPERM']),
    network: new Set([
        'ECONNRESET',
        'ECONNREFUSED',
        'ECONNABORTED',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EADDRINUSE',
        'EPIPE',
    ]),
    network_policy: new Set(['ERR_NETWORK_DESTINATION_BLOCKED']),
    engine_unavailable: new Set([ErrorCodes.ENGINE_RESTARTING, ErrorCodes.ENGINE_NOT_AVAILABLE]),
    out_of_memory: new Set(['ENOMEM', 'ERR_WORKER_OUT_OF_MEMORY', 'oom']),
    rate_limit: new Set([ErrorCodes.RATE_LIMITED]),
};

/** Só códigos conhecidos viram classes; texto livre nunca vira label. */
export function classifyErrorCause(error: unknown): ErrorCause {
    const inspect = (value: unknown, depth = 0): ErrorCause => {
        if (depth >= 6) return 'unknown';
        const fields =
            value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
        for (const candidate of [
            fields?.code,
            fields?.message,
            typeof value === 'string' ? value : undefined,
        ]) {
            if (typeof candidate !== 'string') continue;
            for (const cause of ERROR_CAUSES) if (codes[cause]?.has(candidate)) return cause;
        }
        const nested = fields?.cause === undefined ? 'unknown' : inspect(fields.cause, depth + 1);
        if (nested !== 'unknown') return nested;
        if (Array.isArray(fields?.errors)) {
            for (const child of fields.errors) {
                const found = inspect(child, depth + 1);
                if (found !== 'unknown') return found;
            }
        }
        return 'unknown';
    };
    return inspect(serializeLogError(error));
}

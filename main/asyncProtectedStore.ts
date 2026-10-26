import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import electron from 'electron';
import { ProtectedStoreError } from './storeEncryption';

const FORMAT = 'meshy-protected-store';
const VERSION = 2;
const LEGACY_VERSION = 1;

export interface AsyncProtectedStoreWriter {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    flush(): Promise<void>;
}

export interface AsyncProtectedStoreWriterOptions {
    path: string;
    initialValue: Record<string, unknown>;
    encrypt(plainText: string): Promise<Buffer>;
    initiallyDirty?: boolean;
    createTempName?: () => string;
    fileSystem?: {
        mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
        writeFile(
            path: string,
            data: string,
            options: { mode: number; flag: string },
        ): Promise<void>;
        rename(oldPath: string, newPath: string): Promise<void>;
        unlink(path: string): Promise<void>;
    };
}

/** Mantém a sessão em memória e grava snapshots criptografados de forma assíncrona. */
export function createAsyncProtectedStoreWriter(
    options: AsyncProtectedStoreWriterOptions,
): AsyncProtectedStoreWriter {
    const values = structuredClone(options.initialValue);
    const fileSystem = options.fileSystem ?? { mkdir, writeFile, rename, unlink };
    const createTempName = options.createTempName ?? randomUUID;
    let version = 0;
    let persistedVersion = 0;
    let flushInProgress: Promise<void> | undefined;
    if (options.initiallyDirty) version = 1;

    const writePendingSnapshots = async (): Promise<void> => {
        while (persistedVersion < version) {
            const snapshotVersion = version;
            const plainText = JSON.stringify(values);
            const encrypted = await options.encrypt(plainText);
            const contents = JSON.stringify({
                format: FORMAT,
                version: VERSION,
                data: encrypted.toString('base64'),
            });
            const tempPath = `${options.path}.${createTempName()}.tmp`;
            let tempExists = false;
            try {
                await fileSystem.mkdir(dirname(options.path), { recursive: true });
                await fileSystem.writeFile(tempPath, contents, { mode: 0o600, flag: 'wx' });
                tempExists = true;
                await fileSystem.rename(tempPath, options.path);
                tempExists = false;
                persistedVersion = snapshotVersion;
            } catch (error) {
                if (tempExists) await fileSystem.unlink(tempPath).catch(() => undefined);
                throw error;
            }
        }
    };

    return {
        get(key) {
            return values[key];
        },
        set(key, value) {
            values[key] = value;
            version++;
        },
        flush() {
            if (flushInProgress) return flushInProgress;
            const flush = writePendingSnapshots().finally(() => {
                if (flushInProgress === flush) flushInProgress = undefined;
            });
            flushInProgress = flush;
            return flush;
        },
    };
}

export interface AsyncSafeStorage {
    isAsyncEncryptionAvailable(): Promise<boolean>;
    getSelectedStorageBackend(): string;
    encryptStringAsync(plainText: string): Promise<Buffer>;
    decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface AsyncProtectedStoreAdapterOptions {
    path: string;
    safeStorage?: AsyncSafeStorage;
    platform?: NodeJS.Platform;
    fileSystem?: AsyncProtectedStoreWriterOptions['fileSystem'] & {
        readFile(path: string, encoding: 'utf8'): Promise<string>;
    };
}

/** Lê os formatos legado e protegido e mantém as gravações no mesmo envelope versionado. */
export async function createAsyncProtectedStoreAdapter(options: AsyncProtectedStoreAdapterOptions) {
    const safeStorage = options.safeStorage ?? electron.safeStorage;
    const platform = options.platform ?? process.platform;
    const fileSystem = options.fileSystem ?? { readFile, mkdir, writeFile, rename, unlink };
    let initialValue: Record<string, unknown> = {};
    let initiallyDirty = false;

    const ensureEncryption = async (): Promise<void> => {
        try {
            if (
                !(await safeStorage.isAsyncEncryptionAvailable()) ||
                (platform === 'linux' &&
                    !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
                        safeStorage.getSelectedStorageBackend(),
                    ))
            )
                throw new ProtectedStoreError('unavailable');
        } catch (error) {
            if (error instanceof ProtectedStoreError) throw error;
            throw new ProtectedStoreError('unavailable');
        }
    };

    let text: string | undefined;
    try {
        text = await fileSystem.readFile(options.path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    if (text !== undefined) {
        try {
            let value: unknown = JSON.parse(text);
            if (
                value &&
                typeof value === 'object' &&
                !Array.isArray(value) &&
                'format' in value &&
                value.format === FORMAT
            ) {
                await ensureEncryption();
                const envelope = value as Record<string, unknown>;
                if (
                    (envelope.version !== LEGACY_VERSION && envelope.version !== VERSION) ||
                    typeof envelope.data !== 'string' ||
                    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)
                )
                    throw new ProtectedStoreError('unreadable');
                const decrypted = await safeStorage.decryptStringAsync(
                    Buffer.from(envelope.data, 'base64'),
                );
                value = JSON.parse(decrypted.result);
                initiallyDirty = envelope.version === LEGACY_VERSION || decrypted.shouldReEncrypt;
            } else {
                // A versão anterior armazenava JSON sem criptografia e o migrava na abertura.
                initiallyDirty = true;
            }
            if (typeof value !== 'object' || value === null || Array.isArray(value))
                throw new ProtectedStoreError('unreadable');
            initialValue = value as Record<string, unknown>;
        } catch (error) {
            if (error instanceof ProtectedStoreError) throw error;
            throw new ProtectedStoreError('unreadable');
        }
    }

    const writer = createAsyncProtectedStoreWriter({
        path: options.path,
        initialValue,
        initiallyDirty,
        encrypt: async (plainText) => {
            await ensureEncryption();
            try {
                return await safeStorage.encryptStringAsync(plainText);
            } catch {
                throw new ProtectedStoreError('write');
            }
        },
        fileSystem,
    });

    if (initiallyDirty) await writer.flush();

    return {
        get(key: string): unknown {
            return writer.get(key);
        },
        set(key: string, value: unknown): void {
            writer.set(key, value);
        },
        flush: writer.flush,
    };
}

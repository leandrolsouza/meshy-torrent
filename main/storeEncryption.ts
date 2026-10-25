export interface StoreKeyProvider {
    isEncryptionAvailable(): boolean;
    getSelectedStorageBackend(): string;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
}

export class ProtectedStoreError extends Error {
    readonly reason: 'unavailable' | 'unreadable' | 'write';
    constructor(reason: ProtectedStoreError['reason']) {
        super(`Armazenamento seguro: ${reason}`);
        this.reason = reason;
        this.name = 'ProtectedStoreError';
    }
}

const FORMAT = 'meshy-protected-store';
const VERSION = 1;

/** Envelope de disco independente das versões dos DTOs de settings/downloads. */
export function createStoreEncryption(
    provider: StoreKeyProvider,
    platform: NodeJS.Platform = process.platform,
) {
    let legacyLoaded = false;
    const requireEncryption = () => {
        try {
            if (
                !provider?.isEncryptionAvailable() ||
                (platform === 'linux' &&
                    !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
                        provider.getSelectedStorageBackend(),
                    ))
            )
                throw new ProtectedStoreError('unavailable');
        } catch {
            throw new ProtectedStoreError('unavailable');
        }
    };
    return {
        serialize(value: Record<string, unknown>): string {
            requireEncryption();
            try {
                const data = provider.encryptString(JSON.stringify(value)).toString('base64');
                return JSON.stringify({ format: FORMAT, version: VERSION, data });
            } catch {
                throw new ProtectedStoreError('write');
            }
        },
        deserialize(text: string): Record<string, unknown> {
            try {
                let value: unknown = JSON.parse(text);
                if (
                    value &&
                    typeof value === 'object' &&
                    'format' in value &&
                    value.format === FORMAT
                ) {
                    requireEncryption();
                    const envelope = value as Record<string, unknown>;
                    if (
                        envelope.version !== VERSION ||
                        typeof envelope.data !== 'string' ||
                        !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data)
                    )
                        throw new ProtectedStoreError('unreadable');
                    value = JSON.parse(
                        provider.decryptString(Buffer.from(envelope.data, 'base64')),
                    );
                } else {
                    legacyLoaded = true;
                }
                if (typeof value !== 'object' || value === null || Array.isArray(value))
                    throw new ProtectedStoreError('unreadable');
                return value as Record<string, unknown>;
            } catch (error) {
                if (error instanceof ProtectedStoreError) throw error;
                throw new ProtectedStoreError('unreadable');
            }
        },
        migrate(store: { store: Record<string, unknown> }): void {
            if (legacyLoaded) {
                // O setter do electron-store grava atomicamente com o serialize protegido.
                const contents = store.store;
                store.store = contents;
                legacyLoaded = false;
            }
        },
    };
}

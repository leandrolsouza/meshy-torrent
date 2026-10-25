import ElectronStore from 'electron-store';
import type { Options } from 'electron-store';
import electron from 'electron';
import { createStoreEncryption } from './storeEncryption';

/** Acesso síncrono preservado para os contratos dos serviços no Electron 44. */
export function createProtectedStore<T extends Record<string, unknown> = Record<string, unknown>>(
    options: Omit<Options<T>, 'serialize' | 'deserialize' | 'encryptionKey' | 'clearInvalidConfig'>,
): ElectronStore<T> {
    const encryption = createStoreEncryption(electron.safeStorage);
    const store = new ElectronStore<T>({
        ...options,
        serialize: encryption.serialize,
        deserialize: encryption.deserialize as (text: string) => T,
        clearInvalidConfig: false,
    });
    encryption.migrate(store);
    return store;
}

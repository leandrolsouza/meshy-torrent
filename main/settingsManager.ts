import { createProtectedStore } from './protectedStore';
import type { AppSettings } from '../shared/types';
import { createDefaultBandwidthSettings, isValidBandwidthSettings } from '../shared/bandwidth';
import {
    DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    isValidTrackerUrl,
    normalizeTrackerUrl,
    isValidSpeedLimit,
    isValidMaxConcurrentDownloads,
} from '../shared/validators';
import { logger as defaultLogger } from './logger';
import type { Logger } from './logger';

export type { AppSettings } from '../shared/types';

// ─── Types ────────────────────────────────────────────────────────────────────

type PersistedSettings = {
    seedingEnabled: boolean;
    maxConcurrentSeeders: number;
    bandwidth?: AppSettings['bandwidth'];
    closeToTray: boolean;
    destinationFolder: string;
    downloadSpeedLimit: number;
    uploadSpeedLimit: number;
    maxConcurrentDownloads: number;
    notificationsEnabled: boolean;
    theme: string; // identificador do tema ativo (ex: "vs-code-dark")
    locale: string; // identificador de locale BCP 47 (ex: "pt-BR", "en-US")
    globalTrackers: string[]; // lista de Tracker URLs favoritas
    autoApplyGlobalTrackers: boolean; // aplicar automaticamente a novos torrents
    // Configurações avançadas de rede
    dhtEnabled: boolean; // DHT — Distributed Hash Table (padrão: true)
    pexEnabled: boolean; // PEX — Peer Exchange (padrão: true)
    utpEnabled: boolean; // uTP — Micro Transport Protocol (padrão: true)
    schemaVersion: number; // para migrações futuras
};

export interface SettingsManager {
    get(): AppSettings;
    set(partial: Partial<AppSettings>): void;
    getDefaultDownloadFolder(): string;
    getGlobalTrackers(): string[];
    addGlobalTracker(url: string): void;
    removeGlobalTracker(url: string): void;
    setAutoApplyGlobalTrackers(enabled: boolean): void;
}

// ─── Store interface (subset used by SettingsManager) ─────────────────────────

/**
 * Minimal interface for the store, allowing injection of a mock in tests.
 */
export interface SettingsStore {
    get<K extends keyof PersistedSettings>(key: K): PersistedSettings[K];
    set<K extends keyof PersistedSettings>(key: K, value: PersistedSettings[K]): void;
    /** Confirma o conjunto em uma única gravação, preservando as demais chaves. */
    setMany(values: Partial<AppSettings>): void;
    /** Lê todos os campos em uma única operação quando o armazenamento oferece esse caminho. */
    getAll?(): Partial<PersistedSettings>;
}

// ─── Factory options ──────────────────────────────────────────────────────────

export interface CreateSettingsManagerOptions {
    /**
     * Injectable store instance. When omitted, a real `electron-store` is created.
     * Provide a mock here in tests to avoid touching the file system or requiring Electron.
     */
    store?: SettingsStore;

    /**
     * Injectable function that returns the OS default downloads folder.
     * Defaults to `app.getPath('downloads')` from Electron.
     * Override in tests to avoid requiring a running Electron app.
     */
    getDownloadsPath?: () => string;

    /**
     * Injectable logger instance. Defaults to electron-log.
     * Override in tests to avoid requiring Electron.
     */
    log?: Logger;
}

// ─── Current schema version ───────────────────────────────────────────────────

const SCHEMA_VERSION = 1;

const PERSISTED_SETTING_KEYS: (keyof PersistedSettings)[] = [
    'seedingEnabled',
    'maxConcurrentSeeders',
    'bandwidth',
    'closeToTray',
    'destinationFolder',
    'downloadSpeedLimit',
    'uploadSpeedLimit',
    'maxConcurrentDownloads',
    'notificationsEnabled',
    'theme',
    'locale',
    'globalTrackers',
    'autoApplyGlobalTrackers',
    'dhtEnabled',
    'pexEnabled',
    'utpEnabled',
    'schemaVersion',
];

function copySettingValue<T>(value: T): T {
    return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

function createCachedSettingsStore(persistedStore: SettingsStore): SettingsStore {
    const initial = persistedStore.getAll?.();
    const cache = new Map<string, unknown>();
    if (initial) {
        for (const [key, value] of Object.entries(initial)) {
            cache.set(key, copySettingValue(value));
        }
    } else {
        for (const key of PERSISTED_SETTING_KEYS) {
            cache.set(String(key), copySettingValue(persistedStore.get(key)));
        }
    }

    return {
        get<K extends keyof PersistedSettings>(key: K): PersistedSettings[K] {
            return copySettingValue(cache.get(String(key))) as PersistedSettings[K];
        },
        set<K extends keyof PersistedSettings>(key: K, value: PersistedSettings[K]): void {
            persistedStore.set(key, value);
            cache.set(String(key), copySettingValue(value));
        },
        setMany(values: Partial<AppSettings>): void {
            const copied = copySettingValue(values);
            persistedStore.setMany(copied);
            for (const [key, value] of Object.entries(copied)) {
                cache.set(key, copySettingValue(value));
            }
        },
    };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a `SettingsManager` instance.
 *
 * @example
 * // Production usage (Electron main process):
 * const settings = createSettingsManager();
 *
 * @example
 * // Test usage (no Electron required):
 * const fakeStore = new Map<string, unknown>();
 * const settings = createSettingsManager({
 *   store: {
 *     get: (key) => fakeStore.get(key) as any,
 *     set: (key, value) => fakeStore.set(key, value),
 *     setMany: (values) => {
 *       for (const [key, value] of Object.entries(values)) fakeStore.set(key, value);
 *     },
 *   },
 *   getDownloadsPath: () => '/home/user/Downloads',
 * });
 */
export function createSettingsManager(options: CreateSettingsManagerOptions = {}): SettingsManager {
    // ── Resolve the store ──────────────────────────────────────────────────────
    const persistedStore: SettingsStore = options.store ?? createElectronStore();
    const store = createCachedSettingsStore(persistedStore);

    // ── Resolve the downloads-path getter ─────────────────────────────────────
    const getDownloadsPath: () => string =
        options.getDownloadsPath ?? getDefaultDownloadsPathFromElectron;

    // ── Resolve the logger ────────────────────────────────────────────────────
    const log: Logger = options.log ?? defaultLogger;

    // ── Ensure destinationFolder is initialised ────────────────────────────────
    const currentFolder = store.get('destinationFolder');
    if (!currentFolder) {
        store.set('destinationFolder', getDownloadsPath());
    }

    // ── Ensure schemaVersion is initialised ───────────────────────────────────
    const currentVersion = store.get('schemaVersion');
    if (!currentVersion) {
        store.set('schemaVersion', SCHEMA_VERSION);
    }

    // ── Sanitizar valores na carga ────────────────────────────────────────────
    // Corrige valores inválidos que podem ter sido persistidos por corrupção,
    // edição manual do arquivo de settings, ou bugs em versões anteriores.
    sanitizeOnLoad(store, getDownloadsPath, log);

    const readSettings = (): AppSettings => ({
        destinationFolder: store.get('destinationFolder'),
        downloadSpeedLimit: store.get('downloadSpeedLimit') ?? 0,
        uploadSpeedLimit: store.get('uploadSpeedLimit') ?? 0,
        maxConcurrentDownloads:
            store.get('maxConcurrentDownloads') ?? DEFAULT_MAX_CONCURRENT_DOWNLOADS,
        seedingEnabled: store.get('seedingEnabled') ?? true,
        maxConcurrentSeeders: store.get('maxConcurrentSeeders') ?? 2,
        notificationsEnabled: store.get('notificationsEnabled') ?? true,
        theme: store.get('theme') ?? 'vs-code-dark',
        locale: store.get('locale') ?? 'pt-BR',
        globalTrackers: store.get('globalTrackers') ?? [],
        autoApplyGlobalTrackers: store.get('autoApplyGlobalTrackers') ?? false,
        dhtEnabled: store.get('dhtEnabled') ?? true,
        pexEnabled: store.get('pexEnabled') ?? true,
        utpEnabled: store.get('utpEnabled') ?? true,
        closeToTray: store.get('closeToTray') ?? false,
        bandwidth: store.get('bandwidth') ?? createDefaultBandwidthSettings(),
    });
    let settings = readSettings();

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        get(): AppSettings {
            return structuredClone(settings);
        },

        set(partial: Partial<AppSettings>): void {
            const settableKeys: (keyof AppSettings)[] = [
                'destinationFolder',
                'downloadSpeedLimit',
                'uploadSpeedLimit',
                'maxConcurrentDownloads',
                'seedingEnabled',
                'maxConcurrentSeeders',
                'notificationsEnabled',
                'theme',
                'locale',
                'globalTrackers',
                'autoApplyGlobalTrackers',
                'dhtEnabled',
                'pexEnabled',
                'utpEnabled',
                'closeToTray',
                'bandwidth',
            ];

            const updates: Partial<AppSettings> = {};
            for (const key of settableKeys) {
                if (partial[key] !== undefined) {
                    // Chave e valor vêm do mesmo campo de AppSettings.
                    updates[key] = partial[key] as never;
                }
            }
            if (Object.keys(updates).length > 0) {
                store.setMany(updates);
                settings = { ...settings, ...structuredClone(updates) };
            }
        },

        getDefaultDownloadFolder(): string {
            return getDownloadsPath();
        },

        getGlobalTrackers(): string[] {
            return [...settings.globalTrackers];
        },

        addGlobalTracker(url: string): void {
            if (!isValidTrackerUrl(url)) {
                throw new Error('URL de tracker inválida');
            }

            const normalized = normalizeTrackerUrl(url);
            const current = settings.globalTrackers;

            if (current.includes(normalized)) {
                throw new Error('Tracker já existe na lista global');
            }

            const updated = [...current, normalized];
            store.set('globalTrackers', updated);
            settings = { ...settings, globalTrackers: updated };
        },

        removeGlobalTracker(url: string): void {
            const normalized = normalizeTrackerUrl(url);
            const updated = settings.globalTrackers.filter((tracker) => tracker !== normalized);
            store.set('globalTrackers', updated);
            settings = { ...settings, globalTrackers: updated };
        },

        setAutoApplyGlobalTrackers(enabled: boolean): void {
            store.set('autoApplyGlobalTrackers', enabled);
            settings = { ...settings, autoApplyGlobalTrackers: enabled };
        },
    };
}

// ─── Sanitização na carga ─────────────────────────────────────────────────────

/**
 * Valida e corrige valores persistidos que podem estar corrompidos.
 * Cada campo é verificado individualmente — se inválido, é resetado para o default.
 * Loga um warning para cada correção aplicada.
 */
function sanitizeOnLoad(store: SettingsStore, getDownloadsPath: () => string, log: Logger): void {
    const seeders = store.get('maxConcurrentSeeders');
    if (seeders !== undefined && (!Number.isInteger(seeders) || seeders < 1 || seeders > 20))
        store.set('maxConcurrentSeeders', 2);
    const enabled = store.get('seedingEnabled');
    if (enabled !== undefined && typeof enabled !== 'boolean') store.set('seedingEnabled', true);
    const bandwidth = store.get('bandwidth');
    if (bandwidth !== undefined && !isValidBandwidthSettings(bandwidth))
        store.set('bandwidth', createDefaultBandwidthSettings());
    const closeToTray = store.get('closeToTray');
    if (closeToTray !== undefined && typeof closeToTray !== 'boolean')
        store.set('closeToTray', false);
    // downloadSpeedLimit: inteiro >= 0
    const dl = store.get('downloadSpeedLimit');
    if (dl !== undefined && !isValidSpeedLimit(dl)) {
        log.warn('[SettingsManager] downloadSpeedLimit inválido, resetando para 0:', String(dl));
        store.set('downloadSpeedLimit', 0);
    }

    // uploadSpeedLimit: inteiro >= 0
    const ul = store.get('uploadSpeedLimit');
    if (ul !== undefined && !isValidSpeedLimit(ul)) {
        log.warn('[SettingsManager] uploadSpeedLimit inválido, resetando para 0:', String(ul));
        store.set('uploadSpeedLimit', 0);
    }

    // maxConcurrentDownloads: inteiro entre MIN e MAX
    const mc = store.get('maxConcurrentDownloads');
    if (mc !== undefined && !isValidMaxConcurrentDownloads(mc)) {
        log.warn(
            `[SettingsManager] maxConcurrentDownloads inválido, resetando para ${DEFAULT_MAX_CONCURRENT_DOWNLOADS}:`,
            String(mc),
        );
        store.set('maxConcurrentDownloads', DEFAULT_MAX_CONCURRENT_DOWNLOADS);
    }

    // notificationsEnabled: boolean
    const ne = store.get('notificationsEnabled');
    if (ne !== undefined && typeof ne !== 'boolean') {
        log.warn(
            '[SettingsManager] notificationsEnabled inválido, resetando para true:',
            String(ne),
        );
        store.set('notificationsEnabled', true);
    }

    // theme: string não-vazia
    const theme = store.get('theme');
    if (theme !== undefined && (typeof theme !== 'string' || theme.length === 0)) {
        log.warn('[SettingsManager] theme inválido, resetando para vs-code-dark:', String(theme));
        store.set('theme', 'vs-code-dark');
    }

    // locale: string não-vazia
    const locale = store.get('locale');
    if (locale !== undefined && (typeof locale !== 'string' || locale.trim().length === 0)) {
        log.warn('[SettingsManager] locale inválido, resetando para pt-BR:', String(locale));
        store.set('locale', 'pt-BR');
    }

    // destinationFolder: string não-vazia
    const folder = store.get('destinationFolder');
    if (typeof folder !== 'string' || folder.length === 0) {
        const defaultFolder = getDownloadsPath();
        log.warn('[SettingsManager] destinationFolder inválido, resetando para:', defaultFolder);
        store.set('destinationFolder', defaultFolder);
    }

    // globalTrackers: array de strings válidas
    const trackers = store.get('globalTrackers');
    if (trackers !== undefined && !Array.isArray(trackers)) {
        log.warn('[SettingsManager] globalTrackers inválido, resetando para []');
        store.set('globalTrackers', []);
    }

    // Booleans de rede: dhtEnabled, pexEnabled, utpEnabled
    for (const key of ['dhtEnabled', 'pexEnabled', 'utpEnabled'] as const) {
        const val = store.get(key);
        if (val !== undefined && typeof val !== 'boolean') {
            log.warn(`[SettingsManager] ${key} inválido, resetando para true:`, String(val));
            store.set(key, true);
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a real `electron-store` instance with the PersistedSettings schema.
 * This is only called in the Electron main process.
 */
function createElectronStore(): SettingsStore {
    const store = createProtectedStore<PersistedSettings>({
        name: 'settings',
        defaults: {
            bandwidth: createDefaultBandwidthSettings(),
            closeToTray: false,
            destinationFolder: '',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
            seedingEnabled: true,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            theme: 'vs-code-dark',
            locale: 'pt-BR',
            globalTrackers: [],
            autoApplyGlobalTrackers: false,
            dhtEnabled: true,
            pexEnabled: true,
            utpEnabled: true,
            schemaVersion: SCHEMA_VERSION,
        },
    });

    return {
        get<K extends keyof PersistedSettings>(key: K): PersistedSettings[K] {
            return store.get(key) as PersistedSettings[K];
        },
        set<K extends keyof PersistedSettings>(key: K, value: PersistedSettings[K]): void {
            store.set(key, value);
        },
        setMany(values: Partial<AppSettings>): void {
            store.set(values);
        },
        getAll(): Partial<PersistedSettings> {
            return store.store;
        },
    };
}

/**
 * Returns the OS default downloads folder using Electron's `app.getPath`.
 * Falls back to the home directory if `app` is not available.
 */
function getDefaultDownloadsPathFromElectron(): string {
    try {
        const electron = require('electron');
        return electron.app.getPath('downloads');
    } catch {
        // Fallback when Electron is not available (e.g., unit tests without injection)
        const os = require('os');
        return os.homedir();
    }
}

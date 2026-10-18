import { createSettingsManager, SettingsStore } from '../../main/settingsManager';
import fc from 'fast-check';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates an in-memory store that satisfies the SettingsStore interface.
 * Avoids touching the file system or requiring a running Electron app.
 */
function createFakeStore(initial: Record<string, unknown> = {}): SettingsStore {
    const data = new Map<string, unknown>(Object.entries(initial));
    return {
        get: (key) => data.get(key) as any,
        set: (key, value) => {
            data.set(key, value);
        },
    };
}

const FAKE_DOWNLOADS_PATH = '/home/testuser/Downloads';

function makeManager(storeData: Record<string, unknown> = {}) {
    return createSettingsManager({
        store: createFakeStore(storeData),
        getDownloadsPath: () => FAKE_DOWNLOADS_PATH,
    });
}

// ─── get() ────────────────────────────────────────────────────────────────────

describe('SettingsManager.get()', () => {
    it('sessões antigas usam fechar normalmente; preferência de bandeja pode ser persistida', () => {
        const manager = makeManager();
        expect(manager.get().closeToTray).toBe(false);
        manager.set({ closeToTray: true });
        expect(manager.get().closeToTray).toBe(true);
        expect(makeManager({ closeToTray: 'invalid' }).get().closeToTray).toBe(false);
    });
    it('returns default speed limits of 0 when store is empty', () => {
        const manager = makeManager();
        const settings = manager.get();
        expect(settings.downloadSpeedLimit).toBe(0);
        expect(settings.uploadSpeedLimit).toBe(0);
    });

    it('returns the default downloads folder as destinationFolder when store is empty', () => {
        const manager = makeManager();
        const settings = manager.get();
        expect(settings.destinationFolder).toBe(FAKE_DOWNLOADS_PATH);
    });

    it('returns previously stored destinationFolder', () => {
        const manager = makeManager({ destinationFolder: '/custom/path' });
        expect(manager.get().destinationFolder).toBe('/custom/path');
    });

    it('returns previously stored speed limits', () => {
        const manager = makeManager({ downloadSpeedLimit: 512, uploadSpeedLimit: 256 });
        const settings = manager.get();
        expect(settings.downloadSpeedLimit).toBe(512);
        expect(settings.uploadSpeedLimit).toBe(256);
    });

    it('returns an object with exactly the expected keys', () => {
        const manager = makeManager();
        const settings = manager.get();
        expect(Object.keys(settings).sort()).toEqual(
            [
                'autoApplyGlobalTrackers',
                'bandwidth',
                'closeToTray',
                'destinationFolder',
                'dhtEnabled',
                'downloadSpeedLimit',
                'globalTrackers',
                'locale',
                'maxConcurrentDownloads',
                'maxConcurrentSeeders',
                'seedingEnabled',
                'notificationsEnabled',
                'pexEnabled',
                'theme',
                'uploadSpeedLimit',
                'utpEnabled',
            ].sort(),
        );
    });
});

// ─── set() ────────────────────────────────────────────────────────────────────

describe('SettingsManager.set()', () => {
    it('persists a new destinationFolder', () => {
        const manager = makeManager();
        manager.set({ destinationFolder: '/new/path' });
        expect(manager.get().destinationFolder).toBe('/new/path');
    });

    it('persists a new downloadSpeedLimit', () => {
        const manager = makeManager();
        manager.set({ downloadSpeedLimit: 1024 });
        expect(manager.get().downloadSpeedLimit).toBe(1024);
    });

    it('persists a new uploadSpeedLimit', () => {
        const manager = makeManager();
        manager.set({ uploadSpeedLimit: 256 });
        expect(manager.get().uploadSpeedLimit).toBe(256);
    });

    it('performs a partial update without overwriting unrelated fields', () => {
        const manager = makeManager({ downloadSpeedLimit: 100, uploadSpeedLimit: 50 });
        manager.set({ downloadSpeedLimit: 200 });
        const settings = manager.get();
        expect(settings.downloadSpeedLimit).toBe(200);
        expect(settings.uploadSpeedLimit).toBe(50);
    });

    it('allows setting speed limits back to 0 (no limit)', () => {
        const manager = makeManager({ downloadSpeedLimit: 500 });
        manager.set({ downloadSpeedLimit: 0 });
        expect(manager.get().downloadSpeedLimit).toBe(0);
    });

    it('persists multiple fields in a single call', () => {
        const manager = makeManager();
        manager.set({ downloadSpeedLimit: 300, uploadSpeedLimit: 150 });
        const settings = manager.get();
        expect(settings.downloadSpeedLimit).toBe(300);
        expect(settings.uploadSpeedLimit).toBe(150);
    });
});

// ─── getDefaultDownloadFolder() ───────────────────────────────────────────────

// ─── Configurações de rede (dhtEnabled, pexEnabled, utpEnabled) ───────────────

describe('SettingsManager — configurações de rede (defaults)', () => {
    it('retorna dhtEnabled=true quando store está vazio', () => {
        const manager = makeManager();
        expect(manager.get().dhtEnabled).toBe(true);
    });

    it('retorna pexEnabled=true quando store está vazio', () => {
        const manager = makeManager();
        expect(manager.get().pexEnabled).toBe(true);
    });

    it('retorna utpEnabled=true quando store está vazio', () => {
        const manager = makeManager();
        expect(manager.get().utpEnabled).toBe(true);
    });
});

describe('SettingsManager — configurações de rede (persistência)', () => {
    it('persiste dhtEnabled=false e recupera corretamente', () => {
        const manager = makeManager();
        manager.set({ dhtEnabled: false });
        expect(manager.get().dhtEnabled).toBe(false);
    });

    it('persiste pexEnabled=false e recupera corretamente', () => {
        const manager = makeManager();
        manager.set({ pexEnabled: false });
        expect(manager.get().pexEnabled).toBe(false);
    });

    it('persiste utpEnabled=false e recupera corretamente', () => {
        const manager = makeManager();
        manager.set({ utpEnabled: false });
        expect(manager.get().utpEnabled).toBe(false);
    });

    it('persiste múltiplos campos de rede em uma única chamada', () => {
        const manager = makeManager();
        manager.set({ dhtEnabled: false, pexEnabled: false, utpEnabled: false });
        const settings = manager.get();
        expect(settings.dhtEnabled).toBe(false);
        expect(settings.pexEnabled).toBe(false);
        expect(settings.utpEnabled).toBe(false);
    });

    it('atualização parcial de rede não afeta outros campos de rede', () => {
        const manager = makeManager();
        manager.set({ dhtEnabled: false });
        const settings = manager.get();
        expect(settings.dhtEnabled).toBe(false);
        expect(settings.pexEnabled).toBe(true);
        expect(settings.utpEnabled).toBe(true);
    });
});

describe('SettingsManager — configurações de rede (restauração entre sessões)', () => {
    it('restaura valores de rede previamente armazenados no store', () => {
        const manager = makeManager({
            dhtEnabled: false,
            pexEnabled: false,
            utpEnabled: true,
        });
        const settings = manager.get();
        expect(settings.dhtEnabled).toBe(false);
        expect(settings.pexEnabled).toBe(false);
        expect(settings.utpEnabled).toBe(true);
    });

    it('restaura valores de rede usando store compartilhado entre instâncias', () => {
        const sharedStore = createFakeStore();
        const manager1 = createSettingsManager({
            store: sharedStore,
            getDownloadsPath: () => FAKE_DOWNLOADS_PATH,
        });
        manager1.set({ dhtEnabled: false, pexEnabled: true, utpEnabled: false });

        const manager2 = createSettingsManager({
            store: sharedStore,
            getDownloadsPath: () => FAKE_DOWNLOADS_PATH,
        });
        const settings = manager2.get();
        expect(settings.dhtEnabled).toBe(false);
        expect(settings.pexEnabled).toBe(true);
        expect(settings.utpEnabled).toBe(false);
    });
});

// ─── getDefaultDownloadFolder() (original) ────────────────────────────────────

describe('SettingsManager.getDefaultDownloadFolder()', () => {
    it('returns a non-empty string', () => {
        const manager = makeManager();
        const folder = manager.getDefaultDownloadFolder();
        expect(typeof folder).toBe('string');
        expect(folder.length).toBeGreaterThan(0);
    });

    it('returns the injected downloads path', () => {
        const manager = makeManager();
        expect(manager.getDefaultDownloadFolder()).toBe(FAKE_DOWNLOADS_PATH);
    });
});

// ─── getGlobalTrackers() ──────────────────────────────────────────────────────

describe('SettingsManager.getGlobalTrackers()', () => {
    it('retorna lista vazia quando store está vazio', () => {
        const manager = makeManager();
        expect(manager.getGlobalTrackers()).toEqual([]);
    });

    it('retorna trackers previamente armazenados', () => {
        const manager = makeManager({
            globalTrackers: ['udp://tracker.example.com:6969/announce'],
        });
        expect(manager.getGlobalTrackers()).toEqual(['udp://tracker.example.com:6969/announce']);
    });
});

// ─── addGlobalTracker() ───────────────────────────────────────────────────────

describe('SettingsManager.addGlobalTracker()', () => {
    it('adiciona tracker válido à lista global', () => {
        const manager = makeManager();
        manager.addGlobalTracker('udp://tracker.example.com:6969/announce');
        expect(manager.getGlobalTrackers()).toEqual(['udp://tracker.example.com:6969/announce']);
    });

    it('normaliza a URL antes de armazenar', () => {
        const manager = makeManager();
        manager.addGlobalTracker('  UDP://Tracker.Example.com:6969/announce  ');
        expect(manager.getGlobalTrackers()).toEqual(['udp://Tracker.Example.com:6969/announce']);
    });

    it('rejeita URL inválida com erro de validação', () => {
        const manager = makeManager();
        expect(() => manager.addGlobalTracker('ftp://invalid.com')).toThrow(
            'URL de tracker inválida',
        );
        expect(manager.getGlobalTrackers()).toEqual([]);
    });

    it('rejeita string vazia', () => {
        const manager = makeManager();
        expect(() => manager.addGlobalTracker('')).toThrow('URL de tracker inválida');
    });

    it('rejeita URL duplicada com erro de duplicidade', () => {
        const manager = makeManager();
        manager.addGlobalTracker('udp://tracker.example.com:6969/announce');
        expect(() => manager.addGlobalTracker('udp://tracker.example.com:6969/announce')).toThrow(
            'Tracker já existe na lista global',
        );
    });

    it('rejeita duplicata mesmo com espaços e casing diferente no protocolo', () => {
        const manager = makeManager();
        manager.addGlobalTracker('udp://tracker.example.com:6969/announce');
        expect(() =>
            manager.addGlobalTracker('  UDP://tracker.example.com:6969/announce  '),
        ).toThrow('Tracker já existe na lista global');
    });

    it('permite adicionar múltiplos trackers distintos', () => {
        const manager = makeManager();
        manager.addGlobalTracker('udp://tracker1.example.com:6969/announce');
        manager.addGlobalTracker('http://tracker2.example.com/announce');
        expect(manager.getGlobalTrackers()).toEqual([
            'udp://tracker1.example.com:6969/announce',
            'http://tracker2.example.com/announce',
        ]);
    });
});

// ─── removeGlobalTracker() ────────────────────────────────────────────────────

describe('SettingsManager.removeGlobalTracker()', () => {
    it('remove tracker existente da lista global', () => {
        const manager = makeManager({
            globalTrackers: [
                'udp://tracker1.example.com:6969/announce',
                'http://tracker2.example.com/announce',
            ],
        });
        manager.removeGlobalTracker('udp://tracker1.example.com:6969/announce');
        expect(manager.getGlobalTrackers()).toEqual(['http://tracker2.example.com/announce']);
    });

    it('não altera a lista ao remover tracker inexistente', () => {
        const manager = makeManager({
            globalTrackers: ['udp://tracker.example.com:6969/announce'],
        });
        manager.removeGlobalTracker('udp://nonexistent.com:6969/announce');
        expect(manager.getGlobalTrackers()).toEqual(['udp://tracker.example.com:6969/announce']);
    });

    it('normaliza a URL antes de comparar para remoção', () => {
        const manager = makeManager({
            globalTrackers: ['udp://tracker.example.com:6969/announce'],
        });
        manager.removeGlobalTracker('  UDP://tracker.example.com:6969/announce  ');
        expect(manager.getGlobalTrackers()).toEqual([]);
    });
});

// ─── setAutoApplyGlobalTrackers() ─────────────────────────────────────────────

describe('SettingsManager.setAutoApplyGlobalTrackers()', () => {
    it('habilita aplicação automática de trackers globais', () => {
        const manager = makeManager();
        manager.setAutoApplyGlobalTrackers(true);
        expect(manager.get().autoApplyGlobalTrackers).toBe(true);
    });

    it('desabilita aplicação automática de trackers globais', () => {
        const manager = makeManager({ autoApplyGlobalTrackers: true });
        manager.setAutoApplyGlobalTrackers(false);
        expect(manager.get().autoApplyGlobalTrackers).toBe(false);
    });

    it('valor padrão é false', () => {
        const manager = makeManager();
        expect(manager.get().autoApplyGlobalTrackers).toBe(false);
    });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

// Feature: meshy-torrent-client, Property 10: Round-trip de persistência de configurações
describe('Property 10: Round-trip de persistência de configurações', () => {
    // **Validates: Requirements 5.1, 6.1**
    it('set(settings) followed by get() returns equivalent settings for any valid input', () => {
        fc.assert(
            fc.property(
                fc.record({
                    destinationFolder: fc.string({ minLength: 1 }),
                    downloadSpeedLimit: fc.nat(),
                    uploadSpeedLimit: fc.nat(),
                }),
                (settings) => {
                    const manager = makeManager();

                    manager.set(settings);
                    const result = manager.get();

                    expect(result.destinationFolder).toBe(settings.destinationFolder);
                    expect(result.downloadSpeedLimit).toBe(settings.downloadSpeedLimit);
                    expect(result.uploadSpeedLimit).toBe(settings.uploadSpeedLimit);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// Feature: dht-pex-settings, Property 3: Round-trip de persistência das configurações de rede
describe('Property 3: Round-trip de persistência das configurações de rede', () => {
    // **Validates: Requirements 1.3, 1.4**
    it('persistir via set() e recuperar via get() retorna valores iguais aos persistidos', () => {
        fc.assert(
            fc.property(
                fc.record({
                    dhtEnabled: fc.boolean(),
                    pexEnabled: fc.boolean(),
                    utpEnabled: fc.boolean(),
                }),
                (networkSettings) => {
                    const manager = makeManager();

                    manager.set(networkSettings);
                    const result = manager.get();

                    expect(result.dhtEnabled).toBe(networkSettings.dhtEnabled);
                    expect(result.pexEnabled).toBe(networkSettings.pexEnabled);
                    expect(result.utpEnabled).toBe(networkSettings.utpEnabled);
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── Property 6: Lista global persiste entre sessões ──────────────────────────

// Feature: tracker-management, Property 6: Lista global persiste entre sessões
describe('Property 6: Lista global persiste entre sessões', () => {
    // **Validates: Requirements 4.1**
    it('salvar trackers globais e recriar SettingsManager com o mesmo store produz a mesma lista', () => {
        // Gerador de URLs de tracker válidas únicas
        const validTrackerUrlArb = fc
            .record({
                protocol: fc.constantFrom('udp', 'http', 'https'),
                host: fc
                    .string({
                        unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
                        minLength: 3,
                        maxLength: 12,
                    })
                    .filter((h) => /^[a-z]/.test(h)),
                port: fc.integer({ min: 1, max: 65535 }),
            })
            .map(
                ({ protocol, host, port }) => `${protocol}://${host}.example.com:${port}/announce`,
            );

        const uniqueTrackerListArb = fc.uniqueArray(validTrackerUrlArb, {
            minLength: 0,
            maxLength: 10,
            comparator: (a, b) => a === b,
        });

        fc.assert(
            fc.property(uniqueTrackerListArb, (trackerList) => {
                // Criar store compartilhado entre as duas instâncias
                const sharedStore = createFakeStore();

                // Primeira sessão: salvar trackers
                const manager1 = createSettingsManager({
                    store: sharedStore,
                    getDownloadsPath: () => FAKE_DOWNLOADS_PATH,
                });
                for (const url of trackerList) {
                    manager1.addGlobalTracker(url);
                }

                // Segunda sessão: recriar com o mesmo store
                const manager2 = createSettingsManager({
                    store: sharedStore,
                    getDownloadsPath: () => FAKE_DOWNLOADS_PATH,
                });

                expect(manager2.getGlobalTrackers()).toEqual(trackerList);
            }),
            { numRuns: 100 },
        );
    });
});

// ─── Property 11 ──────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';
import { createDownloadManager } from '../../main/downloadManager';
import type { TorrentEngine, TorrentInfo, TorrentStatus } from '../../main/torrentEngine';
import { existsSync, accessSync } from 'fs';

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(),
    accessSync: jest.fn(),
}));

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockAccessSync = accessSync as jest.MockedFunction<typeof accessSync>;

function makeMockTorrentInfo(infoHash: string): TorrentInfo {
    return {
        infoHash,
        name: infoHash,
        totalSize: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: Infinity,
        downloaded: 0,
        status: 'resolving-metadata' as TorrentStatus,
    };
}

function makeMockEngine(infoHash: string): TorrentEngine & EventEmitter {
    const emitter = new EventEmitter();
    const info = makeMockTorrentInfo(infoHash);

    const engine: TorrentEngine & EventEmitter = Object.assign(emitter, {
        addTorrentFile: jest.fn().mockResolvedValue(info),

        detachTorrent: jest.fn().mockResolvedValue(undefined),

        getTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn().mockResolvedValue(info),
        addMagnetLink: jest.fn().mockResolvedValue(info),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        setDownloadSpeedLimit: jest.fn(),
        setUploadSpeedLimit: jest.fn(),
        getAll: jest.fn().mockReturnValue([]),
        getFiles: jest.fn().mockReturnValue([]),
        setFileSelection: jest.fn().mockReturnValue([]),
        getTrackers: jest.fn().mockReturnValue([]),
        addTracker: jest.fn(),
        removeTracker: jest.fn(),
        restart: jest.fn().mockResolvedValue(undefined),
        isRestarting: jest.fn().mockReturnValue(false),
        healthCheck: jest.fn().mockReturnValue({
            healthy: true,
            restarting: false,
            activeTorrents: 0,
            totalPeers: 0,
            uptimeMs: 0,
        }),
        getMetadata: jest.fn().mockReturnValue({
            infoHash: 'a'.repeat(40),
            creator: null,
            comment: null,
            creationDate: null,
        }),
        getPeers: jest.fn().mockReturnValue([]),
        getPieces: jest.fn().mockReturnValue([]),
    });

    return engine;
}

// Feature: meshy-torrent-client, Property 11: Novos downloads usam a pasta de destino atual
describe('Property 11: Novos downloads usam a pasta de destino atual', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        // Folder validation: simulate valid (existing + writable) folder
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    // **Validates: Requirements 5.2**
    it('downloads iniciados após set({destinationFolder}) usam o valor configurado', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1 }).filter((s) => !s.includes('\0')),
                async (folder) => {
                    const settingsManager = makeManager();
                    settingsManager.set({ destinationFolder: folder });

                    // Each iteration creates a fresh DownloadManager so no duplicate issues
                    const infoHash = 'a'.repeat(40);
                    const engine = makeMockEngine(infoHash);
                    const magnetUri = `magnet:?xt=urn:btih:${infoHash}`;

                    const silentLogger = {
                        info: () => {},
                        warn: () => {},
                        error: () => {},
                        debug: () => {},
                    };

                    const downloadManager = createDownloadManager(
                        engine,
                        settingsManager,
                        undefined,
                        silentLogger,
                        { disableCleanupTimer: true },
                    );
                    const item = await downloadManager.addMagnetLink(magnetUri);

                    expect(item.destinationFolder).toBe(folder);

                    // Clear metadata timeout to prevent open handles
                    jest.runAllTimers();
                },
            ),
            { numRuns: 100 },
        );
    });
});

// ─── Property 12 ──────────────────────────────────────────────────────────────

// Feature: meshy-torrent-client, Property 12: Pasta inválida resulta em erro antes de iniciar download
describe('Property 12: Pasta inválida resulta em erro antes de iniciar download', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    // **Validates: Requirements 5.4**
    it('pasta que não existe ou sem permissão de escrita resulta em erro sem iniciar transferência', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1 }).filter((s) => !s.includes('\0')),
                fc.oneof(
                    fc.constant('non-existent' as const),
                    fc.constant('non-writable' as const),
                ),
                async (folder, failureMode) => {
                    // Configure fs mocks based on failure mode
                    if (failureMode === 'non-existent') {
                        mockExistsSync.mockReturnValue(false);
                        mockAccessSync.mockReturnValue(undefined);
                    } else {
                        // Folder exists but is not writable
                        mockExistsSync.mockReturnValue(true);
                        mockAccessSync.mockImplementation(() => {
                            throw new Error('EACCES: permission denied');
                        });
                    }

                    const settingsManager = makeManager();
                    settingsManager.set({ destinationFolder: folder });

                    const infoHash = 'a'.repeat(40);
                    const engine = makeMockEngine(infoHash);
                    const magnetUri = `magnet:?xt=urn:btih:${infoHash}`;

                    const silentLogger = {
                        info: () => {},
                        warn: () => {},
                        error: () => {},
                        debug: () => {},
                    };

                    const downloadManager = createDownloadManager(
                        engine,
                        settingsManager,
                        undefined,
                        silentLogger,
                        { disableCleanupTimer: true },
                    );

                    // Attempting to add a download with an invalid folder should throw
                    await expect(downloadManager.addMagnetLink(magnetUri)).rejects.toThrow(
                        'Pasta inválida ou sem permissão de escrita',
                    );

                    // The engine should NOT have been called — transfer was not started
                    expect(engine.addMagnetLink).not.toHaveBeenCalled();

                    // No items should be in the download list
                    expect(downloadManager.getAll()).toHaveLength(0);

                    // Clear any pending timers
                    jest.runAllTimers();
                },
            ),
            { numRuns: 100 },
        );
    });
});

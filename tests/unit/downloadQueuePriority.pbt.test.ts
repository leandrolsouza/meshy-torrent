/**
 * Testes de propriedade (PBT) para a feature de prioridade na fila de downloads.
 *
 * Propriedades backend (node environment):
 *   - Property 1: Reordenação preserva todos os itens e posiciona corretamente
 *   - Property 2: Inputs inválidos para reordenação retornam erro
 *   - Property 7: Round-trip de persistência da ordem da fila
 *   - Property 8: getAll enriquece itens enfileirados com queuePosition correto
 *
 * Usa fast-check com mínimo de 100 iterações por propriedade.
 */

import { EventEmitter } from 'events';
import fc from 'fast-check';
import { createDownloadManager } from '../../main/downloadManager';
import type { TorrentEngine, TorrentInfo, TorrentStatus } from '../../main/torrentEngine';
import type { SettingsManager } from '../../main/settingsManager';
import type { PersistedDownloadItem, PersistedStore } from '../../main/downloadManager';

// ─── FS Mocks ─────────────────────────────────────────────────────────────────

import { existsSync, accessSync } from 'fs';

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(),
    accessSync: jest.fn(),
}));

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockAccessSync = accessSync as jest.MockedFunction<typeof accessSync>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHash(index: number): string {
    return index.toString(16).padStart(40, '0');
}

function makeTorrentInfo(overrides: Partial<TorrentInfo> = {}): TorrentInfo {
    return {
        infoHash: 'a'.repeat(40),
        name: 'Default Torrent',
        totalSize: 1_000_000,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: Infinity,
        downloaded: 0,
        status: 'downloading' as TorrentStatus,
        ...overrides,
    };
}

function makeMockEngine(): TorrentEngine & EventEmitter {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
        addTorrentFile: jest.fn(),

        detachTorrent: jest.fn().mockResolvedValue(undefined),

        getTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn(),
        addMagnetLink: jest.fn(),
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
}

function makeMockSettings(folder = '/downloads'): SettingsManager {
    return {
        get: jest.fn().mockReturnValue({
            destinationFolder: folder,
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 1,
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            globalTrackers: [],
            autoApplyGlobalTrackers: false,
        }),
        set: jest.fn(),
        getDefaultDownloadFolder: jest.fn().mockReturnValue(folder),
        getGlobalTrackers: jest.fn().mockReturnValue([]),
        addGlobalTracker: jest.fn(),
        removeGlobalTracker: jest.fn(),
        setAutoApplyGlobalTrackers: jest.fn(),
    } as unknown as SettingsManager;
}

function makeMockStore(initial: PersistedDownloadItem[] = []): PersistedStore {
    const data = new Map<string, unknown>();
    if (initial.length > 0) {
        data.set('downloads', initial);
    }
    return {
        get: jest.fn().mockImplementation((key: string) => data.get(key)),
        set: jest.fn().mockImplementation((key: string, value: unknown) => {
            data.set(key, value);
        }),
    };
}

/**
 * Cria um DownloadManager com N itens enfileirados.
 * O primeiro item adicionado ocupa o slot ativo (downloading),
 * os demais ficam na fila (queued).
 */
async function createManagerWithQueuedItems(
    count: number,
    engine: TorrentEngine & EventEmitter,
    settings: SettingsManager,
    store?: PersistedStore,
): Promise<ReturnType<typeof createDownloadManager>> {
    const manager = createDownloadManager(engine, settings, store, undefined, {
        disableCleanupTimer: true,
    });

    // Primeiro item ocupa o slot ativo
    const firstHash = makeHash(0);
    const firstInfo = makeTorrentInfo({
        infoHash: firstHash,
        name: 'Torrent 0',
        status: 'downloading' as TorrentStatus,
    });
    (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(firstInfo);
    await manager.addTorrentFile('/path/to/file0.torrent');

    // Demais itens ficam na fila
    for (let i = 1; i <= count; i++) {
        const hash = makeHash(i);
        const info = makeTorrentInfo({
            infoHash: hash,
            name: `Torrent ${i}`,
            status: 'downloading' as TorrentStatus,
        });
        (engine.addTorrentFile as jest.Mock).mockResolvedValueOnce(info);
        await manager.addTorrentFile(`/path/to/file${i}.torrent`);
    }

    return manager;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    mockAccessSync.mockReturnValue(undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 1: Reordenação preserva todos os itens e posiciona corretamente
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature: download-queue-priority, Property 1: Reordenação preserva todos os itens e posiciona corretamente', () => {
    /**
     * **Validates: Requirements 1.1**
     *
     * Para qualquer fila de 2–20 itens, escolher item aleatório e newIndex válido,
     * chamar reorderQueue, verificar que o array retornado contém os mesmos
     * infoHashes e o item movido está na posição correta.
     */
    it('reorderQueue preserva todos os itens e posiciona o item movido corretamente', async () => {
        // Gerar tamanho da fila entre 2 e 20
        const queueSizeArb = fc.integer({ min: 2, max: 20 });

        await fc.assert(
            fc.asyncProperty(queueSizeArb, async (queueSize) => {
                const engine = makeMockEngine();
                const settings = makeMockSettings();
                const manager = await createManagerWithQueuedItems(queueSize, engine, settings);

                const originalOrder = manager.getQueueOrder();
                expect(originalOrder).toHaveLength(queueSize);

                // Escolher item aleatório e newIndex válido
                const itemIdx = Math.floor(Math.random() * queueSize);
                const newIdx = Math.floor(Math.random() * queueSize);
                const movedHash = originalOrder[itemIdx];

                const result = manager.reorderQueue(movedHash, newIdx);

                // Verificar que contém os mesmos infoHashes (sem duplicatas, sem perdas)
                expect(result).toHaveLength(queueSize);
                expect(new Set(result).size).toBe(queueSize);
                for (const hash of originalOrder) {
                    expect(result).toContain(hash);
                }

                // Verificar que o item movido está na posição correta
                expect(result[newIdx]).toBe(movedHash);
            }),
            { numRuns: 100 },
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 2: Inputs inválidos para reordenação retornam erro
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature: download-queue-priority, Property 2: Inputs inválidos retornam erro apropriado', () => {
    /**
     * **Validates: Requirements 1.2, 1.3, 1.5**
     *
     * Gerar infoHash inexistente, newIndex fora dos limites (negativo, >= tamanho),
     * verificar que reorderQueue lança erro.
     */
    it('infoHash inexistente lança erro', async () => {
        const nonExistentHashArb = fc.string({
            unit: fc.constantFrom(...'0123456789abcdef'),
            minLength: 40,
            maxLength: 40,
        });

        await fc.assert(
            fc.asyncProperty(nonExistentHashArb, async (fakeHash) => {
                const engine = makeMockEngine();
                const settings = makeMockSettings();
                const manager = await createManagerWithQueuedItems(3, engine, settings);

                const queueOrder = manager.getQueueOrder();
                // Garantir que o hash gerado não está na fila
                if (queueOrder.includes(fakeHash)) return; // skip caso raro de colisão

                expect(() => manager.reorderQueue(fakeHash, 0)).toThrow(
                    'Item não encontrado na fila',
                );
            }),
            { numRuns: 100 },
        );
    });

    it('newIndex negativo lança erro', async () => {
        const negativeIndexArb = fc.integer({ min: -1000, max: -1 });

        await fc.assert(
            fc.asyncProperty(negativeIndexArb, async (negIdx) => {
                const engine = makeMockEngine();
                const settings = makeMockSettings();
                const manager = await createManagerWithQueuedItems(3, engine, settings);

                const hash = manager.getQueueOrder()[0];
                expect(() => manager.reorderQueue(hash, negIdx)).toThrow(
                    'Posição inválida na fila',
                );
            }),
            { numRuns: 100 },
        );
    });

    it('newIndex >= tamanho da fila lança erro', async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 2, max: 10 }), async (queueSize) => {
                const engine = makeMockEngine();
                const settings = makeMockSettings();
                const manager = await createManagerWithQueuedItems(queueSize, engine, settings);

                const hash = manager.getQueueOrder()[0];
                // newIndex exatamente igual ao tamanho
                expect(() => manager.reorderQueue(hash, queueSize)).toThrow(
                    'Posição inválida na fila',
                );
                // newIndex maior que o tamanho
                expect(() => manager.reorderQueue(hash, queueSize + 10)).toThrow(
                    'Posição inválida na fila',
                );
            }),
            { numRuns: 100 },
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 7: Round-trip de persistência da ordem da fila
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature: download-queue-priority, Property 7: Round-trip de persistência da ordem da fila', () => {
    /**
     * **Validates: Requirements 6.1, 6.2, 6.3**
     *
     * Gerar ordens de fila aleatórias, criar DownloadManager com itens queued
     * nessa ordem, chamar persistSession() e restoreSession(), verificar que
     * getQueueOrder() retorna a mesma sequência.
     */
    it('persistSession + restoreSession preserva a ordem da fila', async () => {
        // Gerar array de 2–10 infoHashes únicos (40 chars hex)
        const queueArb = fc
            .integer({ min: 2, max: 10 })
            .chain((size) =>
                fc.tuple(...Array.from({ length: size }, (_, i) => fc.constant(makeHash(i + 1)))),
            );

        await fc.assert(
            fc.asyncProperty(queueArb, async (hashes) => {
                const queueSize = hashes.length;

                // Criar store compartilhado
                const store = makeMockStore();
                const engine = makeMockEngine();
                const settings = makeMockSettings();

                // Criar manager e adicionar itens
                const manager = await createManagerWithQueuedItems(
                    queueSize,
                    engine,
                    settings,
                    store,
                );

                const originalOrder = manager.getQueueOrder();
                expect(originalOrder).toHaveLength(queueSize);

                // Embaralhar a fila: mover cada item para posição aleatória
                for (let i = 0; i < queueSize; i++) {
                    const currentOrder = manager.getQueueOrder();
                    const randomItemIdx = Math.floor(Math.random() * queueSize);
                    const randomNewIdx = Math.floor(Math.random() * queueSize);
                    manager.reorderQueue(currentOrder[randomItemIdx], randomNewIdx);
                }

                const orderBefore = manager.getQueueOrder();

                // Persistir
                manager.persistSession();

                // Restaurar em novo manager
                const engine2 = makeMockEngine();
                const manager2 = createDownloadManager(engine2, settings, store, undefined, {
                    disableCleanupTimer: true,
                });
                await manager2.restoreSession();

                const orderAfter = manager2.getQueueOrder();
                expect(orderAfter).toEqual(orderBefore);
            }),
            { numRuns: 100 },
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Property 8: getAll enriquece itens enfileirados com queuePosition correto
// ═══════════════════════════════════════════════════════════════════════════════

describe('Feature: download-queue-priority, Property 8: getAll enriquece com queuePosition correto', () => {
    /**
     * **Validates: Requirements 7.3**
     *
     * Gerar conjuntos de downloads com status variados e fila ordenada,
     * chamar getAll(), verificar que queuePosition é índice + 1 para itens
     * queued e undefined para outros.
     */
    it('getAll retorna queuePosition correto para queued e undefined para outros', async () => {
        const queueSizeArb = fc.integer({ min: 2, max: 10 });

        await fc.assert(
            fc.asyncProperty(queueSizeArb, async (queueSize) => {
                const engine = makeMockEngine();
                const settings = makeMockSettings();
                const manager = await createManagerWithQueuedItems(queueSize, engine, settings);

                // Embaralhar a fila
                const currentOrder = manager.getQueueOrder();
                if (currentOrder.length >= 2) {
                    const randomIdx = Math.floor(Math.random() * currentOrder.length);
                    const randomNewIdx = Math.floor(Math.random() * currentOrder.length);
                    manager.reorderQueue(currentOrder[randomIdx], randomNewIdx);
                }

                const all = manager.getAll();
                const queueOrder = manager.getQueueOrder();

                for (const item of all) {
                    const queueIdx = queueOrder.indexOf(item.infoHash);
                    if (item.status === 'queued') {
                        // Itens queued devem ter queuePosition = índice + 1
                        expect(queueIdx).toBeGreaterThanOrEqual(0);
                        expect(item.queuePosition).toBe(queueIdx + 1);
                    } else {
                        // Itens não-queued devem ter queuePosition undefined
                        expect(item.queuePosition).toBeUndefined();
                    }
                }
            }),
            { numRuns: 100 },
        );
    });
});

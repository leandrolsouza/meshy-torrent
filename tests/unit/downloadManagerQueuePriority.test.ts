/**
 * Testes unitários para reordenação de fila de downloads no DownloadManager.
 *
 * Cobre:
 *   - reorderQueue: mover para cima, para baixo, para extremidades, erros
 *   - getQueueOrder: retorna cópia do array
 *   - getAll: enriquecimento com queuePosition
 *   - persistSession: salva itens queued na ordem da fila
 *   - restoreSession: reconstrói a fila na ordem persistida
 *
 * _Requisitos: 1.1, 1.2, 1.3, 6.1, 6.2, 6.3, 7.3_
 */

import { EventEmitter } from 'events';
import { createDownloadManager } from '../../main/downloadManager';
import type { TorrentEngine, TorrentInfo, TorrentStatus } from '../../main/torrentEngine';
import type { SettingsManager } from '../../main/settingsManager';
import type {
    DownloadItem,
    PersistedDownloadItem,
    PersistedStore,
} from '../../main/downloadManager';

// ─── FS Mocks (hoisted by Jest) ───────────────────────────────────────────────

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

    const engine: TorrentEngine & EventEmitter = Object.assign(emitter, {
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

    return engine;
}

function makeMockSettings(folder = '/downloads'): SettingsManager {
    return {
        get: jest.fn().mockReturnValue({
            destinationFolder: folder,
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 1, // Limite baixo para forçar enfileiramento
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
        name: `Torrent 0`,
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DownloadManager — reorderQueue', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('move item para baixo na fila (posição 0 → 2)', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        // Fila inicial: [hash1, hash2, hash3]
        expect(manager.getQueueOrder()).toEqual([hash1, hash2, hash3]);

        // Mover hash1 para posição 2 (última)
        const result = manager.reorderQueue(hash1, 2);

        expect(result).toEqual([hash2, hash3, hash1]);
    });

    it('move item para cima na fila (posição 2 → 0)', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        // Mover hash3 para posição 0 (primeira)
        const result = manager.reorderQueue(hash3, 0);

        expect(result).toEqual([hash3, hash1, hash2]);
    });

    it('move item para a mesma posição (sem alteração)', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        // Mover hash2 para posição 1 (mesma posição)
        const result = manager.reorderQueue(hash2, 1);

        expect(result).toEqual([hash1, hash2, hash3]);
    });

    it('move item do meio para a primeira posição', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        const result = manager.reorderQueue(hash2, 0);

        expect(result).toEqual([hash2, hash1, hash3]);
    });

    it('move item do meio para a última posição', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        const result = manager.reorderQueue(hash2, 2);

        expect(result).toEqual([hash1, hash3, hash2]);
    });

    it('emite evento update com queuePosition atualizado', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push({ ...item }));

        const hash3 = makeHash(3);
        manager.reorderQueue(hash3, 0);

        // Deve ter emitido update para o item movido
        const moveUpdate = updates.find((u) => u.infoHash === hash3);
        expect(moveUpdate).toBeDefined();
        expect(moveUpdate!.queuePosition).toBe(1); // posição 0 → queuePosition 1
    });

    it('retorna cópia do array (não referência direta)', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(2, engine, settings);

        const hash1 = makeHash(1);
        const result = manager.reorderQueue(hash1, 1);

        // Modificar o resultado não deve afetar a fila interna
        result.push('fake-hash');
        expect(manager.getQueueOrder()).toHaveLength(2);
    });

    it('lança erro para infoHash inexistente na fila', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(2, engine, settings);

        expect(() => manager.reorderQueue('x'.repeat(40), 0)).toThrow(
            'Item não encontrado na fila',
        );
    });

    it('lança erro para newIndex negativo', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(2, engine, settings);

        const hash1 = makeHash(1);
        expect(() => manager.reorderQueue(hash1, -1)).toThrow('Posição inválida na fila');
    });

    it('lança erro para newIndex >= tamanho da fila', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(2, engine, settings);

        const hash1 = makeHash(1);
        expect(() => manager.reorderQueue(hash1, 2)).toThrow('Posição inválida na fila');
    });
});

// ─── getQueueOrder ────────────────────────────────────────────────────────────

describe('DownloadManager — getQueueOrder', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('retorna cópia do array queue', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const order1 = manager.getQueueOrder();
        const order2 = manager.getQueueOrder();

        // Devem ser iguais em conteúdo
        expect(order1).toEqual(order2);

        // Mas não a mesma referência
        expect(order1).not.toBe(order2);

        // Modificar a cópia não afeta a fila interna
        order1.push('fake');
        expect(manager.getQueueOrder()).toHaveLength(3);
    });

    it('retorna array vazio quando não há itens na fila', () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, undefined, {
            disableCleanupTimer: true,
        });

        expect(manager.getQueueOrder()).toEqual([]);
    });
});

// ─── getAll com queuePosition ─────────────────────────────────────────────────

describe('DownloadManager — getAll com queuePosition', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('retorna queuePosition correto para itens enfileirados', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        const all = manager.getAll();

        const item1 = all.find((i) => i.infoHash === hash1);
        const item2 = all.find((i) => i.infoHash === hash2);
        const item3 = all.find((i) => i.infoHash === hash3);

        expect(item1?.queuePosition).toBe(1);
        expect(item2?.queuePosition).toBe(2);
        expect(item3?.queuePosition).toBe(3);
    });

    it('retorna queuePosition undefined para itens não-enfileirados', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(2, engine, settings);

        const hash0 = makeHash(0); // item ativo (downloading)
        const all = manager.getAll();

        const activeItem = all.find((i) => i.infoHash === hash0);
        expect(activeItem?.queuePosition).toBeUndefined();
    });

    it('atualiza queuePosition após reordenação', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = await createManagerWithQueuedItems(3, engine, settings);

        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        // Mover hash3 para primeira posição
        manager.reorderQueue(hash3, 0);

        const all = manager.getAll();

        const item1 = all.find((i) => i.infoHash === hash1);
        const item2 = all.find((i) => i.infoHash === hash2);
        const item3 = all.find((i) => i.infoHash === hash3);

        expect(item3?.queuePosition).toBe(1);
        expect(item1?.queuePosition).toBe(2);
        expect(item2?.queuePosition).toBe(3);
    });
});

// ─── persistSession com ordem da fila ─────────────────────────────────────────

describe('DownloadManager — persistSession com ordem da fila', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('salva itens queued na ordem da fila', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const store = makeMockStore();
        const manager = await createManagerWithQueuedItems(3, engine, settings, store);

        const hash1 = makeHash(1);
        const hash3 = makeHash(3);

        // Reordenar: mover hash3 para primeira posição
        manager.reorderQueue(hash3, 0);

        // Persistir
        manager.persistSession();

        // Verificar que o store.set foi chamado com os itens queued na ordem correta
        const setCalls = (store.set as jest.Mock).mock.calls;
        const downloadsCall = setCalls.find((call: [string, unknown]) => call[0] === 'downloads');
        expect(downloadsCall).toBeDefined();

        const persisted = downloadsCall![1] as PersistedDownloadItem[];
        const queuedItems = persisted.filter((p) => p.status === 'queued');

        // A ordem dos queued deve ser: hash3, hash1, hash2
        expect(queuedItems[0].infoHash).toBe(hash3);
        expect(queuedItems[1].infoHash).toBe(hash1);
        expect(queuedItems[2].infoHash).toBe(makeHash(2));
    });

    it('itens não-queued mantêm sua posição', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const store = makeMockStore();
        const manager = await createManagerWithQueuedItems(2, engine, settings, store);

        const hash0 = makeHash(0); // downloading

        manager.persistSession();

        const setCalls = (store.set as jest.Mock).mock.calls;
        const downloadsCall = setCalls.find((call: [string, unknown]) => call[0] === 'downloads');
        const persisted = downloadsCall![1] as PersistedDownloadItem[];

        // O item ativo deve estar presente
        const activeItem = persisted.find((p) => p.infoHash === hash0);
        expect(activeItem).toBeDefined();
        expect(activeItem!.status).toBe('downloading');
    });
});

// ─── restoreSession reconstrói a fila ─────────────────────────────────────────

describe('DownloadManager — restoreSession reconstrói a fila', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('reconstrói a fila na ordem persistida', async () => {
        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        // Simular dados persistidos com itens queued em ordem específica
        const persisted: PersistedDownloadItem[] = [
            {
                infoHash: hash3,
                name: 'Torrent 3',
                totalSize: 1_000_000,
                downloadedSize: 0,
                progress: 0,
                status: 'queued',
                destinationFolder: '/downloads',
                addedAt: Date.now(),
            },
            {
                infoHash: hash1,
                name: 'Torrent 1',
                totalSize: 1_000_000,
                downloadedSize: 0,
                progress: 0,
                status: 'queued',
                destinationFolder: '/downloads',
                addedAt: Date.now(),
            },
            {
                infoHash: hash2,
                name: 'Torrent 2',
                totalSize: 1_000_000,
                downloadedSize: 0,
                progress: 0,
                status: 'queued',
                destinationFolder: '/downloads',
                addedAt: Date.now(),
            },
        ];

        const store = makeMockStore(persisted);
        const engine = makeMockEngine();
        // maxConcurrentDownloads alto para não iniciar downloads automaticamente
        // Na verdade, precisamos que nenhum item ativo exista para que os queued
        // permaneçam na fila. Com maxConcurrent=1, o primeiro queued será promovido.
        // Vamos usar maxConcurrent alto para que todos sejam promovidos... não.
        // Queremos que fiquem queued. Vamos usar maxConcurrent=0... não existe.
        // O restoreSession com queued items os mantém na fila sem promover.
        // Vamos verificar: restoreSession para status 'queued' faz queue.push sem resume.
        const settings = makeMockSettings();

        const manager = createDownloadManager(engine, settings, store, undefined, {
            disableCleanupTimer: true,
        });

        await manager.restoreSession();

        // A fila deve estar na ordem: hash3, hash1, hash2
        expect(manager.getQueueOrder()).toEqual([hash3, hash1, hash2]);
    });

    it('round-trip: persistSession → restoreSession preserva a ordem da fila', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const store = makeMockStore();
        const manager = await createManagerWithQueuedItems(3, engine, settings, store);

        const hash1 = makeHash(1);
        const hash2 = makeHash(2);
        const hash3 = makeHash(3);

        // Reordenar
        manager.reorderQueue(hash3, 0);
        const orderBefore = manager.getQueueOrder();
        expect(orderBefore).toEqual([hash3, hash1, hash2]);

        // Persistir
        manager.persistSession();

        // Criar novo manager e restaurar
        const engine2 = makeMockEngine();
        const manager2 = createDownloadManager(engine2, settings, store, undefined, {
            disableCleanupTimer: true,
        });
        await manager2.restoreSession();

        // A ordem deve ser preservada
        expect(manager2.getQueueOrder()).toEqual([hash3, hash1, hash2]);
    });
});

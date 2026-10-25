/**
 * Testes para os caminhos de erro corrigidos em main/downloadManager.ts.
 *
 * Cobre os blocos catch adicionados/corrigidos nas tarefas 8.1 e 8.2:
 *   - _startMetadataTimer: bloco catch interno (engine.pause falha → logger.warn)
 *   - _startMetadataTimer: bloco catch externo (erro inesperado → logger.error)
 *   - pause(): revert de status quando engine.pause falha
 *   - resume(): status → 'error' quando engine.resume falha
 *   - _processQueue(): status → 'error' + logger.error quando addMagnetLink falha
 *   - remove(): preserva o item e comunica falha quando engine.remove rejeita
 *
 * _Requisitos: 6.5, 6.6_
 */

import { EventEmitter } from 'events';

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(),
    accessSync: jest.fn(),
}));

import { existsSync, accessSync } from 'fs';
import { createDownloadManager } from '../../main/downloadManager';
import type { TorrentEngine, TorrentInfo, TorrentStatus } from '../../main/torrentEngine';
import type { SettingsManager } from '../../main/settingsManager';
import type { DownloadItem, PersistedStore } from '../../main/downloadManager';
import type { Logger } from '../../main/logger';

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockAccessSync = accessSync as jest.MockedFunction<typeof accessSync>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const VALID_MAGNET = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
const INFO_HASH = 'a'.repeat(40);

function makeTorrentInfo(overrides: Partial<TorrentInfo> = {}): TorrentInfo {
    return {
        infoHash: INFO_HASH,
        name: INFO_HASH,
        totalSize: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: Infinity,
        downloaded: 0,
        status: 'resolving-metadata' as TorrentStatus,
        ...overrides,
    };
}

/**
 * Cria um mock de TorrentEngine como EventEmitter para que os testes
 * possam emitir eventos 'progress', 'done' e 'error' manualmente.
 */
function makeMockEngine(magnetInfo: TorrentInfo = makeTorrentInfo()): TorrentEngine & EventEmitter {
    const emitter = new EventEmitter();

    return Object.assign(emitter, {
        addTorrentFile: jest.fn(),
        detachTorrent: jest.fn().mockResolvedValue(undefined),
        getTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn(),
        addMagnetLink: jest.fn().mockResolvedValue(magnetInfo),
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
    }) as TorrentEngine & EventEmitter;
}

function makeMockSettings(folder = '/downloads'): SettingsManager {
    return {
        get: jest.fn().mockReturnValue({
            destinationFolder: folder,
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 3,
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

/** Cria um mock de Logger com todos os métodos rastreados por jest.fn(). */
function makeMockLogger(): Logger {
    return {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
}

describe('DownloadManager — persistência durante erros da engine', () => {
    const secondHash = 'b'.repeat(40);
    const thirdHash = 'c'.repeat(40);

    async function setup(withDiskSpace = false) {
        const data = new Map<string, unknown>();
        const store: PersistedStore = {
            get: jest.fn().mockImplementation((key: string) => data.get(key)),
            set: jest.fn((key: string, value: unknown) => data.set(key, value)),
        };
        const engine = makeMockEngine();
        jest.mocked(engine.addMagnetLink).mockImplementation(async (magnetUri) =>
            makeTorrentInfo({
                infoHash: magnetUri.match(/btih:([a-f0-9]{40})/)![1]!,
                status: 'downloading',
            }),
        );
        const settings = makeMockSettings();
        jest.mocked(settings.get).mockReturnValue({
            ...settings.get(),
            maxConcurrentDownloads: 1,
        });
        const log = makeMockLogger();
        const manager = createDownloadManager(engine, settings, store, log, {
            disableCleanupTimer: true,
            ...(withDiskSpace
                ? {
                      diskSpace: {
                          inspect: jest.fn().mockResolvedValue({
                              freeBytes: 10 ** 12,
                              selectedBytes: 0,
                              reservedBytes: 0,
                              safetyMarginBytes: 0,
                              sufficient: true,
                          }),
                      },
                  }
                : {}),
        });
        await manager.addMagnetLink(VALID_MAGNET);
        await manager.addMagnetLink(`magnet:?xt=urn:btih:${secondHash}`);
        await manager.addMagnetLink(`magnet:?xt=urn:btih:${thirdHash}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        manager.persistSession();
        const original = data.get('downloads');
        const storageError = Object.assign(new Error('ENOSPC: session write'), { code: 'ENOSPC' });
        jest.mocked(store.set).mockImplementation(() => {
            throw storageError;
        });
        return { manager, engine, store, log, data, original, storageError };
    }

    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    describe.each([
        { label: 'erro de rede', error: new Error('Falha de rede'), status: 'error' },
        {
            label: 'ENOSPC por código',
            error: Object.assign(new Error('Disco cheio'), { code: 'ENOSPC' }),
            status: 'paused',
        },
        { label: 'ENOSPC na mensagem', error: new Error('write ENOSPC'), status: 'paused' },
    ])('$label', ({ error, status }) => {
        it.each([false, true])(
            'continua a fila e encaminha o erro mesmo sem conseguir salvar (disco=%s)',
            async (withDiskSpace) => {
                const { manager, engine, log, data, original } = await setup(withDiskSpace);
                const forwardError = jest.fn();
                engine.on('error', forwardError);
                expect(() => engine.emit('error', INFO_HASH, error)).not.toThrow();
                await new Promise<void>((resolve) => setImmediate(resolve));

                expect(forwardError).toHaveBeenCalledWith(INFO_HASH, error);
                expect(manager.getAll().find((item) => item.infoHash === INFO_HASH)).toMatchObject({
                    status,
                    ...(status === 'paused' ? { pauseReason: 'disk-space' } : {}),
                });
                expect(manager.getAll().find((item) => item.infoHash === secondHash)?.status).toBe(
                    'downloading',
                );
                expect(manager.getQueueOrder()).toEqual([thirdHash]);
                expect(engine.addMagnetLink).toHaveBeenCalledTimes(2);
                if (status === 'paused') expect(engine.pause).toHaveBeenCalledWith(INFO_HASH);
                expect(log.warn).toHaveBeenCalledWith(
                    '[DownloadManager] Falha ao persistir sessão após erro da engine:',
                    'ENOSPC',
                );
                expect(data.get('downloads')).toEqual(original);
            },
        );
    });

    it('mantém a falha explícita de persistSession para consumidores que exigem gravação', async () => {
        const { manager, storageError } = await setup();
        expect(() => manager.persistSession()).toThrow(storageError);
    });

    it('permite salvar o estado atualizado quando o armazenamento volta a funcionar', async () => {
        const { manager, engine, store, data } = await setup();
        expect(() => engine.emit('error', INFO_HASH, new Error('Falha de rede'))).not.toThrow();
        await new Promise<void>((resolve) => setImmediate(resolve));
        jest.mocked(store.set).mockImplementation((key, value) => {
            data.set(key, value);
        });
        manager.persistSession();
        expect(store.get('downloads')).toEqual([
            expect.objectContaining({ infoHash: INFO_HASH, status: 'error' }),
            expect.objectContaining({ infoHash: secondHash, status: 'downloading' }),
            expect.objectContaining({ infoHash: thirdHash, status: 'queued' }),
        ]);
    });
});

// ─── _startMetadataTimer — bloco catch interno (Requisitos 6.5, 6.6) ─────────

describe('DownloadManager._startMetadataTimer — bloco catch interno (Requisitos 6.5, 6.6)', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('NÃO emite metadata-failed quando engine.pause() lança durante o timer', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        // engine.pause lança ao ser chamado pelo timer de metadados
        (engine.pause as jest.Mock).mockRejectedValue(new Error('pause falhou'));

        const mockLog = makeMockLogger();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, mockLog, {
            disableCleanupTimer: true,
        });

        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push({ ...item }));

        await manager.addMagnetLink(VALID_MAGNET);

        // Avançar 60s para o timer de metadados disparar
        await jest.advanceTimersByTimeAsync(60_000);

        // Não deve ter emitido metadata-failed
        const metadataFailedUpdates = updates.filter((u) => u.status === 'metadata-failed');
        expect(metadataFailedUpdates).toHaveLength(0);
    });

    it('chama logger.warn quando engine.pause() lança durante o timer', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        (engine.pause as jest.Mock).mockRejectedValue(new Error('pause error'));

        const mockLog = makeMockLogger();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, mockLog, {
            disableCleanupTimer: true,
        });

        await manager.addMagnetLink(VALID_MAGNET);
        await jest.advanceTimersByTimeAsync(60_000);

        // logger.warn deve ter sido chamado com mensagem sobre falha ao suspender
        expect(mockLog.warn).toHaveBeenCalled();
        const warnArgs: unknown[][] = (mockLog.warn as jest.Mock).mock.calls;
        const suspendMessage = warnArgs.some((args) =>
            String(args[0]).includes('Falha ao suspender metadados'),
        );
        expect(suspendMessage).toBe(true);
    });

    it('emite metadata-failed quando engine.pause() resolve normalmente (comportamento padrão)', async () => {
        jest.useFakeTimers();

        const engine = makeMockEngine();
        // pause resolve (comportamento normal)
        (engine.pause as jest.Mock).mockResolvedValue(undefined);

        const mockLog = makeMockLogger();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, mockLog, {
            disableCleanupTimer: true,
        });

        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push({ ...item }));

        await manager.addMagnetLink(VALID_MAGNET);
        await jest.advanceTimersByTimeAsync(60_000);

        const metadataFailedUpdates = updates.filter((u) => u.status === 'metadata-failed');
        expect(metadataFailedUpdates).toHaveLength(1);
        // logger.warn NÃO deve ter sido chamado para falha de pause
        const warnArgs: unknown[][] = (mockLog.warn as jest.Mock).mock.calls;
        const pauseFailureLog = warnArgs.some((args) =>
            String(args[0]).includes('Falha ao suspender metadados'),
        );
        expect(pauseFailureLog).toBe(false);
    });
});

// ─── pause() — revert de status (Requisitos 6.5, 6.6) ────────────────────────

describe('DownloadManager.pause() — revert de status quando engine falha (Requisitos 6.5, 6.6)', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('reverte o status para downloading e lança o erro quando engine.pause falha', async () => {
        // Configurar engine para retornar status 'downloading' ao adicionar
        const engine = makeMockEngine(makeTorrentInfo({ status: 'downloading' }));
        (engine.addMagnetLink as jest.Mock).mockResolvedValue(
            makeTorrentInfo({ status: 'downloading' }),
        );

        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, undefined, {
            disableCleanupTimer: true,
        });

        await manager.addMagnetLink(VALID_MAGNET);

        // Configurar pause para falhar ao ser chamado pelo manager
        (engine.pause as jest.Mock).mockRejectedValue(new Error('engine pause error'));

        // manager.pause deve rejeitar
        await expect(manager.pause(INFO_HASH)).rejects.toThrow('engine pause error');

        // Status deve ter sido revertido para 'downloading' (não 'paused')
        const allItems = manager.getAll();
        expect(allItems).toHaveLength(1);
        expect(allItems[0].status).toBe('downloading');
    });

    it('emite evento update com o status original quando engine.pause falha', async () => {
        const engine = makeMockEngine(makeTorrentInfo({ status: 'downloading' }));
        (engine.addMagnetLink as jest.Mock).mockResolvedValue(
            makeTorrentInfo({ status: 'downloading' }),
        );

        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, undefined, {
            disableCleanupTimer: true,
        });

        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push({ ...item }));

        await manager.addMagnetLink(VALID_MAGNET);

        (engine.pause as jest.Mock).mockRejectedValue(new Error('engine pause error'));

        try {
            await manager.pause(INFO_HASH);
        } catch {
            // esperado
        }

        // O último evento update deve ter o status original
        const lastUpdate = updates[updates.length - 1];
        expect(lastUpdate.status).toBe('downloading');
    });
});

// ─── resume() — status error quando engine falha (Requisitos 6.5, 6.6) ────────

describe('DownloadManager.resume() — status error quando engine.resume falha (Requisitos 6.5, 6.6)', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('define status como error com errorMessage quando engine.resume lança (sem magnetUri)', async () => {
        const infoHash = 'b'.repeat(40);
        const engine = makeMockEngine(makeTorrentInfo({ infoHash, status: 'downloading' }));

        // addTorrentFile não armazena magnetUri — simula torrent adicionado via arquivo
        (engine.addTorrentFile as jest.Mock).mockResolvedValue(
            makeTorrentInfo({ infoHash, status: 'downloading' }),
        );

        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, undefined, {
            disableCleanupTimer: true,
        });

        // Adicionar via arquivo (sem magnetUri) → status 'downloading'
        await manager.addTorrentFile('/tmp/test.torrent');

        // Pausar com sucesso
        (engine.pause as jest.Mock).mockResolvedValue(undefined);
        await manager.pause(infoHash);

        // Configurar resume para falhar
        (engine.resume as jest.Mock).mockRejectedValue(new Error('resume falhou'));

        await expect(manager.resume(infoHash)).rejects.toThrow('resume falhou');

        const allItems = manager.getAll();
        expect(allItems).toHaveLength(1);
        expect(allItems[0].status).toBe('error');
        expect(allItems[0].errorMessage).toBe('resume falhou');
    });
});

// ─── _processQueue() — status error quando addMagnetLink falha (Requisitos 6.5, 6.6) ──

describe('DownloadManager._processQueue() — falha ao iniciar torrent da fila (Requisitos 6.5, 6.6)', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it('define status do item como error e chama logger.error quando addMagnetLink falha ao processar fila', async () => {
        // Configurar maxConcurrentDownloads = 1 para que o segundo torrent seja enfileirado
        const settings = makeMockSettings();
        (settings.get as jest.Mock).mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 1,
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
            notificationsEnabled: true,
            globalTrackers: [],
            autoApplyGlobalTrackers: false,
        });

        const firstHash = 'a'.repeat(40);
        const secondHash = 'b'.repeat(40);

        const engine = makeMockEngine();

        // Primeiro torrent adicionado com sucesso e começa a baixar
        (engine.addMagnetLink as jest.Mock).mockResolvedValueOnce(
            makeTorrentInfo({ infoHash: firstHash, status: 'downloading' }),
        );

        const mockLog = makeMockLogger();
        const manager = createDownloadManager(engine, settings, undefined, mockLog, {
            disableCleanupTimer: true,
        });

        const firstMagnet = `magnet:?xt=urn:btih:${firstHash}`;
        await manager.addMagnetLink(firstMagnet);

        // Segundo magnet enfileirado (sem slot)
        const secondMagnet = `magnet:?xt=urn:btih:${secondHash}`;
        // addMagnetLink ainda não foi chamado para o segundo (enfileirado diretamente)
        const secondItem = await manager.addMagnetLink(secondMagnet);
        expect(secondItem.status).toBe('queued');

        // Configurar engine.addMagnetLink para falhar quando o segundo for desfila
        (engine.addMagnetLink as jest.Mock).mockRejectedValueOnce(
            new Error('falha ao adicionar da fila'),
        );

        // Pausar o primeiro para liberar um slot e processar a fila
        (engine.pause as jest.Mock).mockResolvedValue(undefined);
        await manager.pause(firstHash);

        // Aguardar microtasks para que _processQueue processe o segundo item
        await Promise.resolve();
        await Promise.resolve();

        // O segundo item deve ter virado 'error'
        const allItems = manager.getAll();
        const secondItemAfter = allItems.find((i) => i.infoHash === secondHash);
        expect(secondItemAfter).toBeDefined();
        expect(secondItemAfter!.status).toBe('error');
        expect(secondItemAfter!.errorMessage).toBe('falha ao adicionar da fila');

        // logger.error deve ter sido chamado
        expect(mockLog.error).toHaveBeenCalled();
        const errorArgs: unknown[][] = (mockLog.error as jest.Mock).mock.calls;
        const queueMessage = errorArgs.some((args) =>
            String(args[0]).includes('Falha ao iniciar torrent da fila'),
        );
        expect(queueMessage).toBe(true);
    });
});

// ─── remove() — logger.warn quando engine.remove falha (Requisitos 6.5, 6.6) ──

describe('DownloadManager.remove() — recuperação quando engine.remove falha', () => {
    beforeEach(() => {
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    it.each([false, true])(
        'preserva o item e rejeita quando engine.remove falha (deleteFiles=%s)',
        async (deleteFiles) => {
            const engine = makeMockEngine(makeTorrentInfo({ status: 'downloading' }));
            (engine.addMagnetLink as jest.Mock).mockResolvedValue(
                makeTorrentInfo({ status: 'downloading' }),
            );

            // engine.remove lança ao ser chamado
            (engine.remove as jest.Mock).mockRejectedValue(new Error('engine remove error'));

            const mockLog = makeMockLogger();
            const settings = makeMockSettings();
            const manager = createDownloadManager(engine, settings, undefined, mockLog, {
                disableCleanupTimer: true,
            });

            await manager.addMagnetLink(VALID_MAGNET);
            expect(manager.getAll()).toHaveLength(1);

            await expect(manager.remove(INFO_HASH, deleteFiles)).rejects.toThrow(
                'engine remove error',
            );

            expect(manager.getAll()).toEqual([
                expect.objectContaining({ infoHash: INFO_HASH, status: 'error' }),
            ]);

            // logger.warn deve ter sido chamado com mensagem sobre falha ao remover do engine
            expect(mockLog.warn).toHaveBeenCalled();
            const warnArgs: unknown[][] = (mockLog.warn as jest.Mock).mock.calls;
            const removeFailMessage = warnArgs.some((args) =>
                String(args[0]).includes('Falha ao remover do engine'),
            );
            expect(removeFailMessage).toBe(true);
        },
    );

    it('só emite remove após uma nova tentativa bem-sucedida e ignora eventos tardios', async () => {
        const engine = makeMockEngine(makeTorrentInfo({ status: 'downloading' }));
        (engine.addMagnetLink as jest.Mock).mockResolvedValue(
            makeTorrentInfo({ status: 'downloading' }),
        );
        jest.mocked(engine.remove).mockImplementationOnce(async () => {
            engine.emit('done', INFO_HASH);
            engine.emit('progress', makeTorrentInfo({ status: 'downloading', progress: 1 }));
            engine.emit('error', INFO_HASH, new Error('Evento tardio'));
            throw new Error('engine remove error');
        });

        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, undefined, {
            disableCleanupTimer: true,
        });

        await manager.addMagnetLink(VALID_MAGNET);

        const removeEvents: string[] = [];
        manager.on('remove', (hash) => removeEvents.push(hash));
        const updates: DownloadItem[] = [];
        manager.on('update', (item) => updates.push(item));

        await expect(manager.remove(INFO_HASH, false)).rejects.toThrow('engine remove error');
        expect(removeEvents).toEqual([]);
        expect(manager.getAll()[0]).toMatchObject({ status: 'error', progress: 0 });
        expect(updates).toEqual([expect.objectContaining({ status: 'error', progress: 0 })]);

        await manager.remove(INFO_HASH, false);
        expect(removeEvents).toEqual([INFO_HASH]);
        expect(manager.getAll()).toEqual([]);
    });
});

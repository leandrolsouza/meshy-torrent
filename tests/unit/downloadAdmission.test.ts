import { EventEmitter } from 'events';
import { createDownloadManager } from '../../main/downloadManager';
import type { PersistedStore } from '../../main/downloadManager';
import type { TorrentEngine } from '../../main/torrentEngine';
import type { SettingsManager } from '../../main/settingsManager';
import type { PreparedTorrent } from '../../main/torrentPreparation';
import type { TorrentFileInfo, PersistedDownloadItem } from '../../shared/types';
import { createDiskSpaceService } from '../../main/diskSpace';
import type { VolumeSpace } from '../../main/diskSpace';
import { join } from 'path';

const folder = process.cwd();
const draft = (hash = 'a'.repeat(40), length = 600): PreparedTorrent => ({
    buffer: Buffer.from('d4:test4:datae'),
    magnetUri: `magnet:?xt=urn:btih:${hash}`,
    preview: {
        requestId: hash,
        infoHash: hash,
        name: 'Archive',
        files: [
            { index: 0, name: 'keep.bin', path: 'keep.bin', length, downloaded: 0, selected: true },
            {
                index: 1,
                name: 'skip.bin',
                path: 'skip.bin',
                length: 9999,
                downloaded: 0,
                selected: true,
            },
        ],
    },
});
function setup(
    free = 1000,
    max = 3,
    persisted?: PersistedDownloadItem[],
    readVolume?: (folder: string) => Promise<VolumeSpace>,
) {
    let freeBytes = free;
    const files = new Map<string, TorrentFileInfo[]>();
    let adds = 0;
    const engine = Object.assign(new EventEmitter(), {
        addTorrentBuffer: jest.fn(
            async (
                _buffer: Buffer,
                paused: boolean,
                options: { selectedFileIndices: number[] },
            ) => {
                const hash = ++adds === 1 ? 'a'.repeat(40) : 'b'.repeat(40);
                files.set(
                    hash,
                    draft(hash).preview.files.map((file) => ({
                        ...file,
                        selected: options.selectedFileIndices.includes(file.index),
                    })),
                );
                return {
                    infoHash: hash,
                    name: 'Archive',
                    totalSize: 10599,
                    downloaded: 0,
                    progress: 0,
                    status: paused ? 'paused' : 'downloading',
                    downloadSpeed: 0,
                    uploadSpeed: 0,
                    numPeers: 0,
                    numSeeders: 0,
                    timeRemaining: Infinity,
                };
            },
        ),
        getFiles: jest.fn((hash: string) => files.get(hash) ?? []),
        pause: jest.fn(async () => {}),
        resume: jest.fn(async () => {}),
        setFileSelection: jest.fn(),
        isRestarting: () => false,
    });
    const settings = {
        get: () => ({
            destinationFolder: folder,
            maxConcurrentDownloads: max,
            autoApplyGlobalTrackers: false,
        }),
    } as SettingsManager;
    const store = {
        get: (key: string) => (key === 'downloads' ? persisted : undefined),
        set: jest.fn(),
    };
    const diskSpace = createDiskSpaceService({
        safetyMarginBytes: 0,
        readVolume: readVolume ?? (async () => ({ volumeId: 'A', freeBytes })),
    });
    const manager = createDownloadManager(
        engine as unknown as TorrentEngine,
        settings,
        store as unknown as PersistedStore,
        undefined,
        { disableCleanupTimer: true, diskSpace },
    );
    return {
        manager,
        engine,
        store,
        setFree: (value: number) => {
            freeBytes = value;
        },
    };
}
test('bloqueia seleção vazia e falta de espaço antes de criar arquivos ou conexões da transferência', async () => {
    const { manager, engine } = setup(599);
    await expect(manager.addPreparedTorrent(draft(), folder, [])).rejects.toThrow('selectionEmpty');
    await expect(manager.addPreparedTorrent(draft(), folder, [0])).rejects.toThrow('diskSpaceLow');
    expect(engine.addTorrentBuffer).not.toHaveBeenCalled();
});
test('nasce pausado com destino e seleção confirmados e só depois retoma', async () => {
    const { manager, engine, store } = setup();
    const item = await manager.addPreparedTorrent(draft(), folder, [0]);
    expect(engine.addTorrentBuffer).toHaveBeenCalledWith(draft().buffer, true, {
        destinationFolder: folder,
        selectedFileIndices: [0],
    });
    expect(item).toMatchObject({
        status: 'downloading',
        totalSize: 600,
        selectedFileCount: 1,
        totalFileCount: 2,
    });
    expect(engine.resume).toHaveBeenCalledTimes(1);
    expect(store.set).toHaveBeenCalledWith(
        'downloads',
        expect.arrayContaining([
            expect.objectContaining({ selectedFileIndices: [0], destinationFolder: folder }),
        ]),
    );
});
test('duas confirmações concorrentes não prometem os mesmos bytes livres', async () => {
    const { manager, engine } = setup();
    const results = await Promise.allSettled([
        manager.addPreparedTorrent(draft(), folder, [0]),
        manager.addPreparedTorrent(draft('b'.repeat(40)), folder, [0]),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(engine.addTorrentBuffer).toHaveBeenCalledTimes(1);
});
test('queda de espaço pausa sem excluir arquivos e impede retomada até liberar espaço', async () => {
    const { manager, engine, setFree } = setup();
    await manager.addPreparedTorrent(draft(), folder, [0]);
    setFree(100);
    await manager.checkDiskSpace();
    expect(manager.getAll()[0]).toMatchObject({
        status: 'paused',
        pauseReason: 'disk-space',
        errorMessage: 'error.destination.diskSpaceLow',
    });
    expect(engine.pause).toHaveBeenCalled();
    await expect(manager.resume('a'.repeat(40))).rejects.toThrow('diskSpaceLow');
    setFree(1000);
    await manager.resume('a'.repeat(40));
    expect(manager.getAll()[0]).toMatchObject({ status: 'downloading' });
    expect(manager.getAll()[0].pauseReason).toBeUndefined();
});
test('ENOSPC é uma pausa explícita que preserva a seleção e a sessão', async () => {
    const { manager, engine, store } = setup();
    await manager.addPreparedTorrent(draft(), folder, [0]);
    engine.emit(
        'error',
        'a'.repeat(40),
        Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' }),
    );
    expect(manager.getAll()[0]).toMatchObject({
        status: 'paused',
        pauseReason: 'disk-space',
        selectedFileCount: 1,
    });
    expect(store.set).toHaveBeenCalledWith(
        'downloads',
        expect.arrayContaining([
            expect.objectContaining({ pauseReason: 'disk-space', selectedFileIndices: [0] }),
        ]),
    );
});

test('a fila verifica novamente o espaço antes de ocupar um slot liberado', async () => {
    const { manager, engine, setFree } = setup(2000, 1);
    await manager.addPreparedTorrent(draft(), folder, [0]);
    const queued = await manager.addPreparedTorrent(draft('b'.repeat(40)), folder, [0]);
    expect(queued.status).toBe('queued');
    setFree(100);
    const blocked = new Promise<void>((resolve) => {
        manager.on('update', (item) => {
            if (item.infoHash === queued.infoHash && item.pauseReason === 'disk-space') resolve();
        });
    });
    await manager.pause('a'.repeat(40));
    await blocked;
    expect(engine.resume).toHaveBeenCalledTimes(1);
    expect(manager.getAll().find((item) => item.infoHash === queued.infoHash)).toMatchObject({
        status: 'paused',
        errorMessage: 'error.destination.diskSpaceLow',
    });
});

test('retomada após reiniciar preserva metadados, pasta e seleção da confirmação', async () => {
    const original = setup();
    await original.manager.addPreparedTorrent(draft(), folder, [0]);
    await original.manager.pause('a'.repeat(40));
    original.manager.persistSession();
    const savedCalls = original.store.set.mock.calls.filter(([key]) => key === 'downloads');
    const saved = savedCalls[savedCalls.length - 1]![1] as PersistedDownloadItem[];
    expect(saved[0]).toMatchObject({
        torrentFileBase64: draft().buffer.toString('base64'),
        selectedFileIndices: [0],
        destinationFolder: folder,
    });
    const restored = setup(1000, 3, saved);
    await restored.manager.restoreSession();
    expect(restored.engine.addTorrentBuffer).not.toHaveBeenCalled();
    restored.engine.resume.mockRejectedValueOnce(new Error('Torrent ausente no engine'));
    await restored.manager.resume('a'.repeat(40));
    expect(restored.engine.addTorrentBuffer).toHaveBeenCalledWith(draft().buffer, false, {
        destinationFolder: folder,
        selectedFileIndices: [0],
    });
    expect(restored.manager.getAll()[0]).toMatchObject({
        status: 'downloading',
        totalSize: 600,
        selectedFileCount: 1,
        totalFileCount: 2,
    });
});

describe('isolamento de falhas entre volumes', () => {
    const otherFolder = join(folder, 'main');
    function readVolumes() {
        let disconnected = false;
        return {
            disconnect: () => {
                disconnected = true;
            },
            readVolume: async (destination: string) => {
                if (destination === otherFolder && disconnected) throw new Error('ENODEV');
                return { volumeId: destination === otherFolder ? 'B' : 'A', freeBytes: 1000 };
            },
        };
    }

    test('permite confirmar um download saudável quando outro volume está indisponível', async () => {
        const volumes = readVolumes();
        const { manager, engine } = setup(1000, 3, undefined, volumes.readVolume);
        await manager.addPreparedTorrent(draft(), otherFolder, [0]);
        volumes.disconnect();
        await expect(
            manager.addPreparedTorrent(draft('b'.repeat(40)), folder, [0]),
        ).resolves.toMatchObject({ status: 'downloading', destinationFolder: folder });
        expect(engine.resume).toHaveBeenCalledTimes(2);
    });

    test.each([1, 3])(
        'a verificação periódica preserva a transferência saudável (limite=%s)',
        async (max) => {
            const volumes = readVolumes();
            const { manager, engine } = setup(1000, max, undefined, volumes.readVolume);
            const healthy = await manager.addPreparedTorrent(draft(), folder, [0]);
            const unavailable = await manager.addPreparedTorrent(
                draft('b'.repeat(40)),
                otherFolder,
                [0],
            );
            volumes.disconnect();
            await manager.checkDiskSpace();
            expect(
                manager.getAll().find((item) => item.infoHash === healthy.infoHash),
            ).toMatchObject({ status: 'downloading' });
            expect(engine.pause).not.toHaveBeenCalledWith(healthy.infoHash);
            if (max === 3) {
                expect(
                    manager.getAll().find((item) => item.infoHash === unavailable.infoHash),
                ).toMatchObject({
                    status: 'paused',
                    pauseReason: 'disk-space',
                    errorMessage: 'error.destination.diskSpaceUnavailable',
                });
                expect(engine.pause).toHaveBeenCalledWith(unavailable.infoHash);
            } else {
                expect(manager.getQueueOrder()).toEqual([unavailable.infoHash]);
            }
            await expect(manager.resume(unavailable.infoHash)).rejects.toThrow(
                'diskSpaceUnavailable',
            );
        },
    );
});

import { EventEmitter } from 'events';
import { createDownloadManager } from '../../main/downloadManager';
import type { PersistedStore } from '../../main/downloadManager';
import type { TorrentEngine } from '../../main/torrentEngine';
import type { SettingsManager } from '../../main/settingsManager';
import type { PersistedDownloadItem, TorrentFileInfo } from '../../shared/types';
import type { DiskSpaceService } from '../../main/diskSpace';

const hash = 'a'.repeat(40);
const metadata = Buffer.from('de');
const files: TorrentFileInfo[] = [
    {
        index: 0,
        name: 'a.bin',
        path: 'Archive/a.bin',
        length: 100,
        downloaded: 100,
        selected: true,
    },
    { index: 1, name: 'b.bin', path: 'Archive/b.bin', length: 100, downloaded: 0, selected: false },
];
async function setup(downloaded = 50, withMetadata = true, shared = false, queued = false) {
    const saved: PersistedDownloadItem = {
        infoHash: hash,
        name: 'Archive',
        totalSize: 100,
        downloadedSize: 100,
        progress: 1,
        status: queued ? 'queued' : 'completed',
        destinationFolder: process.cwd(),
        addedAt: 1,
        completedAt: 2,
        magnetUri: `magnet:?xt=urn:btih:${hash}`,
        selectedFileIndices: [0],
        files,
        ...(withMetadata ? { torrentFileBase64: metadata.toString('base64') } : {}),
    };
    let live = false;
    const verified = files.map((file) => ({ ...file, downloaded: file.selected ? downloaded : 0 }));
    const engine = Object.assign(new EventEmitter(), {
        getFiles: jest.fn(() => (live ? verified : [])),
        getTorrentFile: jest.fn(() => undefined),
        detachTorrent: jest.fn(async () => {
            live = false;
        }),
        addTorrentBuffer: jest.fn(async () => {
            live = true;
            return { infoHash: hash, status: 'paused', name: 'Archive' };
        }),
        isRestarting: () => false,
        resume: jest.fn(async () => { }),
    });
    const move = { commit: jest.fn(async () => true), rollback: jest.fn(async () => { }) };
    const torrentFiles = {
        validate: jest.fn(async () => { }),
        existingBytes: jest.fn(async () => 70),
        copy: jest.fn(async () => move),
    };
    const store = {
        get: (key: string) =>
            key === 'downloads'
                ? shared
                    ? [saved, { ...saved, infoHash: 'b'.repeat(40) }]
                    : [saved]
                : 1,
        set: jest.fn(),
    };
    let sufficient = true;
    const inspect = jest.fn(async (_folder: string, selectedBytes: number) => ({
        freeBytes: sufficient ? 1000 : 0,
        selectedBytes,
        reservedBytes: 0,
        safetyMarginBytes: 0,
        sufficient,
    }));
    const recoverMetadata = jest.fn(async () => ({
        buffer: metadata,
        magnetUri: saved.magnetUri!,
        preview: { requestId: 'recovered', name: 'Archive', infoHash: hash, files },
    }));
    const manager = createDownloadManager(
        engine as unknown as TorrentEngine,
        { get: () => ({ maxConcurrentDownloads: 3 }) } as SettingsManager,
        store as unknown as PersistedStore,
        undefined,
        {
            disableCleanupTimer: true,
            torrentFiles,
            diskSpace: { inspect } as DiskSpaceService,
            recoverMetadata,
        },
    );
    await manager.restoreSession();
    return {
        manager,
        engine,
        torrentFiles,
        move,
        store,
        inspect,
        recoverMetadata,
        setSpace: (value: boolean) => {
            sufficient = value;
        },
    };
}
test('catálogo concluído é disponível após reiniciar sem entrar na rede', async () => {
    const { manager, engine } = await setup();
    expect(manager.getFiles(hash)).toEqual(files);
    expect(engine.addTorrentBuffer).not.toHaveBeenCalled();
});
test('verificar detecta dados faltantes/corrompidos e aguarda retomada explícita', async () => {
    const { manager, engine } = await setup(50);
    const result = await manager.manageFiles(hash, 'verify');
    expect(engine.addTorrentBuffer).toHaveBeenCalledWith(metadata, true, {
        destinationFolder: process.cwd(),
        selectedFileIndices: [0],
        verifyExisting: true,
    });
    expect(result).toMatchObject({
        status: 'paused',
        totalSize: 100,
        downloadedSize: 50,
        progress: 0.5,
    });
    expect(result.completedAt).toBeUndefined();
    expect(result.fileOperation).toBeUndefined();
});
test('localizar muda a pasta e confirma integridade sem mover dados', async () => {
    const { manager, torrentFiles, engine } = await setup(100);
    const target = process.cwd() + '/other';
    const result = await manager.manageFiles(hash, 'locate', target);
    expect(result).toMatchObject({
        status: 'completed',
        destinationFolder: target,
        selectedFileCount: 1,
    });
    expect(torrentFiles.copy).not.toHaveBeenCalled();
    expect(engine.addTorrentBuffer).toHaveBeenCalledWith(
        metadata,
        true,
        expect.objectContaining({ destinationFolder: target, selectedFileIndices: [0] }),
    );
});
test('mover só remove originais depois de verificar e persistir o novo destino', async () => {
    const { manager, move, store, inspect } = await setup(100);
    const target = process.cwd() + '/other';
    move.commit.mockImplementationOnce(async () => {
        expect(store.set).toHaveBeenCalledWith(
            'downloads',
            expect.arrayContaining([
                expect.objectContaining({ destinationFolder: target, status: 'completed' }),
            ]),
        );
        return true;
    });
    await manager.manageFiles(hash, 'move', target);
    expect(inspect).toHaveBeenCalledWith(target, 70, expect.any(Array), hash);
    expect(move.commit).toHaveBeenCalledTimes(1);
    expect(move.rollback).not.toHaveBeenCalled();
});
test('falha de verificação desfaz somente cópias e mantém destino anterior', async () => {
    const { manager, engine, move } = await setup();
    engine.addTorrentBuffer.mockRejectedValueOnce(new Error('disco inacessível'));
    await expect(manager.manageFiles(hash, 'move', process.cwd() + '/other')).rejects.toThrow(
        'disco inacessível',
    );
    expect(move.rollback).toHaveBeenCalled();
    expect(move.commit).not.toHaveBeenCalled();
    expect(manager.getAll()[0]).toMatchObject({
        status: 'paused',
        destinationFolder: process.cwd(),
    });
});
test('falta de espaço interrompe movimento antes de copiar', async () => {
    const { manager, torrentFiles, setSpace } = await setup();
    setSpace(false);
    await expect(manager.manageFiles(hash, 'move', process.cwd() + '/other')).rejects.toThrow(
        'diskSpaceLow',
    );
    expect(torrentFiles.copy).not.toHaveBeenCalled();
});
test('eventos tardios não concluem nem retomam o torrent durante verificação', async () => {
    const { manager, engine } = await setup(50);
    engine.addTorrentBuffer.mockImplementationOnce(async () => {
        engine.emit('done', hash);
        engine.emit('error', hash, new Error('late network error'));
        expect(manager.getAll()[0]).toMatchObject({ status: 'paused', fileOperation: 'verify' });
        return { infoHash: hash, status: 'paused', name: 'Archive' };
    });
    await manager.manageFiles(hash, 'verify');
});
test('sessão antiga pode obter novamente metadados mantendo seleção', async () => {
    const { manager, recoverMetadata } = await setup(50, false);
    await manager.manageFiles(hash, 'verify');
    expect(recoverMetadata).toHaveBeenCalledWith(`magnet:?xt=urn:btih:${hash}`);
});
test('erro de limpeza mantém o destino novo e informa que os originais foram conservados', async () => {
    const { manager, move } = await setup(100);
    move.commit.mockResolvedValueOnce(false);
    const result = await manager.manageFiles(hash, 'move', process.cwd() + '/other');
    expect(result).toMatchObject({
        status: 'completed',
        errorMessage: 'error.files.sourceRetained',
    });
});
test('arquivos usados por outro torrent do Meshy Torrent permanecem no destino original', async () => {
    const { manager, move } = await setup(100, true, true);
    const result = await manager.manageFiles(hash, 'move', process.cwd() + '/other');
    expect(move.commit).not.toHaveBeenCalled();
    expect(result.errorMessage).toBe('error.files.sourceRetained');
});
test('torrent restaurado na fila pode verificar e depois retomar a instância verificada', async () => {
    const { manager, engine } = await setup(50, true, false, true);
    await manager.manageFiles(hash, 'verify');
    await manager.resume(hash);
    expect(engine.addTorrentBuffer).toHaveBeenCalledTimes(1);
    expect(engine.resume).toHaveBeenCalledWith(hash);
    expect(manager.getQueueOrder()).toEqual([]);
});

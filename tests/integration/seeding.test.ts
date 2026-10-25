import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { createDownloadManager } from '../../main/downloadManager';
import type { PersistedStore } from '../../main/downloadManager';
import type { TorrentEngine, TorrentInfo } from '../../main/torrentEngine';
import { createSettingsManager } from '../../main/settingsManager';
import type { SettingsStore } from '../../main/settingsManager';
import type { PersistedDownloadItem } from '../../shared/types';
import { validateSettingsPayload } from '../../main/settingsValidator';
import { ErrorCodes } from '../../shared/errorCodes';

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(() => true),
    accessSync: jest.fn(),
}));

const hash = (n: number) => n.toString(16).padStart(40, '0');
const magnet = (n: number) => `magnet:?xt=urn:btih:${hash(n)}`;
function setup(saved: PersistedDownloadItem[] = []) {
    const data = new Map<string, unknown>([['destinationFolder', '/downloads']]);
    const settings = createSettingsManager({
        store: {
            get: (key) => data.get(key),
            set: (key, value) => {
                data.set(key, value);
            },
            setMany: (values) => {
                for (const [key, value] of Object.entries(values)) data.set(key, value);
            },
        } as SettingsStore,
        getDownloadsPath: () => '/downloads',
    });
    let persisted = saved;
    const store = {
        get: (key: string) => (key === 'downloads' ? persisted : 1),
        set: (key: string, value: PersistedDownloadItem[]) => {
            if (key === 'downloads') persisted = value;
        },
    } as PersistedStore;
    const torrents = new Map<string, TorrentInfo>();
    const engine = Object.assign(new EventEmitter(), {
        addMagnetLink: jest.fn(async (uri: string) => {
            const infoHash = uri.split(':').pop()!;
            const info: TorrentInfo = {
                infoHash,
                name: infoHash,
                totalSize: 100,
                downloaded: 0,
                progress: 0,
                downloadSpeed: 0,
                uploadSpeed: 0,
                numPeers: 0,
                numSeeders: 0,
                timeRemaining: Infinity,
                status: 'downloading',
            };
            torrents.set(infoHash, info);
            return info;
        }),
        addTorrentBuffer: jest.fn(),
        pause: jest.fn(async () => {}),
        resume: jest.fn(async () => {}),
        remove: jest.fn(async (h: string) => {
            torrents.delete(h);
        }),
        getAll: () => [...torrents.values()],
        getFiles: jest.fn(() => []),
        getTorrentFile: () => undefined,
        getMetadata: (infoHash: string) => ({
            infoHash,
            creator: null,
            comment: null,
            creationDate: null,
        }),
        isRestarting: () => false,
    });
    const manager = createDownloadManager(
        engine as unknown as TorrentEngine,
        settings,
        store,
        undefined,
        { disableCleanupTimer: true },
    );
    const status = (n: number) => manager.getAll().find((item) => item.infoHash === hash(n))!;
    const finish = async (n: number) => {
        await manager.addMagnetLink(magnet(n));
        engine.emit('done', hash(n));
        await manager.applySeedingSettings();
    };
    return { engine, manager, settings, store, status, finish, saved: () => persisted };
}

beforeEach(() => {
    jest.mocked(existsSync).mockReturnValue(true);
});

test.each([true, false])(
    'repete o estado desejado enabled=%s após falha de persistência sem inverter',
    async (enabled) => {
        const { manager, finish, status, saved, store, engine } = setup();
        await finish(1);
        await manager.setSeedingEnabled(hash(1), !enabled);
        const previous = saved().find((item) => item.infoHash === hash(1))!;
        jest.spyOn(store, 'set').mockImplementationOnce(() => {
            throw new Error('Falha de gravação');
        });

        await expect(manager.setSeedingEnabled(hash(1), enabled)).rejects.toThrow(
            'Falha de gravação',
        );
        expect(status(1).seedingDisabled).toBe(!enabled);
        expect(saved().find((item) => item.infoHash === hash(1))).toEqual(previous);

        await manager.setSeedingEnabled(hash(1), enabled);
        expect(status(1)).toMatchObject({
            status: enabled ? 'seeding' : 'completed',
            seedingDisabled: !enabled,
        });
        expect(saved().find((item) => item.infoHash === hash(1))?.seedingDisabled).toBe(!enabled);
        const pauses = engine.pause.mock.calls.length;
        const resumes = engine.resume.mock.calls.length;
        await manager.setSeedingEnabled(hash(1), enabled);
        expect(status(1).seedingDisabled).toBe(!enabled);
        expect(engine.pause).toHaveBeenCalledTimes(pauses);
        expect(engine.resume).toHaveBeenCalledTimes(resumes);
    },
);

test.each([true, false])(
    'solicitações concorrentes com enabled=%s mantêm o estado desejado',
    async (enabled) => {
        const { manager, finish, status, saved } = setup();
        await finish(1);
        await manager.setSeedingEnabled(hash(1), !enabled);
        await Promise.all([
            manager.setSeedingEnabled(hash(1), enabled),
            manager.setSeedingEnabled(hash(1), enabled),
        ]);
        expect(status(1)).toMatchObject({
            status: enabled ? 'seeding' : 'completed',
            seedingDisabled: !enabled,
        });
        expect(saved().find((item) => item.infoHash === hash(1))?.seedingDisabled).toBe(!enabled);
    },
);

test('ciclo completo: add → done → seeding → stop → completed → resume → seeding', async () => {
    const { manager, engine, status, finish, saved } = setup();
    await finish(1);
    expect(status(1).status).toBe('seeding');
    expect(engine.pause).not.toHaveBeenCalled();
    expect((await manager.setSeedingEnabled(hash(1), false)).status).toBe('completed');
    expect(saved()[0].seedingDisabled).toBe(true);
    expect(engine.pause).toHaveBeenCalledWith(hash(1));
    expect((await manager.setSeedingEnabled(hash(1), true)).status).toBe('seeding');
    expect(engine.resume).toHaveBeenCalledWith(hash(1), true);
});

test('slots de seed independem dos slots de download; FIFO promove após remoção', async () => {
    const { manager, settings, finish, status } = setup();
    settings.set({ maxConcurrentDownloads: 1, maxConcurrentSeeders: 1 });
    await finish(1);
    await finish(2);
    await finish(3);
    expect([status(1).status, status(2).status, status(3).status]).toEqual([
        'seeding',
        'completed',
        'completed',
    ]);
    await manager.remove(hash(1), false);
    await manager.applySeedingSettings();
    expect(status(2).status).toBe('seeding');
    expect(status(3).status).toBe('completed');
});

test('reduzir limite suspende os últimos iniciados e aumentar preenche a fila', async () => {
    const { manager, settings, finish, status } = setup();
    await finish(1);
    await finish(2);
    await finish(3);
    settings.set({ maxConcurrentSeeders: 1 });
    await manager.applySeedingSettings();
    expect(status(1).status).toBe('seeding');
    expect(status(2).status).toBe('completed');
    settings.set({ maxConcurrentSeeders: 3 });
    await manager.applySeedingSettings();
    expect(manager.getAll().filter((item) => item.status === 'seeding')).toHaveLength(3);
});

test('desativar globalmente para a rede; preferência individual é salva sem iniciar seed', async () => {
    const { manager, settings, finish, status, engine } = setup();
    await finish(1);
    await finish(2);
    settings.set({ seedingEnabled: false });
    await manager.applySeedingSettings();
    expect(manager.getAll().every((item) => item.status === 'completed')).toBe(true);
    await manager.setSeedingEnabled(hash(1), false);
    await manager.setSeedingEnabled(hash(1), true);
    expect(status(1).status).toBe('completed');
    expect(engine.resume).not.toHaveBeenCalled();
    settings.set({ seedingEnabled: true });
    await manager.applySeedingSettings();
    expect(status(1).status).toBe('seeding');
});

test('pausa manual libera slot e retomada de completo não ocupa fila de download', async () => {
    const { manager, settings, finish, status } = setup();
    settings.set({ maxConcurrentSeeders: 1 });
    await finish(1);
    await finish(2);
    await manager.pause(hash(1));
    await manager.applySeedingSettings();
    expect(status(1).status).toBe('paused');
    expect(status(2).status).toBe('seeding');
    await manager.resume(hash(1));
    expect(status(1).status).toBe('completed');
    expect(manager.getQueueOrder()).toEqual([]);
});

test('restaura seeders e completos por completedAt, preservando opt-out', async () => {
    const item = (n: number, completedAt: number): PersistedDownloadItem => ({
        infoHash: hash(n),
        name: `torrent ${n}`,
        totalSize: 100,
        downloadedSize: 100,
        progress: 1,
        status: 'seeding',
        destinationFolder: '/downloads',
        addedAt: 0,
        completedAt,
        magnetUri: magnet(n),
    });
    const { manager, status, saved } = setup([
        item(1, 300),
        { ...item(2, 50), seedingDisabled: true },
        item(3, 100),
        { ...item(4, 200), status: 'completed' },
    ]);
    await manager.restoreSession();
    expect([status(1).status, status(2).status, status(3).status, status(4).status]).toEqual([
        'completed',
        'completed',
        'seeding',
        'seeding',
    ]);
    expect(saved().find((entry) => entry.infoHash === hash(2))?.seedingDisabled).toBe(true);
});

test('operações concorrentes não excedem o limite nem promovem duas vezes', async () => {
    const { manager, finish, settings } = setup();
    settings.set({ maxConcurrentSeeders: 1 });
    await finish(1);
    await finish(2);
    await finish(3);
    await Promise.all([
        manager.setSeedingEnabled(hash(1), false),
        manager.applySeedingSettings(),
        manager.applySeedingSettings(),
    ]);
    expect(manager.getAll().filter((item) => item.status === 'seeding')).toHaveLength(1);
});

test('falha ao retomar libera o slot, registra erro e tenta o próximo', async () => {
    const { manager, settings, finish, engine, status } = setup();
    settings.set({ seedingEnabled: false, maxConcurrentSeeders: 1 });
    await finish(1);
    await finish(2);
    engine.resume.mockRejectedValueOnce(new Error('rede indisponível'));
    settings.set({ seedingEnabled: true });
    await manager.applySeedingSettings();
    expect(status(1).status).toBe('error');
    expect(status(2).status).toBe('seeding');
});

test('falha ao parar preserva o seeder e seu slot', async () => {
    const { manager, finish, engine, status } = setup();
    await finish(1);
    engine.pause.mockRejectedValueOnce(new Error('timeout'));
    await expect(manager.setSeedingEnabled(hash(1), false)).rejects.toThrow('timeout');
    expect(status(1).status).toBe('seeding');
    expect(status(1).seedingDisabled).not.toBe(true);
});

test('eventos tardios não reativam torrent pausado; upload atualiza métricas sem concluir de novo', async () => {
    const { manager, finish, engine, status } = setup();
    await finish(1);
    engine.emit('progress', {
        infoHash: hash(1),
        status: 'seeding',
        uploadSpeed: 4096,
        numPeers: 2,
        numSeeders: 1,
    });
    expect(status(1).uploadSpeed).toBe(4096);
    const completedAt = status(1).completedAt;
    engine.emit('done', hash(1));
    expect(status(1).completedAt).toBe(completedAt);
    await manager.pause(hash(1));
    engine.emit('done', hash(1));
    expect(status(1).status).toBe('paused');
});

test('reinício limpa reservas e refaz promoção', async () => {
    const { manager, finish, engine, status } = setup();
    await finish(1);
    engine.emit('restarting');
    expect(status(1).status).toBe('completed');
    engine.emit('restarted');
    await manager.applySeedingSettings();
    expect(status(1).status).toBe('seeding');
});

test.each([0, 21, -1, 1.5, NaN, Infinity, '2', null])('rejeita limite inválido %s', (value) => {
    expect(validateSettingsPayload({ maxConcurrentSeeders: value } as never)).toBe(
        ErrorCodes.INVALID_SETTINGS,
    );
});

test('defaults e sanitização de sessões antigas/corrompidas', () => {
    const { settings } = setup();
    expect(settings.get()).toMatchObject({ seedingEnabled: true, maxConcurrentSeeders: 2 });
    expect(validateSettingsPayload({ seedingEnabled: false, maxConcurrentSeeders: 20 })).toBeNull();
    expect(validateSettingsPayload({ maxConcurrentSeeders: 1 })).toBeNull();
    expect(validateSettingsPayload({ seedingEnabled: 'true' } as never)).toBe(
        ErrorCodes.INVALID_SETTINGS,
    );
});

test('reserva do seeder só é liberada depois que a rede confirma pausa', async () => {
    const { manager, finish, engine, settings, status } = setup();
    settings.set({ maxConcurrentSeeders: 1 });
    await finish(1);
    await finish(2);
    let release!: () => void;
    engine.pause.mockImplementationOnce(
        () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
    );
    const pausing = manager.pause(hash(1));
    await Promise.resolve();
    await Promise.resolve();
    await manager.applySeedingSettings();
    expect(status(2).status).toBe('completed');
    release();
    await pausing;
    await manager.applySeedingSettings();
    expect(status(2).status).toBe('seeding');
});

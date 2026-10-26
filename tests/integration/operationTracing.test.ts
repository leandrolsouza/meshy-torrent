import { EventEmitter } from 'node:events';
import log from 'electron-log';
import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import type WebTorrent from 'webtorrent';
import type { TorrentErrorEvent } from '../../shared/types';
import { parseTraceContext } from '../../shared/traceContext';
import { getOperationContext } from '../../main/operationContext';
import type { OperationContext } from '../../main/operationContext';
import { traceOperation } from '../../main/tracing';
import { logger, setDebugEnabled } from '../../main/logger';
import { registerIpcHandlers, attachWindowEvents, _rateLimiter } from '../../main/ipcHandler';
import { createTorrentEngine } from '../../main/torrentEngine';
import type { TorrentInfo } from '../../main/torrentEngine';
import { createDownloadManager } from '../../main/downloadManager';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() } }));
jest.mock('webtorrent', () => jest.fn());
jest.mock('../../main/rendererSecurity', () => ({ isTrustedIpcSender: () => true }));
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(() => true),
    accessSync: jest.fn(),
}));

const remote = { traceId: '1'.repeat(32), spanId: '2'.repeat(16) };
const settings = {
    get: () => ({ destinationFolder: '/fixture', maxConcurrentDownloads: 1 }),
} as unknown as SettingsManager;

function handler(channel: string) {
    return jest.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)![1];
}

beforeEach(() => {
    jest.clearAllMocks();
    _rateLimiter.reset();
    setDebugEnabled(false);
});

test('spans preservam relações pai/filho, isolam concorrência e restauram o contexto', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const captured: OperationContext[] = [];
    const first = traceOperation('operation.first', async () => {
        const parent = getOperationContext()!;
        captured.push(parent);
        await gate;
        await traceOperation('operation.child', async () => {
            await Promise.resolve();
            const child = getOperationContext()!;
            expect(child.traceId).toBe(parent.traceId);
            expect(child.parentSpanId).toBe(parent.spanId);
            expect(child.spanId).not.toBe(parent.spanId);
            logger.error('Falha sintética');
        });
        expect(getOperationContext()).toBe(parent);
    });
    await traceOperation('operation.second', async () => {
        captured.push(getOperationContext()!);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        expect(getOperationContext()!.operation).toBe('operation.second');
    });
    release();
    await first;
    expect(captured[0]!.traceId).not.toBe(captured[1]!.traceId);
    expect(getOperationContext()).toBeUndefined();
    expect(jest.mocked(log.error).mock.calls).toContainEqual([
        'Falha sintética',
        expect.objectContaining({ traceId: captured[0]!.traceId }),
    ]);
    const spans = jest
        .mocked(log.info)
        .mock.calls.filter((call) => (call[1] as { event?: string })?.event === 'span.end');
    expect(spans).toHaveLength(3);
});

test('IPC mantém payload, propaga contexto a serviços e devolve o span mesmo sem debug', async () => {
    const captured: OperationContext[] = [];
    const manager = {
        pause: jest.fn(async () => {
            await Promise.resolve();
            captured.push(getOperationContext()!);
            logger.info('Serviço executado');
        }),
    } as unknown as DownloadManager;
    registerIpcHandlers(manager, settings);
    const response = await handler('torrent:pause')(
        {} as never,
        { infoHash: 'a'.repeat(40) },
        remote,
    );
    expect(response).toMatchObject({
        success: true,
        traceContext: { traceId: remote.traceId, parentSpanId: remote.spanId },
    });
    expect(response.traceContext.spanId).not.toBe(remote.spanId);
    expect(captured[0]!.spanId).toBe(response.traceContext.spanId);
    expect(jest.mocked(log.info).mock.calls).toContainEqual([
        'Serviço executado',
        expect.objectContaining({ traceId: remote.traceId, cid: remote.traceId }),
    ]);
    expect(getOperationContext()).toBeUndefined();
});

test('falhas IPC e rate limit conservam origem e finalizam spans em produção', async () => {
    const manager = {
        pause: jest.fn(async () => {
            throw new Error('Falha sintética');
        }),
    } as unknown as DownloadManager;
    registerIpcHandlers(manager, settings);
    const response = await handler('torrent:pause')(
        {} as never,
        { infoHash: 'a'.repeat(40) },
        remote,
    );
    expect(response).toMatchObject({ success: false, traceContext: { traceId: remote.traceId } });
    for (let i = 0; i < 500; i++) _rateLimiter.tryConsume('torrent:pause');
    const limited = await handler('torrent:pause')({} as never, {}, remote);
    expect(limited).toMatchObject({
        success: false,
        error: 'error.rateLimit',
        traceContext: { traceId: remote.traceId },
    });
    expect(
        jest
            .mocked(log.warn)
            .mock.calls.filter((call) => (call[1] as { event?: string })?.event === 'span.end'),
    ).toHaveLength(2);
});

test.each([
    { traceId: 'token=SYNTHETIC_SECRET', spanId: remote.spanId },
    { traceId: '0'.repeat(32), spanId: remote.spanId },
    { ...remote, parentSpanId: 'invalid' },
])('IPC substitui metadados inválidos sem registrá-los: %j', async (metadata) => {
    registerIpcHandlers({ getAll: () => [] } as unknown as DownloadManager, settings);
    let unrelated!: OperationContext;
    const response = await traceOperation('unrelated.emitter', () => {
        unrelated = getOperationContext()!;
        return handler('torrent:get-all')({} as never, undefined, metadata);
    });
    expect(parseTraceContext(response.traceContext)).toBeDefined();
    expect(response.traceContext.traceId).not.toBe(metadata.traceId);
    expect(response.traceContext.traceId).not.toBe(unrelated.traceId);
    expect(JSON.stringify(jest.mocked(log.info).mock.calls)).not.toContain('SYNTHETIC_SECRET');
});

test('eventos tardios da engine mantêm a origem até a janela, mesmo sob outro contexto', async () => {
    const torrents = ['a', 'b'].map((id) =>
        Object.assign(new EventEmitter(), {
            infoHash: id.repeat(40),
            ready: false,
            files: [],
            pause: jest.fn(),
            resume: jest.fn(),
        }),
    );
    const client = Object.assign(new EventEmitter(), {
        torrents,
        add: jest.fn((magnet: string) =>
            torrents.find((torrent) => magnet.includes(torrent.infoHash)),
        ),
    });
    // A engine não aceita adicionar instâncias já presentes no cliente.
    client.torrents = [];
    client.add.mockImplementation((magnet: string) => {
        const torrent = torrents.find((item) => magnet.includes(item.infoHash))!;
        client.torrents.push(torrent);
        return torrent;
    });
    const engine = createTorrentEngine(
        {
            downloadPath: '/fixture',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            dhtEnabled: false,
            pexEnabled: false,
            utpEnabled: false,
        },
        client as unknown as WebTorrent,
    );
    const window = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        webContents: { send: jest.fn() },
    });
    attachWindowEvents(
        { getAll: () => [] } as unknown as DownloadManager,
        engine,
        window as unknown as BrowserWindow,
    );
    const origins: OperationContext[] = [];
    try {
        for (const torrent of torrents) {
            await traceOperation('add', () => {
                origins.push(getOperationContext()!);
                return engine.addMagnetLink(`magnet:?xt=urn:btih:${torrent.infoHash}`);
            });
        }
        traceOperation('unrelated', () => {
            for (const torrent of torrents) torrent.emit('error', new Error('Falha tardia'));
        });
        const errors = window.webContents.send.mock.calls.filter(
            ([channel]) => channel === 'torrent:error',
        );
        expect(errors).toHaveLength(2);
        errors.forEach(([, payload], index) => {
            const event = payload as TorrentErrorEvent;
            expect(event.traceContext).toMatchObject({
                traceId: origins[index]!.traceId,
                parentSpanId: origins[index]!.spanId,
            });
        });
        expect(errors[0]![1].traceContext.traceId).not.toBe(errors[1]![1].traceContext.traceId);
        expect(getOperationContext()).toBeUndefined();
    } finally {
        window.emit('closed');
    }
});

test('download enfileirado retém sua origem quando outra operação libera o slot', async () => {
    const started: OperationContext[] = [];
    const engine = Object.assign(new EventEmitter(), {
        isRestarting: () => false,
        addMagnetLink: jest.fn(async (magnet: string): Promise<TorrentInfo> => {
            started.push(getOperationContext()!);
            return {
                infoHash: magnet.slice(-40),
                name: 'fixture',
                totalSize: 100,
                progress: 0,
                downloadSpeed: 0,
                uploadSpeed: 0,
                numPeers: 0,
                numSeeders: 0,
                timeRemaining: Infinity,
                downloaded: 0,
                status: 'downloading',
            };
        }),
        getFiles: () => [],
        pause: jest.fn(async () => {}),
        getAll: () => [],
    });
    const manager = createDownloadManager(engine as never, settings, undefined, undefined, {
        disableCleanupTimer: true,
    });
    await traceOperation('add.first', () =>
        manager.addMagnetLink(`magnet:?xt=urn:btih:${'a'.repeat(40)}`),
    );
    let queuedOrigin!: OperationContext;
    const queued = await traceOperation('add.queued', () => {
        queuedOrigin = getOperationContext()!;
        return manager.addMagnetLink(`magnet:?xt=urn:btih:${'b'.repeat(40)}`);
    });
    expect(queued.status).toBe('queued');
    await traceOperation('pause.first', () => manager.pause('a'.repeat(40)));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toHaveLength(2);
    expect(started[1]!.traceId).toBe(queuedOrigin.traceId);
    expect(started[1]!.parentSpanId).toBe(queuedOrigin.spanId);
    expect(manager.getAll().find((item) => item.infoHash === queued.infoHash)!.status).toBe(
        'downloading',
    );
    expect(getOperationContext()).toBeUndefined();
});

jest.mock('../../main/torrentInput', () => ({
    readTorrentFile: (filePath: string) => require('fs/promises').readFile(filePath),
}));

/**
 * Testes unitários para confirmar anonimização nos logs.
 *
 * Verifica que os logs emitidos por main/torrentEngine.ts e main/downloadManager.ts
 * não contêm:
 *   - Caminhos absolutos completos de arquivo (apenas basename é permitido)
 *   - infoHash completo de 40 caracteres (apenas os primeiros 8 são permitidos)
 *   - URIs magnet completas (com parâmetro xt=urn:btih: e hash inteiro)
 *
 * _Requisitos: 10.5, 10.6_
 */

// Mock webtorrent ANTES dos imports para que Jest (CommonJS) não tente parsear
// o pacote ESM-only.
jest.mock('webtorrent', () => {
    const MockWebTorrent = jest.fn().mockImplementation(() => ({
        torrents: [],
        throttleDownload: jest.fn(),
        throttleUpload: jest.fn(),
        add: jest.fn(),
        remove: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
    }));
    return { __esModule: true, default: MockWebTorrent };
});

// Mock fs/promises para controlar leitura de arquivos sem I/O real.
jest.mock('fs/promises', () => ({
    readFile: jest.fn(),
    rm: jest.fn(),
    readdir: jest.fn(),
    stat: jest.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false }),
    access: jest.fn().mockResolvedValue(undefined),
}));

// Mock fs para validação de pasta no DownloadManager.
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(),
    accessSync: jest.fn(),
}));

// Mock do logger do main process para capturar todas as chamadas de log.
// Isso afeta tanto torrentEngine (que importa o logger diretamente) quanto
// quaisquer outros módulos que o importem.
jest.mock('../../main/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
    setDebugEnabled: jest.fn(),
    isDebugEnabled: jest.fn().mockReturnValue(false),
    createScopedLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

import { createTorrentEngine } from '../../main/torrentEngine';
import { createDownloadManager } from '../../main/downloadManager';
import { logger } from '../../main/logger';
import { readFile } from 'fs/promises';
import { existsSync, accessSync } from 'fs';
import { EventEmitter } from 'events';
import type WebTorrent from 'webtorrent';
import type { Torrent } from 'webtorrent';
import type { TorrentEngine, TorrentInfo, TorrentStatus } from '../../main/torrentEngine';
import type { SettingsManager } from '../../main/settingsManager';
import type { Logger } from '../../main/logger';
import type { PersistedStore } from '../../main/downloadManager';

// A assinatura sobrecarregada de readFile é incompatível com jest.MockedFunction direto;
// usamos double-cast via unknown para contornar a limitação de tipo.
// noUncheckedIndexedAccess: o cast via unknown é necessário aqui.
const mockReadFile = readFile as unknown as jest.Mock;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockAccessSync = accessSync as jest.MockedFunction<typeof accessSync>;

// O mock do logger foi registrado como `jest.mock('../../main/logger', ...)`.
// Ao importar `logger` acima, obtemos o objeto com os jest.fn() do mock.
const mockLogger = logger as {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hash completo de 40 caracteres — nunca deve aparecer integralmente nos logs. */
const FULL_INFO_HASH = 'a'.repeat(40);

/** URI magnet completa — nunca deve aparecer nos logs com o xt=urn:btih: inteiro. */
const FULL_MAGNET_URI = `magnet:?xt=urn:btih:${FULL_INFO_HASH}&dn=TestTorrent&tr=udp%3A%2F%2Ftracker.test.com%3A6969`;

/** Caminho absoluto Unix — nunca deve aparecer integralmente nos logs. */
const ABSOLUTE_PATH_UNIX = '/home/user/sensitive/downloads/myfile.torrent';

/** Caminho absoluto Windows — nunca deve aparecer integralmente nos logs. */
const ABSOLUTE_PATH_WIN = 'C:\\Users\\user\\Downloads\\myfile.torrent';

/** Basename esperado nos logs em vez do caminho absoluto. */
const BASENAME = 'myfile.torrent';

/** Primeiros 8 caracteres do infoHash — única representação permitida nos logs. */
const TRUNCATED_HASH = FULL_INFO_HASH.slice(0, 8);

const DEFAULT_ENGINE_OPTIONS = {
    downloadPath: '/tmp/downloads',
    downloadSpeedLimit: 0,
    uploadSpeedLimit: 0,
    dhtEnabled: true,
    pexEnabled: true,
    utpEnabled: true,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Coleta todos os argumentos de todas as chamadas de um mock como uma lista
 * de strings — uma string por chamada (argumentos concatenados por espaço).
 * Aceita qualquer objeto com a propriedade `mock.calls` para compatibilidade
 * com jest.Mock e jest.MockInstance.
 */
function collectLogLines(mock: { mock: { calls: unknown[][] } }): string[] {
    return mock.mock.calls.map((call) =>
        call.map((arg: unknown) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
    );
}

/**
 * Verifica que nenhuma linha de log contém qualquer um dos valores sensíveis.
 * Lança um erro com mensagem descritiva se encontrar algum.
 */
function assertNoSensitiveValue(logLines: string[], sensitiveValues: string[]): void {
    for (const line of logLines) {
        for (const sensitive of sensitiveValues) {
            if (line.includes(sensitive)) {
                throw new Error(
                    `Log contém dado sensível.\n` +
                    `  Valor proibido: "${sensitive}"\n` +
                    `  Linha de log:   "${line}"`,
                );
            }
        }
    }
}

/** Retorna todas as linhas de log (todos os níveis) do mock logger global. */
function allGlobalLogLines(): string[] {
    return [
        ...collectLogLines(mockLogger.info),
        ...collectLogLines(mockLogger.warn),
        ...collectLogLines(mockLogger.error),
        ...collectLogLines(mockLogger.debug),
    ];
}

/** Cria um mock de WebTorrent client com array de torrents mutável. */
function makeMockClient(): WebTorrent & { torrents: Torrent[]; add: jest.Mock } {
    const torrents: Torrent[] = [];
    return {
        torrents,
        throttleDownload: jest.fn(),
        throttleUpload: jest.fn(),
        add: jest.fn(),
        remove: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
    } as unknown as WebTorrent & { torrents: Torrent[]; add: jest.Mock };
}

/** Cria um fake Torrent mínimo sem propriedades internas do WebTorrent. */
function makeFakeTorrent(infoHash: string, overrides: Partial<Torrent> = {}): Torrent {
    return {
        infoHash,
        name: infoHash.slice(0, 8),
        length: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        timeRemaining: Infinity,
        downloaded: 0,
        files: [],
        ready: false,
        magnetURI: `magnet:?xt=urn:btih:${infoHash}`,
        pause: jest.fn(),
        resume: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        emit: jest.fn(),
        ...overrides,
    } as unknown as Torrent;
}

/** Cria um mock de TorrentEngine como EventEmitter (para testes de DownloadManager). */
function makeMockEngine(): TorrentEngine & EventEmitter {
    const emitter = new EventEmitter();
    const baseInfo: TorrentInfo = {
        infoHash: FULL_INFO_HASH,
        name: 'Test Torrent Name', // nome genérico — diferente do infoHash
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

    return Object.assign(emitter, {
        addTorrentFile: jest.fn().mockResolvedValue(baseInfo),
        detachTorrent: jest.fn().mockResolvedValue(undefined),
        getTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn().mockResolvedValue(baseInfo),
        addMagnetLink: jest.fn().mockResolvedValue(baseInfo),
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
            infoHash: FULL_INFO_HASH,
            creator: null,
            comment: null,
            creationDate: null,
        }),
        getPeers: jest.fn().mockReturnValue([]),
        getPieces: jest.fn().mockReturnValue([]),
    }) as TorrentEngine & EventEmitter;
}

/** Cria um mock de SettingsManager. */
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

// ─── Suite 1: TorrentEngine — anonimização de caminhos de arquivo ─────────────

describe('TorrentEngine — anonimização de caminhos de arquivo nos logs (Requisitos 10.5, 10.6)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('usa basename em vez do caminho absoluto Unix ao iniciar addTorrentFile', async () => {
        // Mantém readFile pendente para capturar o log de início antes de rejeitar
        let rejectRead!: (reason: Error) => void;
        mockReadFile.mockImplementation(
            () =>
                new Promise<Buffer>((_, reject) => {
                    rejectRead = reject;
                }),
        );

        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_ENGINE_OPTIONS, mockClient);

        // Iniciar sem aguardar — o log de início dispara SINCRONAMENTE
        const addPromise = engine.addTorrentFile(ABSOLUTE_PATH_UNIX);

        // O log logger.info dispara antes do await readFile
        const infoLines = collectLogLines(mockLogger.info);
        assertNoSensitiveValue(infoLines, [ABSOLUTE_PATH_UNIX]);
        expect(infoLines.some((l) => l.includes(BASENAME))).toBe(true);

        // Rejeitar a leitura e aguardar a rejeição para limpar a Promise
        rejectRead(Object.assign(new Error('cancelado'), { code: 'ECANCELLED' }));
        await expect(addPromise).rejects.toThrow();
    });

    it('usa basename em vez do caminho absoluto Unix ao falhar na leitura (logger.error)', async () => {
        mockReadFile.mockRejectedValue(
            Object.assign(new Error('No such file'), { code: 'ENOENT' }),
        );

        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_ENGINE_OPTIONS, mockClient);

        await expect(engine.addTorrentFile(ABSOLUTE_PATH_UNIX)).rejects.toThrow();

        const allLines = allGlobalLogLines();
        assertNoSensitiveValue(allLines, [ABSOLUTE_PATH_UNIX]);

        // logger.error deve mencionar o basename
        const errorLines = collectLogLines(mockLogger.error);
        expect(errorLines.some((l) => l.includes(BASENAME))).toBe(true);
    });

    it('usa basename em vez do caminho absoluto Windows ao falhar na leitura', async () => {
        mockReadFile.mockRejectedValue(
            Object.assign(new Error('Access denied'), { code: 'EACCES' }),
        );

        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_ENGINE_OPTIONS, mockClient);

        await expect(engine.addTorrentFile(ABSOLUTE_PATH_WIN)).rejects.toThrow();

        const allLines = allGlobalLogLines();
        assertNoSensitiveValue(allLines, [ABSOLUTE_PATH_WIN]);

        const errorLines = collectLogLines(mockLogger.error);
        expect(errorLines.some((l) => l.includes(BASENAME))).toBe(true);
    });
});

// ─── Suite 2: TorrentEngine — anonimização de infoHash nos logs ───────────────

describe('TorrentEngine — anonimização de infoHash nos logs (Requisitos 10.5, 10.6)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('usa infoHash.slice(0,8) em vez do hash inteiro ao pausar (sem torrent no engine)', async () => {
        // Pausar um hash que não está em client.torrents: o log ocorre mas
        // _stopNetwork não é chamado (torrent === undefined).
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_ENGINE_OPTIONS, mockClient);

        await engine.pause(FULL_INFO_HASH);

        const allLines = allGlobalLogLines();
        assertNoSensitiveValue(allLines, [FULL_INFO_HASH]);
        expect(allLines.some((l) => l.includes(TRUNCATED_HASH))).toBe(true);
    });

    it('não loga o hash inteiro de 40 chars ao registrar status paused', async () => {
        const mockClient = makeMockClient();
        const engine = createTorrentEngine(DEFAULT_ENGINE_OPTIONS, mockClient);

        await engine.pause(FULL_INFO_HASH);

        // Verificar especificamente que o hash completo (40 chars) não aparece
        const allLines = allGlobalLogLines();
        for (const line of allLines) {
            // O hash completo nunca deve aparecer — nem como substring de outra string
            expect(line).not.toContain(FULL_INFO_HASH);
        }
    });

    it('usa hash.slice(0,8) em vez do hash inteiro ao adicionar magnet link', () => {
        const mockClient = makeMockClient();
        const fakeTorrent = makeFakeTorrent(FULL_INFO_HASH);
        mockClient.add.mockReturnValue(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_ENGINE_OPTIONS, mockClient);

        // addMagnetLink retorna synchronously (Promise.resolve) após o setup
        engine.addMagnetLink(FULL_MAGNET_URI);

        const allLines = allGlobalLogLines();
        // O hash completo não deve aparecer nos logs
        assertNoSensitiveValue(allLines, [FULL_INFO_HASH]);
        // O hash truncado deve aparecer
        expect(allLines.some((l) => l.includes(TRUNCATED_HASH))).toBe(true);
    });

    it('não loga a URI magnet completa ao adicionar magnet link', () => {
        const mockClient = makeMockClient();
        const fakeTorrent = makeFakeTorrent(FULL_INFO_HASH);
        mockClient.add.mockReturnValue(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_ENGINE_OPTIONS, mockClient);

        engine.addMagnetLink(FULL_MAGNET_URI);

        const allLines = allGlobalLogLines();
        // A URI magnet completa e o parâmetro xt=urn:btih: com o hash nunca devem aparecer
        assertNoSensitiveValue(allLines, [FULL_MAGNET_URI, `xt=urn:btih:${FULL_INFO_HASH}`]);
    });

    it('usa hash.slice(0,8) ao logar status inicial do magnet link', () => {
        const mockClient = makeMockClient();
        const fakeTorrent = makeFakeTorrent(FULL_INFO_HASH);
        mockClient.add.mockReturnValue(fakeTorrent);

        const engine = createTorrentEngine(DEFAULT_ENGINE_OPTIONS, mockClient);

        engine.addMagnetLink(FULL_MAGNET_URI);

        // Verificar que nenhum log contém o hash de 40 chars
        const allLines = allGlobalLogLines();
        for (const line of allLines) {
            expect(line).not.toContain(FULL_INFO_HASH);
        }
    });
});

// ─── Suite 3: DownloadManager — anonimização de infoHash nos logs ─────────────

describe('DownloadManager — anonimização de infoHash nos logs (Requisitos 10.5, 10.6)', () => {
    let mockLog: jest.Mocked<Logger>;

    beforeEach(() => {
        jest.clearAllMocks();
        mockLog = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        };
        mockExistsSync.mockReturnValue(true);
        mockAccessSync.mockReturnValue(undefined);
    });

    /** Coleta todos os logs do logger injetado no DownloadManager. */
    function dmLogLines(): string[] {
        return [
            ...collectLogLines(mockLog.info),
            ...collectLogLines(mockLog.warn),
            ...collectLogLines(mockLog.error),
            ...collectLogLines(mockLog.debug),
        ];
    }

    it('usa infoHash.slice(0,8) ao logar erro de engine', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, mockLog, {
            disableCleanupTimer: true,
        });

        // Adicionar download → item registrado com status resolving-metadata
        await manager.addMagnetLink(FULL_MAGNET_URI);

        // Emitir erro de engine com o infoHash completo
        engine.emit('error', FULL_INFO_HASH, new Error('engine falhou'));

        const lines = dmLogLines();
        // O hash completo de 40 chars não deve aparecer nos logs
        assertNoSensitiveValue(lines, [FULL_INFO_HASH]);
        // O hash truncado deve aparecer (no log de error)
        expect(lines.some((l) => l.includes(TRUNCATED_HASH))).toBe(true);
    });

    it('usa infoHash.slice(0,8) ao logar início de retryDownload', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, mockLog, {
            disableCleanupTimer: true,
        });

        // Adicionar e forçar status error
        await manager.addMagnetLink(FULL_MAGNET_URI);
        engine.emit('error', FULL_INFO_HASH, new Error('falha inicial'));

        // Limpar logs anteriores para isolar os logs do retry
        (mockLog.info as jest.Mock).mockClear();
        (mockLog.warn as jest.Mock).mockClear();
        (mockLog.error as jest.Mock).mockClear();
        (mockLog.debug as jest.Mock).mockClear();

        await manager.retryDownload(FULL_INFO_HASH);

        const lines = dmLogLines();
        assertNoSensitiveValue(lines, [FULL_INFO_HASH]);
        expect(lines.some((l) => l.includes(TRUNCATED_HASH))).toBe(true);
    });

    it('usa infoHash.slice(0,8) ao logar falha de remoção do engine', async () => {
        const engine = makeMockEngine();
        // Fazer engine.remove falhar para acionar o caminho de log.warn
        (engine.remove as jest.Mock).mockRejectedValue(new Error('remoção falhou'));

        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, mockLog, {
            disableCleanupTimer: true,
        });

        await manager.addMagnetLink(FULL_MAGNET_URI);

        // Limpar logs do addMagnetLink
        (mockLog.info as jest.Mock).mockClear();
        (mockLog.warn as jest.Mock).mockClear();
        (mockLog.error as jest.Mock).mockClear();

        await expect(manager.remove(FULL_INFO_HASH, false)).rejects.toThrow('remoção falhou');

        const warnLines = collectLogLines(mockLog.warn);
        // O hash completo não deve aparecer nos warns
        assertNoSensitiveValue(warnLines, [FULL_INFO_HASH]);
        // O hash truncado deve aparecer no warn de falha de remoção
        expect(warnLines.some((l) => l.includes(TRUNCATED_HASH))).toBe(true);
    });

    it('não loga a URI magnet completa em nenhuma operação do DownloadManager', async () => {
        const engine = makeMockEngine();
        const settings = makeMockSettings();
        const manager = createDownloadManager(engine, settings, undefined, mockLog, {
            disableCleanupTimer: true,
        });

        await manager.addMagnetLink(FULL_MAGNET_URI);
        engine.emit('error', FULL_INFO_HASH, new Error('erro teste'));
        await Promise.resolve();

        const lines = dmLogLines();
        // A URI magnet completa e o parâmetro xt=urn:btih: nunca devem aparecer nos logs
        assertNoSensitiveValue(lines, [FULL_MAGNET_URI, `xt=urn:btih:${FULL_INFO_HASH}`]);
    });

    it('usa infoHash.slice(0,8) ao logar erro de restauração de sessão', async () => {
        const engine = makeMockEngine();
        // Fazer addMagnetLink falhar para acionar o caminho de log.error em restoreSession
        (engine.addMagnetLink as jest.Mock).mockRejectedValue(new Error('falha ao restaurar'));

        const settings = makeMockSettings();

        // Store mock com um item downloading para forçar tentativa de restore
        const store: PersistedStore = {
            get: jest.fn().mockImplementation((key: string) => {
                if (key === 'downloads') {
                    return [
                        {
                            infoHash: FULL_INFO_HASH,
                            name: 'test',
                            totalSize: 0,
                            downloadedSize: 0,
                            progress: 0,
                            status: 'downloading' as TorrentStatus,
                            destinationFolder: '/downloads',
                            addedAt: Date.now(),
                            magnetUri: FULL_MAGNET_URI,
                        },
                    ];
                }
                if (key === 'downloadsSchemaVersion') return 1;
                return undefined;
            }) as PersistedStore['get'],
            set: jest.fn() as PersistedStore['set'],
        };

        const manager = createDownloadManager(engine, settings, store, mockLog, {
            disableCleanupTimer: true,
        });

        await manager.restoreSession();

        const lines = dmLogLines();
        assertNoSensitiveValue(lines, [FULL_INFO_HASH]);
        // O hash truncado deve aparecer no log de erro de restauração
        const errorLines = collectLogLines(mockLog.error);
        expect(errorLines.some((l) => l.includes(TRUNCATED_HASH))).toBe(true);
    });
});

// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Testes de propriedade (PBT) para os handlers IPC `torrent:open-folder` e `torrent:open-file`.
 *
 * Usa fast-check para verificar propriedades universais de corretude definidas no design.
 *
 * Cobre:
 *   - Propriedade 1: open-folder retorna caminho correto ao shell
 *   - Propriedade 2: open-file constrói caminho completo corretamente
 *   - Propriedade 3: infoHash inexistente retorna torrent-not-found
 *   - Propriedade 4: payload inválido é rejeitado
 *   - Propriedade 5: erro do shell é propagado
 *   - Propriedade 6: pasta inexistente retorna folderNotFound
 *   - Propriedade 7: arquivo inexistente retorna fileNotFound
 *   - Propriedade 8: torrent não concluído é rejeitado
 */

import * as fc from 'fast-check';
import * as path from 'path';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { ErrorCodes } from '../../shared/errorCodes';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../main/settingsManager';
import type { DownloadItem, TorrentFileInfo, TorrentStatus } from '../../shared/types';

// ─── Mock electron ────────────────────────────────────────────────────────────

const mockShellOpenPath = jest.fn<Promise<string>, [string]>();
const mockShowItemInFolder = jest.fn();

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
    },
    dialog: {
        showOpenDialog: jest.fn(),
    },
    shell: {
        openPath: (...args: unknown[]) => mockShellOpenPath(...(args as [string])),
        showItemInFolder: (...args: unknown[]) => mockShowItemInFolder(...args),
    },
    BrowserWindow: jest.fn().mockImplementation(() => ({
        webContents: { send: jest.fn() },
        isDestroyed: jest.fn().mockReturnValue(false),
        on: jest.fn(),
    })),
}));

// ─── Mock fs (existsSync) ─────────────────────────────────────────────────────

const mockExistsSync = jest.fn<boolean, [string]>();

jest.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...(args as [string])),
    accessSync: jest.fn(),
    statSync: jest.fn(() => ({ isDirectory: () => true })),
    readFileSync: jest.fn(),
    constants: { W_OK: 2 },
}));

// Retrieve mocked ipcMain
const { ipcMain: mockIpcMain } = require('electron') as {
    ipcMain: { handle: jest.Mock };
};

// ─── Geradores fast-check ─────────────────────────────────────────────────────

/** Gera infoHash válido (40 caracteres hexadecimais) */
const arbInfoHash = fc.string({
    unit: fc.constantFrom(...'0123456789abcdef'),
    minLength: 40,
    maxLength: 40,
});

/** Gera caminhos de pasta seguros para testes */
const arbFolderPath = fc.string({
    unit: fc.constantFrom('a', 'b', 'c', 'd', '/', '_', '-', '0', '1'),
    minLength: 1,
    maxLength: 50,
});

/** Gera caminhos de arquivo relativos seguros para testes */
const arbFileSegment = fc
    .tuple(
        fc.constantFrom('a', 'b', 'c', 'm', 'p', '4'),
        fc.string({
            unit: fc.constantFrom('a', 'b', 'c', '.', '_', '-', 'm', 'p', '4'),
            maxLength: 8,
        }),
    )
    .map(([first, rest]) => first + rest);
const arbFilePath = fc
    .array(arbFileSegment, { minLength: 1, maxLength: 5 })
    .map((parts) => parts.join('/'));

/** Gera status de torrent (todos os possíveis) */
const arbTorrentStatus: fc.Arbitrary<TorrentStatus> = fc.constantFrom(
    'queued',
    'resolving-metadata',
    'downloading',
    'paused',
    'completed',
    'error',
    'metadata-failed',
    'files-not-found',
);

/** Gera status de torrent excluindo 'completed' */
const arbNonCompletedStatus: fc.Arbitrary<TorrentStatus> = fc.constantFrom(
    'queued',
    'resolving-metadata',
    'downloading',
    'paused',
    'error',
    'metadata-failed',
    'files-not-found',
);

/** Gera strings de erro do shell (não vazias) */
const arbShellError = fc.string({ minLength: 1, maxLength: 100 });

// O filesystem destes handlers é virtual; contenção/symlinks têm testes próprios.
jest.mock('fs/promises', () => ({
    realpath: jest.fn(async (folder: string) => require('path').resolve(folder)),
    lstat: jest.fn(async () => ({ isSymbolicLink: () => false })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDownloadItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
    return {
        infoHash: 'a'.repeat(40),
        name: 'My Torrent',
        totalSize: 1024,
        downloadedSize: 1024,
        progress: 1,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: 0,
        status: 'completed',
        destinationFolder: '/downloads/my-torrent',
        addedAt: Date.now(),
        completedAt: Date.now(),
        selectedFileCount: 1,
        totalFileCount: 1,
        ...overrides,
    };
}

function makeFileInfo(overrides: Partial<TorrentFileInfo> = {}): TorrentFileInfo {
    return {
        index: 0,
        name: 'video.mp4',
        path: 'My Torrent/video.mp4',
        length: 1024,
        downloaded: 1024,
        selected: true,
        ...overrides,
    };
}

function makeMockDownloadManager(items: DownloadItem[] = []): DownloadManager {
    return {
        addTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn(),
        addMagnetLink: jest.fn(),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        getAll: jest.fn().mockReturnValue(items),
        restoreSession: jest.fn().mockResolvedValue(undefined),
        persistSession: jest.fn(),
        setMaxConcurrentDownloads: jest.fn(),
        reorderQueue: jest.fn().mockReturnValue([]),
        getQueueOrder: jest.fn().mockReturnValue([]),
        on: jest.fn(),
    } as unknown as DownloadManager;
}

function makeMockSettingsManager(): SettingsManager {
    return {
        get: jest.fn().mockReturnValue({
            destinationFolder: '/downloads',
            downloadSpeedLimit: 0,
            uploadSpeedLimit: 0,
            maxConcurrentDownloads: 3,
            notificationsEnabled: true,
            theme: 'vs-code-dark',
            locale: 'pt-BR',
            globalTrackers: [],
            autoApplyGlobalTrackers: false,
            dhtEnabled: true,
            pexEnabled: true,
            utpEnabled: true,

            closeToTray: false,
        } as AppSettings),
        set: jest.fn(),
        getDefaultDownloadFolder: jest.fn().mockReturnValue('/downloads'),
        getGlobalTrackers: jest.fn().mockReturnValue([]),
        addGlobalTracker: jest.fn(),
        removeGlobalTracker: jest.fn(),
        setAutoApplyGlobalTrackers: jest.fn(),
    } as unknown as SettingsManager;
}

function makeMockTorrentEngine(files: TorrentFileInfo[] = [], isRestarting = false) {
    return {
        getTrackers: jest.fn().mockReturnValue([]),
        addTracker: jest.fn(),
        removeTracker: jest.fn(),
        getFiles: jest.fn().mockReturnValue(files),
        setFileSelection: jest.fn().mockReturnValue([]),
        isRestarting: jest.fn().mockReturnValue(isRestarting),
        on: jest.fn(),
        removeListener: jest.fn(),
    };
}

/**
 * Extrai o handler registrado para um canal IPC específico.
 */
function getHandler(
    channel: string,
): ((_event: unknown, payload: unknown) => Promise<unknown>) | undefined {
    const call = mockIpcMain.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
    return call ? (call[1] as (_event: unknown, payload: unknown) => Promise<unknown>) : undefined;
}

// ─── Testes de Propriedade ─────────────────────────────────────────────────────

afterEach(() => {
    _rateLimiter.reset();
});

describe('Property-Based Tests: open-destination IPC handlers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Propriedade 1: open-folder retorna o caminho correto ao shell
    // ═══════════════════════════════════════════════════════════════════════════

    it('Feature: open-destination, Property 1: open-folder retorna o caminho correto ao shell', async () => {
        /**
         * Validates: Requirements 1.1, 1.2
         *
         * Para qualquer infoHash válido e destinationFolder onde a pasta existe
         * e shell.openPath retorna sucesso, shell.openPath é chamado com
         * exatamente destinationFolder e a resposta é success: true.
         */
        await fc.assert(
            fc.asyncProperty(arbInfoHash, arbFolderPath, async (infoHash, destinationFolder) => {
                jest.clearAllMocks();
                _rateLimiter.reset();

                const item = makeDownloadItem({ infoHash, destinationFolder });
                const dm = makeMockDownloadManager([item]);
                const sm = makeMockSettingsManager();
                const te = makeMockTorrentEngine();

                mockExistsSync.mockReturnValue(true);
                mockShellOpenPath.mockResolvedValue('');

                registerIpcHandlers(dm, sm, te as any);

                const handler = getHandler('torrent:open-folder')!;
                const response = (await handler(null, { infoHash })) as any;

                expect(response.success).toBe(true);
                expect(mockShellOpenPath).toHaveBeenCalledWith(destinationFolder);
            }),
            { numRuns: 100 },
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Propriedade 2: open-file constrói o caminho completo corretamente
    // ═══════════════════════════════════════════════════════════════════════════

    it('Feature: open-destination, Property 2: open-file constrói o caminho completo corretamente', async () => {
        /**
         * Validates: Requirements 2.1, 2.2
         *
         * Para qualquer infoHash válido, destinationFolder e file.path de um
         * torrent concluído com arquivo selecionado, o caminho resolvido é
         * aberto se tiver formato permitido ou revelado no gerenciador de arquivos.
         */
        await fc.assert(
            fc.asyncProperty(
                arbInfoHash,
                arbFolderPath,
                arbFilePath,
                async (infoHash, destinationFolder, filePath) => {
                    jest.clearAllMocks();
                    _rateLimiter.reset();

                    const item = makeDownloadItem({
                        infoHash,
                        destinationFolder,
                        status: 'completed',
                    });
                    const file = makeFileInfo({ path: filePath, selected: true });
                    const dm = makeMockDownloadManager([item]);
                    const sm = makeMockSettingsManager();
                    const te = makeMockTorrentEngine([file]);

                    mockExistsSync.mockReturnValue(true);
                    mockShellOpenPath.mockResolvedValue('');

                    registerIpcHandlers(dm, sm, te as any);

                    const handler = getHandler('torrent:open-file')!;
                    const response = (await handler(null, { infoHash })) as any;

                    const expectedPath = path.resolve(destinationFolder, filePath);

                    expect(response.success).toBe(true);
                    // Formatos permitidos que o alfabeto de arbFileSegment pode gerar.
                    if (
                        ['.mp4', '.bmp', '.aac', '.m4a'].includes(
                            path.extname(filePath).toLowerCase(),
                        )
                    ) {
                        expect(mockShellOpenPath).toHaveBeenCalledWith(expectedPath);
                        expect(mockShowItemInFolder).not.toHaveBeenCalled();
                    } else {
                        expect(mockShowItemInFolder).toHaveBeenCalledWith(expectedPath);
                        expect(mockShellOpenPath).not.toHaveBeenCalled();
                    }
                },
            ),
            {
                numRuns: 100,
                examples: [
                    ['0'.repeat(40), 'a', 'a.bmp'],
                    ['0'.repeat(40), 'a', 'a.aac'],
                    ['0'.repeat(40), 'a', 'a.m4a'],
                    ['0'.repeat(40), 'a', 'a.mp4'],
                ],
            },
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Propriedade 3: infoHash inexistente retorna torrent-not-found
    // ═══════════════════════════════════════════════════════════════════════════

    it('Feature: open-destination, Property 3: infoHash inexistente retorna torrent-not-found', async () => {
        /**
         * Validates: Requirements 1.3, 2.3
         *
         * Para qualquer infoHash que não existe na lista de downloads,
         * ambos os handlers retornam error.torrent.notFound.
         */
        await fc.assert(
            fc.asyncProperty(arbInfoHash, async (infoHash) => {
                jest.clearAllMocks();
                _rateLimiter.reset();

                // Lista vazia — nenhum infoHash vai corresponder
                const dm = makeMockDownloadManager([]);
                const sm = makeMockSettingsManager();
                const te = makeMockTorrentEngine();

                registerIpcHandlers(dm, sm, te as any);

                // Testar open-folder
                const openFolderHandler = getHandler('torrent:open-folder')!;
                const folderResponse = (await openFolderHandler(null, { infoHash })) as any;

                expect(folderResponse.success).toBe(false);
                expect(folderResponse.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);

                // Testar open-file
                const openFileHandler = getHandler('torrent:open-file')!;
                const fileResponse = (await openFileHandler(null, { infoHash })) as any;

                expect(fileResponse.success).toBe(false);
                expect(fileResponse.error).toBe(ErrorCodes.TORRENT_NOT_FOUND);
            }),
            { numRuns: 100 },
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Propriedade 4: payload inválido é rejeitado com erro de parâmetros
    // ═══════════════════════════════════════════════════════════════════════════

    it('Feature: open-destination, Property 4: payload inválido é rejeitado', async () => {
        /**
         * Validates: Requirements 3.2, 3.3
         *
         * Para qualquer payload malformado, ambos os handlers retornam
         * error.params.invalid.
         */
        const arbInvalidPayload = fc.oneof(
            fc.constant(null),
            fc.constant(undefined),
            fc.constant({}),
            fc.constant({ infoHash: '' }),
            fc.nat().map((n) => ({ infoHash: n })),
            fc.boolean().map((b) => ({ infoHash: b })),
            fc.constant({ wrongField: 'abc' }),
            fc.string({ minLength: 1 }).map((s) => s), // string bruta, não objeto
        );

        await fc.assert(
            fc.asyncProperty(arbInvalidPayload, async (payload) => {
                jest.clearAllMocks();
                _rateLimiter.reset();

                const dm = makeMockDownloadManager();
                const sm = makeMockSettingsManager();
                const te = makeMockTorrentEngine();

                registerIpcHandlers(dm, sm, te as any);

                // Testar open-folder
                const openFolderHandler = getHandler('torrent:open-folder')!;
                const folderResponse = (await openFolderHandler(null, payload)) as any;

                expect(folderResponse.success).toBe(false);
                expect(folderResponse.error).toBe(ErrorCodes.INVALID_PARAMS);

                // Testar open-file — pode retornar ENGINE_RESTARTING antes de validar payload
                // mas com isRestarting=false, deve validar payload
                const openFileHandler = getHandler('torrent:open-file')!;
                const fileResponse = (await openFileHandler(null, payload)) as any;

                expect(fileResponse.success).toBe(false);
                expect(fileResponse.error).toBe(ErrorCodes.INVALID_PARAMS);
            }),
            { numRuns: 100 },
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Propriedade 5: erro do shell é propagado na resposta
    // ═══════════════════════════════════════════════════════════════════════════

    it('Feature: open-destination, Property 5: erro do shell é propagado', async () => {
        /**
         * Validates: Requirements 1.5, 2.6
         *
         * Para qualquer string de erro não vazia retornada por shell.openPath(),
         * a resposta contém error.destination.openFailed.
         */
        await fc.assert(
            fc.asyncProperty(arbInfoHash, arbShellError, async (infoHash, shellError) => {
                jest.clearAllMocks();
                _rateLimiter.reset();

                const item = makeDownloadItem({ infoHash, status: 'completed' });
                const file = makeFileInfo({ selected: true });
                const dm = makeMockDownloadManager([item]);
                const sm = makeMockSettingsManager();
                const te = makeMockTorrentEngine([file]);

                mockExistsSync.mockReturnValue(true);
                mockShellOpenPath.mockResolvedValue(shellError);

                registerIpcHandlers(dm, sm, te as any);

                // Testar open-folder
                const openFolderHandler = getHandler('torrent:open-folder')!;
                const folderResponse = (await openFolderHandler(null, { infoHash })) as any;

                expect(folderResponse.success).toBe(false);
                expect(folderResponse.error).toBe(ErrorCodes.DESTINATION_OPEN_FAILED);

                // Testar open-file
                const openFileHandler = getHandler('torrent:open-file')!;
                const fileResponse = (await openFileHandler(null, { infoHash })) as any;

                expect(fileResponse.success).toBe(false);
                expect(fileResponse.error).toBe(ErrorCodes.DESTINATION_OPEN_FAILED);
            }),
            { numRuns: 100 },
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Propriedade 6: pasta inexistente retorna folderNotFound
    // ═══════════════════════════════════════════════════════════════════════════

    it('Feature: open-destination, Property 6: pasta inexistente retorna folderNotFound', async () => {
        /**
         * Validates: Requirements 1.4
         *
         * Quando existsSync retorna false para a pasta de destino,
         * open-folder retorna error.destination.folderNotFound.
         */
        await fc.assert(
            fc.asyncProperty(arbInfoHash, arbFolderPath, async (infoHash, destinationFolder) => {
                jest.clearAllMocks();
                _rateLimiter.reset();

                const item = makeDownloadItem({ infoHash, destinationFolder });
                const dm = makeMockDownloadManager([item]);
                const sm = makeMockSettingsManager();
                const te = makeMockTorrentEngine();

                mockExistsSync.mockReturnValue(false);

                registerIpcHandlers(dm, sm, te as any);

                const handler = getHandler('torrent:open-folder')!;
                const response = (await handler(null, { infoHash })) as any;

                expect(response.success).toBe(false);
                expect(response.error).toBe(ErrorCodes.DESTINATION_FOLDER_NOT_FOUND);
                expect(mockShellOpenPath).not.toHaveBeenCalled();
            }),
            { numRuns: 100 },
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Propriedade 7: arquivo inexistente retorna fileNotFound
    // ═══════════════════════════════════════════════════════════════════════════

    it('Feature: open-destination, Property 7: arquivo inexistente retorna fileNotFound', async () => {
        /**
         * Validates: Requirements 2.5
         *
         * Quando o arquivo não existe no disco (existsSync retorna false),
         * open-file retorna error.destination.fileNotFound.
         */
        await fc.assert(
            fc.asyncProperty(
                arbInfoHash,
                arbFolderPath,
                arbFilePath,
                async (infoHash, destinationFolder, filePath) => {
                    jest.clearAllMocks();
                    _rateLimiter.reset();

                    const item = makeDownloadItem({
                        infoHash,
                        destinationFolder,
                        status: 'completed',
                    });
                    const file = makeFileInfo({ path: filePath, selected: true });
                    const dm = makeMockDownloadManager([item]);
                    const sm = makeMockSettingsManager();
                    const te = makeMockTorrentEngine([file]);

                    mockExistsSync.mockReturnValue(false);

                    registerIpcHandlers(dm, sm, te as any);

                    const handler = getHandler('torrent:open-file')!;
                    const response = (await handler(null, { infoHash })) as any;

                    expect(response.success).toBe(false);
                    expect(response.error).toBe(ErrorCodes.DESTINATION_FILE_NOT_FOUND);
                    expect(mockShellOpenPath).not.toHaveBeenCalled();
                },
            ),
            { numRuns: 100 },
        );
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Propriedade 8: torrent não concluído é rejeitado por open-file
    // ═══════════════════════════════════════════════════════════════════════════

    it('Feature: open-destination, Property 8: torrent não concluído é rejeitado', async () => {
        /**
         * Validates: Requirements 2.4
         *
         * Para qualquer status diferente de 'completed', open-file retorna
         * error.destination.notCompleted.
         */
        await fc.assert(
            fc.asyncProperty(arbInfoHash, arbNonCompletedStatus, async (infoHash, status) => {
                jest.clearAllMocks();
                _rateLimiter.reset();

                const item = makeDownloadItem({ infoHash, status });
                const dm = makeMockDownloadManager([item]);
                const sm = makeMockSettingsManager();
                const te = makeMockTorrentEngine();

                registerIpcHandlers(dm, sm, te as any);

                const handler = getHandler('torrent:open-file')!;
                const response = (await handler(null, { infoHash })) as any;

                expect(response.success).toBe(false);
                expect(response.error).toBe(ErrorCodes.DESTINATION_NOT_COMPLETED);
            }),
            { numRuns: 100 },
        );
    });
});

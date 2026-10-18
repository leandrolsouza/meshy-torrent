// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

/**
 * Testes unitários para os handlers IPC `queue:reorder` e `queue:get-order`.
 *
 * Cobre:
 *   - Requisitos 1.1: Reordenação com payload válido retorna nova ordem
 *   - Requisitos 1.2: Erro para infoHash inexistente
 *   - Requisitos 1.3: Erro para newIndex fora dos limites
 *   - Requisitos 1.5: Validação de payload (null, string vazia, não-inteiro, negativo)
 *   - Requisitos 7.2: Consulta da ordem da fila
 */

import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { ErrorCodes } from '../../shared/errorCodes';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager, AppSettings } from '../../main/settingsManager';

// ─── Mock electron ────────────────────────────────────────────────────────────

jest.mock('electron', () => ({
    ipcMain: {
        handle: jest.fn(),
    },
    dialog: {
        showOpenDialog: jest.fn(),
    },
    shell: {
        openPath: jest.fn().mockResolvedValue(''),
    },
    BrowserWindow: jest.fn().mockImplementation(() => ({
        webContents: { send: jest.fn() },
        isDestroyed: jest.fn().mockReturnValue(false),
        on: jest.fn(),
    })),
}));

jest.mock('fs', () => ({
    existsSync: jest.fn().mockReturnValue(true),
    accessSync: jest.fn(),
    readFileSync: jest.fn(),
    constants: { W_OK: 2 },
}));

// Referência ao mock do ipcMain
const { ipcMain: mockIpcMain } = require('electron') as {
    ipcMain: { handle: jest.Mock };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDownloadManager(): DownloadManager {
    return {
        addTorrentFile: jest.fn(),
        addTorrentBuffer: jest.fn(),
        addMagnetLink: jest.fn(),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        getAll: jest.fn().mockReturnValue([]),
        restoreSession: jest.fn().mockResolvedValue(undefined),
        persistSession: jest.fn(),
        setMaxConcurrentDownloads: jest.fn(),
        reorderQueue: jest.fn().mockReturnValue(['hash1', 'hash2', 'hash3']),
        getQueueOrder: jest.fn().mockReturnValue(['hash1', 'hash2', 'hash3']),
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
            seedingEnabled: false,
            maxConcurrentSeeders: 2,
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

function makeMockTorrentEngine() {
    return {
        getTrackers: jest.fn().mockReturnValue([]),
        addTracker: jest.fn(),
        removeTracker: jest.fn(),
        getFiles: jest.fn().mockReturnValue([]),
        setFileSelection: jest.fn().mockReturnValue([]),
        isRestarting: jest.fn().mockReturnValue(false),
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

// ─── Testes ───────────────────────────────────────────────────────────────────

afterEach(() => {
    _rateLimiter.reset();
});

// ═══════════════════════════════════════════════════════════════════════════════
// queue:reorder
// ═══════════════════════════════════════════════════════════════════════════════

describe('queue:reorder', () => {
    let mockDm: DownloadManager;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        registerIpcHandlers(mockDm, sm, te as any);
    });

    // ── Sucesso (happy path) ──────────────────────────────────────────────────

    it('retorna nova ordem da fila com payload válido', async () => {
        const expectedOrder = ['hash2', 'hash1', 'hash3'];
        (mockDm.reorderQueue as jest.Mock).mockReturnValue(expectedOrder);

        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, {
            infoHash: 'hash1',
            newIndex: 1,
        })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual(expectedOrder);
        expect(mockDm.reorderQueue).toHaveBeenCalledWith('hash1', 1);
    });

    it('aceita newIndex igual a 0 (mover para o início)', async () => {
        const expectedOrder = ['hash3', 'hash1', 'hash2'];
        (mockDm.reorderQueue as jest.Mock).mockReturnValue(expectedOrder);

        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, {
            infoHash: 'hash3',
            newIndex: 0,
        })) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual(expectedOrder);
        expect(mockDm.reorderQueue).toHaveBeenCalledWith('hash3', 0);
    });

    // ── Payload inválido ──────────────────────────────────────────────────────

    it('retorna INVALID_PARAMS quando payload é null', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, null)) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando payload é objeto vazio', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, {})) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando infoHash é string vazia', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, { infoHash: '', newIndex: 0 })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando infoHash não é string', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, { infoHash: 123, newIndex: 0 })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    it('retorna INVALID_PARAMS quando newIndex não é número', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, { infoHash: 'hash1', newIndex: 'abc' })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.INVALID_PARAMS);
    });

    // ── newIndex inválido (inteiro não-negativo) ──────────────────────────────

    it('retorna QUEUE_INVALID_INDEX quando newIndex é negativo', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, { infoHash: 'hash1', newIndex: -1 })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.QUEUE_INVALID_INDEX);
    });

    it('retorna QUEUE_INVALID_INDEX quando newIndex é float (não-inteiro)', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, { infoHash: 'hash1', newIndex: 1.5 })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.QUEUE_INVALID_INDEX);
    });

    it('retorna QUEUE_INVALID_INDEX quando newIndex é NaN', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, { infoHash: 'hash1', newIndex: NaN })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.QUEUE_INVALID_INDEX);
    });

    it('retorna QUEUE_INVALID_INDEX quando newIndex é Infinity', async () => {
        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, {
            infoHash: 'hash1',
            newIndex: Infinity,
        })) as any;

        expect(response.success).toBe(false);
        expect(response.error).toBe(ErrorCodes.QUEUE_INVALID_INDEX);
    });

    // ── Erro do DownloadManager (infoHash não encontrado na fila) ─────────────

    it('retorna erro quando downloadManager.reorderQueue lança exceção (infoHash inexistente)', async () => {
        (mockDm.reorderQueue as jest.Mock).mockImplementation(() => {
            throw new Error('Item não encontrado na fila');
        });

        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, {
            infoHash: 'inexistente',
            newIndex: 0,
        })) as any;

        expect(response.success).toBe(false);
        // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
        expect(response.error).toBe('error.operation.failed');
    });

    // ── Erro do DownloadManager (newIndex fora dos limites) ───────────────────

    it('retorna erro quando downloadManager.reorderQueue lança exceção (newIndex fora dos limites)', async () => {
        (mockDm.reorderQueue as jest.Mock).mockImplementation(() => {
            throw new Error('Posição inválida na fila');
        });

        const handler = getHandler('queue:reorder')!;
        const response = (await handler(null, {
            infoHash: 'hash1',
            newIndex: 99,
        })) as any;

        expect(response.success).toBe(false);
        // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
        expect(response.error).toBe('error.operation.failed');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// queue:get-order
// ═══════════════════════════════════════════════════════════════════════════════

describe('queue:get-order', () => {
    let mockDm: DownloadManager;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDm = makeMockDownloadManager();
        const sm = makeMockSettingsManager();
        const te = makeMockTorrentEngine();
        registerIpcHandlers(mockDm, sm, te as any);
    });

    it('retorna a ordem atual da fila com sucesso', async () => {
        const expectedOrder = ['hash1', 'hash2', 'hash3'];
        (mockDm.getQueueOrder as jest.Mock).mockReturnValue(expectedOrder);

        const handler = getHandler('queue:get-order')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual(expectedOrder);
        expect(mockDm.getQueueOrder).toHaveBeenCalled();
    });

    it('retorna array vazio quando a fila está vazia', async () => {
        (mockDm.getQueueOrder as jest.Mock).mockReturnValue([]);

        const handler = getHandler('queue:get-order')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(true);
        expect(response.data).toEqual([]);
    });

    it('retorna erro quando downloadManager.getQueueOrder lança exceção', async () => {
        (mockDm.getQueueOrder as jest.Mock).mockImplementation(() => {
            throw new Error('Erro inesperado');
        });

        const handler = getHandler('queue:get-order')!;
        const response = (await handler(null, undefined)) as any;

        expect(response.success).toBe(false);
        // failWithLog retorna ErrorCodes.OPERATION_FAILED para não vazar err.message ao renderer
        expect(response.error).toBe('error.operation.failed');
    });
});

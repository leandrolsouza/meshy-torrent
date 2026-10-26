import { ipcMain } from 'electron';
import log from 'electron-log';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { metrics } from '../../main/metrics';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import { ErrorCodes } from '../../shared/errorCodes';
import type { IPCResponse } from '../../shared/types';
import type { LogContext } from '../../main/logger';

jest.mock('electron', () => ({ ipcMain: { handle: jest.fn() } }));
jest.mock('../../main/rendererSecurity', () => ({ isTrustedIpcSender: () => true }));

const origin = { traceId: '1'.repeat(32), spanId: '2'.repeat(16) };
const secret = 'SYNTHETIC_PRIVATE_PASSKEY';
const tracker = `https://user:password@tracker.example.test/${secret}/announce`;

function setup() {
    const manager = { pause: jest.fn(async () => {}) };
    registerIpcHandlers(manager as unknown as DownloadManager, {} as SettingsManager);
    const invoke = (channel: string, payload: unknown): Promise<IPCResponse<unknown>> =>
        jest
            .mocked(ipcMain.handle)
            .mock.calls.find(([name]) => name === channel)![1]({} as never, payload, origin);
    return { manager, invoke };
}

function failureEvents(): LogContext[] {
    return jest
        .mocked(log.error)
        .mock.calls.map((call) => call[1] as LogContext)
        .filter((record) => record?.event === 'ipc.operation.failed');
}

beforeEach(() => {
    jest.clearAllMocks();
    _rateLimiter.reset();
});
afterEach(() => {
    jest.restoreAllMocks();
    _rateLimiter.reset();
});

test('mensagens iguais conservam códigos, stacks, causas e correlação distintos no destino do log', async () => {
    const { manager, invoke } = setup();
    const errors = ['EACCES', 'ENOENT'].map((code) => {
        const cause = Object.assign(new Error(`Falha de rede ${tracker}`), {
            code: 'ECONNRESET',
            errno: -54,
            syscall: 'connect',
            token: secret,
        });
        const error = Object.assign(new TypeError('Mesma mensagem'), {
            code,
            errno: -13,
            syscall: 'open',
            cause,
        });
        error.stack =
            'TypeError: Mesma mensagem\n    at readFixture (C:\\Users\\PessoaSintetica\\arquivo.torrent:10:2)\n    at worker (node:internal/process/task_queues:105:5)';
        return error;
    });
    for (const error of errors) {
        manager.pause.mockRejectedValueOnce(error);
        const response = await invoke('torrent:pause', { infoHash: 'a'.repeat(40) });
        expect(response).toMatchObject({
            success: false,
            error: ErrorCodes.OPERATION_FAILED,
            traceContext: { traceId: origin.traceId },
        });
        const serialized = JSON.stringify(response);
        for (const internal of [
            'TypeError',
            'Mesma mensagem',
            'EACCES',
            'ENOENT',
            'stack',
            'cause',
            'errno',
            'syscall',
            secret,
        ])
            expect(serialized).not.toContain(internal);
    }
    const records = failureEvents();
    expect(records).toHaveLength(2);
    records.forEach((record, index) => {
        expect(record).toMatchObject({
            schemaVersion: 1,
            event: 'ipc.operation.failed',
            channel: 'torrent:pause',
            errorCode: ErrorCodes.OPERATION_FAILED,
            traceId: origin.traceId,
            parentSpanId: origin.spanId,
            error: {
                type: 'TypeError',
                message: 'Mesma mensagem',
                code: errors[index]!.code,
                errno: -13,
                syscall: 'open',
                stack: expect.stringContaining('node:internal/process/task_queues:105:5'),
                cause: {
                    type: 'Error',
                    message: 'Falha de rede [URL omitida]',
                    code: 'ECONNRESET',
                    errno: -54,
                    syscall: 'connect',
                    stack: expect.any(String),
                },
            },
        });
        expect(record.spanId).toEqual(expect.stringMatching(/^[a-f0-9]{16}$/));
        expect(record.error).not.toBe(errors[index]);
    });
    expect(records[0]!.spanId).not.toBe(records[1]!.spanId);
    const logged = JSON.stringify(jest.mocked(log.error).mock.calls);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain('PessoaSintetica');
    expect(logged).not.toContain('arquivo.torrent');
    expect(errors[0]!.cause.message).toContain(secret);
});

test('código público conhecido é preservado sem trocar pelo code interno do erro', async () => {
    const { manager, invoke } = setup();
    manager.pause.mockRejectedValueOnce(
        Object.assign(new Error(ErrorCodes.TORRENT_NOT_FOUND), { code: 'INTERNAL_LOOKUP_MISS' }),
    );
    const response = await invoke('torrent:pause', { infoHash: 'a'.repeat(40) });
    expect(response).toMatchObject({ success: false, error: ErrorCodes.TORRENT_NOT_FOUND });
    expect(failureEvents()[0]).toMatchObject({
        errorCode: ErrorCodes.TORRENT_NOT_FOUND,
        error: { code: 'INTERNAL_LOOKUP_MISS', stack: expect.any(String) },
    });
    expect(JSON.stringify(response)).not.toContain('INTERNAL_LOOKUP_MISS');
});

test('valor lançado sem Error nem mensagem não executa toString e mantém resposta segura', async () => {
    const { manager, invoke } = setup();
    const toString = jest.fn(() => {
        throw new Error(secret);
    });
    manager.pause.mockRejectedValueOnce({ code: 'EIO', token: secret, toString });
    expect(await invoke('torrent:pause', { infoHash: 'a'.repeat(40) })).toMatchObject({
        success: false,
        error: ErrorCodes.OPERATION_FAILED,
    });
    expect(failureEvents()[0]).toMatchObject({ error: { type: 'NonError', code: 'EIO' } });
    expect(toString).not.toHaveBeenCalled();
    expect(JSON.stringify(failureEvents())).not.toContain(secret);
});

test('falha no caminho com ScopedLogger usa o mesmo esquema e preserva diagnóstico', async () => {
    const { invoke } = setup();
    jest.spyOn(metrics, 'recordRendererError').mockImplementationOnce(() => {
        throw Object.assign(new Error('Falha ao registrar'), {
            code: 'EIO',
            cause: new Error(`Falha ${tracker}`),
        });
    });
    const response = await invoke('renderer:report-error', {
        message: 'Falha de renderização',
        source: 'ErrorBoundary',
    });
    expect(response).toMatchObject({ success: false, error: ErrorCodes.OPERATION_FAILED });
    expect(failureEvents()).toHaveLength(1);
    expect(failureEvents()[0]).toMatchObject({
        schemaVersion: 1,
        event: 'ipc.operation.failed',
        channel: 'renderer:report-error',
        error: {
            type: 'Error',
            message: 'Falha ao registrar',
            code: 'EIO',
            stack: expect.any(String),
            cause: { message: 'Falha [URL omitida]' },
        },
    });
    expect(JSON.stringify(jest.mocked(log.error).mock.calls)).not.toContain(secret);
});

test('report do renderer preserva stack e componentStack em diagnóstico estruturado e sanitizado', async () => {
    const { invoke } = setup();
    expect(
        await invoke('renderer:report-error', {
            message: `Falha ${tracker}`,
            source: 'ErrorBoundary',
            stack: 'Error: Falha\n at render (file:///C:/Users/PessoaSintetica/app.js:1:2)',
            componentStack: '\n at App (/home/PessoaSintetica/App.tsx:1:2)',
        }),
    ).toMatchObject({ success: true });
    const call = jest
        .mocked(log.error)
        .mock.calls.find((entry) => (entry[1] as LogContext)?.event === 'renderer.error')!;
    expect(call).toHaveLength(2);
    expect(call[1]).toMatchObject({
        schemaVersion: 1,
        channel: 'renderer:report-error',
        source: 'ErrorBoundary',
        traceId: origin.traceId,
        error: {
            type: 'RendererError',
            message: 'Falha [URL omitida]',
            stack: expect.stringContaining('at render'),
            componentStack: expect.stringContaining('at App'),
        },
    });
    expect(JSON.stringify(call)).not.toContain(secret);
    expect(JSON.stringify(call)).not.toContain('PessoaSintetica');
});

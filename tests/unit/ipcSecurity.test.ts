import { EventEmitter } from 'events';
import { resolve } from 'path';
import { ipcMain, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { stat } from 'fs/promises';
import { registerIpcHandlers, _rateLimiter } from '../../main/ipcHandler';
import { rendererSecurity } from '../../main/rendererSecurity';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';
import type { AppSettings, IPCResponse } from '../../shared/types';
import { MAX_TORRENT_BYTES } from '../../shared/validators';
import { ErrorCodes } from '../../shared/errorCodes';

jest.mock('electron', () => ({
    ipcMain: { handle: jest.fn() },
    dialog: { showOpenDialog: jest.fn() },
    shell: { openPath: jest.fn(async () => ''), showItemInFolder: jest.fn() },
}));
jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    existsSync: jest.fn(() => true),
    statSync: jest.fn(() => ({ isDirectory: () => true })),
    accessSync: jest.fn(),
}));
jest.mock('fs/promises', () => ({
    ...jest.requireActual('fs/promises'),
    realpath: jest.fn(async (folder: string) => require('path').resolve(folder)),
    lstat: jest.fn(async () => ({ isSymbolicLink: () => false })),
    stat: jest.fn().mockResolvedValue({ isDirectory: () => true, isFile: () => false }),
    access: jest.fn().mockResolvedValue(undefined),
}));

const rendererUrl = 'file:///C:/Meshy/renderer/index.html';
const hash = 'a'.repeat(40);
let window: EventEmitter;

function setup(filePath = 'video.mp4') {
    const frame = { url: rendererUrl };
    const contents = { id: 1, mainFrame: frame, isDestroyed: () => false };
    window = Object.assign(new EventEmitter(), { webContents: contents });
    rendererSecurity.trustWindow(window as unknown as BrowserWindow, rendererUrl);
    const event = {
        sender: contents,
        senderFrame: frame,
    } as unknown as Electron.IpcMainInvokeEvent;
    const item = { infoHash: hash, status: 'completed', destinationFolder: '/fixture/downloads' };
    const manager = {
        getAll: jest.fn(() => [item]),
        remove: jest.fn(async () => {}),
        addTorrentBuffer: jest.fn(async () => item),
        getFiles: jest.fn(() => [{ path: filePath, selected: true }]),
    };
    const settings = {
        get: jest.fn((): AppSettings => ({
            destinationFolder: '/fixture/downloads',
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
        })),
        set: jest.fn(),
    };
    registerIpcHandlers(
        manager as unknown as DownloadManager,
        settings as unknown as SettingsManager,
    );
    const handlers = new Map<
        string,
        (event: unknown, payload?: unknown) => Promise<IPCResponse<unknown>>
    >((ipcMain.handle as jest.Mock).mock.calls.map(([name, handler]) => [name, handler]));
    const invoke = (channel: string, payload?: unknown, sender: unknown = event) =>
        handlers.get(channel)!(sender, payload);
    return { frame, contents, event, manager, settings, handlers, invoke };
}

beforeEach(() => {
    jest.clearAllMocks();
    _rateLimiter.reset();
});
afterEach(() => window?.emit('closed'));

test('todos os canais rejeitam renderer desconhecido antes de qualquer efeito', async () => {
    const { handlers, manager, settings } = setup();
    const frame = { url: rendererUrl };
    const foreign = {
        sender: { id: 2, mainFrame: frame, isDestroyed: () => false },
        senderFrame: frame,
    };
    for (const handler of handlers.values())
        expect(await handler(foreign, { infoHash: hash, deleteFiles: true })).toEqual({
            success: false,
            error: ErrorCodes.INVALID_PARAMS,
        });
    expect(manager.remove).not.toHaveBeenCalled();
    expect(manager.getAll).not.toHaveBeenCalled();
    expect(settings.set).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
});

test('bloqueia subframes, frames ausentes e documento alterado em janela autorizada', async () => {
    const { invoke, event, frame, manager } = setup();
    for (const sender of [
        null,
        { ...event, senderFrame: null },
        { ...event, senderFrame: { url: rendererUrl } },
    ])
        expect(
            await invoke('torrent:remove', { infoHash: hash, deleteFiles: true }, sender),
        ).toEqual({
            success: false,
            error: ErrorCodes.INVALID_PARAMS,
        });
    frame.url = 'http://localhost.attacker.example/';
    expect((await invoke('torrent:remove', { infoHash: hash, deleteFiles: true })).success).toBe(
        false,
    );
    expect(manager.remove).not.toHaveBeenCalled();
    frame.url = rendererUrl;
    expect((await invoke('torrent:remove', { infoHash: hash, deleteFiles: false })).success).toBe(
        true,
    );
    expect(manager.remove).toHaveBeenCalledWith(hash, false);
});

test('chamadas não autorizadas não consomem a cota do renderer legítimo', async () => {
    const { invoke } = setup();
    for (let i = 0; i < 501; i++) await invoke('torrent:get-all', undefined, null);
    expect((await invoke('torrent:get-all')).success).toBe(true);
});

test.each(['Uint8Array', 'ArrayBuffer', 'Buffer'])('rejeita %s acima do limite', async (kind) => {
    const { invoke, manager } = setup();
    const data = new Uint8Array(MAX_TORRENT_BYTES + 1);
    data[0] = 100;
    const buffer =
        kind === 'ArrayBuffer' ? data.buffer : kind === 'Buffer' ? Buffer.from(data) : data;
    expect(await invoke('torrent:add-file-buffer', { buffer })).toEqual({
        success: false,
        error: ErrorCodes.INVALID_FILE_PATH,
    });
    expect(manager.addTorrentBuffer).not.toHaveBeenCalled();
});

test('aceita o limite exato de buffer e preserva os bytes', async () => {
    const { invoke, manager } = setup();
    const buffer = new Uint8Array(MAX_TORRENT_BYTES);
    buffer[0] = 100;
    expect((await invoke('torrent:add-file-buffer', { buffer })).success).toBe(true);
    expect(manager.addTorrentBuffer).toHaveBeenCalledWith(Buffer.from(buffer));
});

test.each([
    'payload.exe',
    'payload.EXE',
    'script.cmd',
    'script.sh',
    'app.desktop',
    'run',
    'page.html',
    'image.svg',
])('revela %s sem iniciar sua aplicação padrão', async (filePath) => {
    const { invoke } = setup(filePath);
    expect((await invoke('torrent:open-file', { infoHash: hash })).success).toBe(true);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(resolve('/fixture/downloads', filePath));
    expect(shell.openPath).not.toHaveBeenCalled();
});

test('abre mídia permitida pelo caminho contido do torrent', async () => {
    const { invoke } = setup('video.MP4');
    expect((await invoke('torrent:open-file', { infoHash: hash })).success).toBe(true);
    expect(shell.openPath).toHaveBeenCalledWith(resolve('/fixture/downloads', 'video.MP4'));
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
});

test('open-folder não usa um arquivo como diretório para iniciar executáveis', async () => {
    const { invoke } = setup();
    jest.mocked(stat).mockResolvedValueOnce({ isDirectory: () => false } as Awaited<
        ReturnType<typeof stat>
    >);
    expect(await invoke('torrent:open-folder', { infoHash: hash })).toEqual({
        success: false,
        error: ErrorCodes.DESTINATION_FOLDER_NOT_FOUND,
    });
    expect(shell.openPath).not.toHaveBeenCalled();
});

test.each([
    { globalTrackers: 123 },
    { globalTrackers: ['http://127.0.0.1/announce'] },
    { globalTrackers: ['file:///fixture/input'] },
    { globalTrackers: [null] },
    { globalTrackers: new Array(1) },
    { autoApplyGlobalTrackers: 'yes' },
    [],
])('rejeita settings inválidos antes de persistir: %j', async (payload) => {
    const { invoke, settings } = setup();
    expect((await invoke('settings:set', payload)).success).toBe(false);
    expect(settings.set).not.toHaveBeenCalled();
});

test('preserva a gravação de configurações válidas de trackers', async () => {
    const { invoke, settings } = setup();
    const payload = {
        globalTrackers: ['udp://tracker.example.com:6969/announce'],
        autoApplyGlobalTrackers: true,
    };
    expect((await invoke('settings:set', payload)).success).toBe(true);
    expect(settings.set).toHaveBeenCalledWith(payload);
});

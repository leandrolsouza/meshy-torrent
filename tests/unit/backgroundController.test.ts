import { EventEmitter } from 'events';
import { createBackgroundController } from '../../main/backgroundController';
import { app, Tray } from 'electron';
import type { BrowserWindow } from 'electron';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';

jest.mock('electron', () => {
    const { EventEmitter: Emitter } = jest.requireActual('events');
    return {
        app: Object.assign(new Emitter(), { quit: jest.fn() }),
        Tray: jest.fn(() =>
            Object.assign(new Emitter(), {
                setToolTip: jest.fn(),
                setContextMenu: jest.fn(),
                isDestroyed: jest.fn(() => false),
                destroy: jest.fn(),
            }),
        ),
        nativeImage: {
            createFromPath: jest.fn(() => ({
                resize() {
                    return this;
                },
                setTemplateImage: jest.fn(),
            })),
        },
        Menu: { buildFromTemplate: jest.fn((template) => template) },
        dialog: { showErrorBox: jest.fn() },
    };
});
function setup(closeToTray = true) {
    const items = [
        { infoHash: 'active', status: 'downloading' },
        { infoHash: 'queued', status: 'queued' },
        { infoHash: 'paused', status: 'paused' },
    ];
    const manager = Object.assign(new EventEmitter(), {
        getAll: () => items,
        pause: jest.fn(async () => { }),
        resume: jest.fn(async () => { }),
        persistSession: jest.fn(),
    });
    const showWindow = jest.fn();
    const controller = createBackgroundController({
        manager: manager as unknown as DownloadManager,
        settings: { get: () => ({ closeToTray, locale: 'en-US' }) } as SettingsManager,
        iconPath: 'icon.png',
        showWindow,
    });
    const window = Object.assign(new EventEmitter(), { hide: jest.fn() });
    controller.attachWindow(window as unknown as BrowserWindow);
    const tray = jest.mocked(Tray).mock.results[jest.mocked(Tray).mock.results.length - 1]!
        .value as EventEmitter & { setContextMenu: jest.Mock; destroy: jest.Mock };
    return { controller, manager, window, tray, showWindow };
}
afterEach(() => {
    jest.clearAllMocks();
});
test('fechar oculta apenas com preferência ativa e conserva sessão', () => {
    const { controller, window, manager, tray, showWindow } = setup();
    const preventDefault = jest.fn();
    window.emit('close', { preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(window.hide).toHaveBeenCalled();
    expect(manager.persistSession).toHaveBeenCalled();
    tray.emit('click');
    expect(showWindow).toHaveBeenCalled();
    controller.dispose();
    expect(tray.destroy).toHaveBeenCalled();
});
test('Encerrar Meshy Torrent não fica preso no handler de ocultar janela', () => {
    const { controller, window, tray } = setup();
    const menu = tray.setContextMenu.mock.calls[0]![0];
    menu.find((item: { label: string }) => item.label === 'Quit Meshy Torrent').click();
    expect(app.quit).toHaveBeenCalled();
    app.emit('before-quit');
    const preventDefault = jest.fn();
    window.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    controller.dispose();
});
test('preferência desativada permite fechar normalmente', () => {
    const { controller, window } = setup(false);
    const preventDefault = jest.fn();
    window.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
    controller.dispose();
});
test('pausar todos esvazia a fila antes de liberar slots; retomar usa proteção do manager', async () => {
    const { controller, manager, tray } = setup();
    const menu = tray.setContextMenu.mock.calls[0]![0];
    menu.find((item: { label: string }) => item.label === 'Pause all').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.pause.mock.calls).toEqual([['queued'], ['active']]);
    menu.find((item: { label: string }) => item.label === 'Resume paused').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.resume).toHaveBeenCalledWith('paused');
    controller.dispose();
});
test('se a bandeja falhar, fechar continua permitido e não deixa janela inacessível', () => {
    jest.mocked(Tray).mockImplementationOnce(() => {
        throw new Error('No tray');
    });
    const { controller, window } = setup();
    const preventDefault = jest.fn();
    window.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    controller.dispose();
});

test('permite fechar para atualização antes de before-quit e restaura a bandeja após falha', () => {
    const { controller, window } = setup();
    const preventDefault = jest.fn();
    controller.setQuitting(true);
    window.emit('close', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    controller.setQuitting(false);
    window.emit('close', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    controller.dispose();
});

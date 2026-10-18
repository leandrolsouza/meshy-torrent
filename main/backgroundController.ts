import { app, Tray, Menu, nativeImage, dialog } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import type { DownloadManager } from './downloadManager';
import type { SettingsManager } from './settingsManager';
import { logger } from './logger';
import ptBR from '../src/locales/pt-BR.json';
import enUS from '../src/locales/en-US.json';

export function createBackgroundController(options: {
    manager: DownloadManager;
    settings: SettingsManager;
    iconPath: string;
    showWindow: () => void;
}) {
    let quitting = false;
    let busy = false;
    let tray: Tray | undefined;
    const messages = (): Record<string, string> =>
        options.settings.get().locale === 'en-US' ? enUS : ptBR;
    const text = (id: string) => messages()[id] ?? id;
    const update = () => {
        if (!tray || tray.isDestroyed()) return;
        const items = options.manager.getAll();
        const active = items.filter((item) =>
            ['downloading', 'resolving-metadata', 'queued'].includes(item.status),
        );
        const paused = items.filter((item) => item.status === 'paused' && !item.fileOperation);
        tray.setToolTip(`Meshy Torrent — ${active.length} ${text('tray.activeDownloads')}`);
        const template: MenuItemConstructorOptions[] = [
            { label: text('tray.show'), click: options.showWindow },
            { type: 'separator' },
            {
                label: text('tray.pauseAll'),
                enabled: !busy && active.length > 0,
                click: () => void perform('pause'),
            },
            {
                label: text('tray.resumeAll'),
                enabled: !busy && paused.length > 0,
                click: () => void perform('resume'),
            },
            { type: 'separator' },
            { label: text('tray.quit'), click: () => app.quit() },
        ];
        tray.setContextMenu(Menu.buildFromTemplate(template));
    };
    const perform = async (operation: 'pause' | 'resume') => {
        if (busy) return;
        busy = true;
        update();
        let failed = false;
        try {
            const items = options.manager.getAll().filter((item) => !item.fileOperation);
            // Pausar a fila primeiro evita iniciar o próximo ao liberar cada slot ativo.
            items.sort((a, b) => Number(b.status === 'queued') - Number(a.status === 'queued'));
            for (const item of items) {
                const applicable =
                    operation === 'pause'
                        ? ['downloading', 'resolving-metadata', 'queued'].includes(item.status)
                        : item.status === 'paused';
                if (!applicable) continue;
                try {
                    await options.manager[operation](item.infoHash);
                } catch {
                    failed = true;
                }
            }
            options.manager.persistSession();
            if (failed) dialog.showErrorBox('Meshy Torrent', text('tray.operationFailed'));
        } catch (error) {
            logger.warn('[Main] Falha em ação da bandeja:', error);
            dialog.showErrorBox('Meshy Torrent', text('tray.operationFailed'));
        } finally {
            busy = false;
            update();
        }
    };
    try {
        const icon = nativeImage.createFromPath(options.iconPath).resize({ width: 22, height: 22 });
        if (process.platform === 'darwin') icon.setTemplateImage(true);
        tray = new Tray(icon);
        tray.on('double-click', options.showWindow);
        tray.on('click', options.showWindow);
        tray.on('right-click', update);
        update();
    } catch (error) {
        logger.warn('[Main] Bandeja indisponível:', error);
    }
    const beforeQuit = () => {
        quitting = true;
    };
    app.on('before-quit', beforeQuit);
    options.manager.on('update', update);
    options.manager.on('remove', update);
    return {
        setQuitting(value: boolean) {
            quitting = value;
        },
        attachWindow(window: BrowserWindow) {
            window.on('close', (event) => {
                if (
                    !quitting &&
                    options.settings.get().closeToTray &&
                    tray &&
                    !tray.isDestroyed()
                ) {
                    event.preventDefault();
                    window.hide();
                    options.manager.persistSession();
                }
            });
        },
        dispose() {
            quitting = true;
            options.manager.removeListener('update', update);
            options.manager.removeListener('remove', update);
            app.removeListener('before-quit', beforeQuit);
            tray?.destroy();
        },
    };
}

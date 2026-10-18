import { Notification, BrowserWindow } from 'electron';
import type { DownloadManager } from './downloadManager';
import type { SettingsManager } from './settingsManager';
import type { DownloadItem } from '../shared/types';
import { formatBytes, formatDuration } from '../shared/formatters';
import { logger as defaultLogger } from './logger';
import type { Logger } from './logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NotificationManager {
    /** Para de escutar eventos do DownloadManager */
    dispose(): void;
}

export interface CreateNotificationManagerOptions {
    /** Janela principal — usada para focar o app ao clicar na notificação */
    mainWindow?: BrowserWindow;
    /** Logger injetável (padrão: electron-log) */
    log?: Logger;
}

/**
 * Foca/restaura a janela principal do app.
 * Trata janela minimizada, oculta ou em segundo plano.
 */
function focusMainWindow(mainWindow: BrowserWindow | undefined): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Cria um NotificationManager que escuta eventos do DownloadManager
 * e exibe notificações nativas do OS quando um download completa ou falha.
 *
 * Respeita a configuração `notificationsEnabled` do SettingsManager.
 *
 * Ao clicar na notificação, a janela principal do app é focada/restaurada.
 */
export function createNotificationManager(
    downloadManager: DownloadManager,
    settings: SettingsManager,
    options: CreateNotificationManagerOptions = {},
): NotificationManager {
    const _log = options.log ?? defaultLogger;
    const mainWindow = options.mainWindow;

    // Rastrear status anterior para detectar transições
    const previousStatus = new Map<string, string>();

    const onUpdate = (item: DownloadItem): void => {
        const prev = previousStatus.get(item.infoHash);
        previousStatus.set(item.infoHash, item.status);

        // Só notificar em transições de status
        if (prev === item.status) return;

        // Verificar se notificações estão habilitadas
        if (!settings.get().notificationsEnabled) return;

        // Verificar suporte a notificações
        if (!Notification.isSupported()) {
            _log.info('[NotificationManager] Notificações não suportadas neste sistema');
            return;
        }

        if (
            (item.status === 'completed' || item.status === 'seeding') &&
            prev !== 'completed' &&
            prev !== 'seeding'
        ) {
            const sizeStr = formatBytes(item.totalSize);
            const durationStr = item.elapsedMs ? ` em ${formatDuration(item.elapsedMs)}` : '';
            const notification = new Notification({
                title: 'Download concluído',
                body: `${item.name} (${sizeStr})${durationStr}`,
                silent: false,
            });
            notification.on('click', () => focusMainWindow(mainWindow));
            notification.show();
            _log.info(`[NotificationManager] Notificação: download concluído — ${item.name}`);
        }

        if (item.status === 'error') {
            const notification = new Notification({
                title: 'Erro no download',
                body: `Falha ao baixar "${item.name}"`,
                silent: false,
            });
            notification.on('click', () => focusMainWindow(mainWindow));
            notification.show();
            _log.info(`[NotificationManager] Notificação: erro no download — ${item.name}`);
        }

        if (item.status === 'metadata-failed') {
            const notification = new Notification({
                title: 'Falha nos metadados',
                body: `Não foi possível obter metadados de "${item.name}"`,
                silent: false,
            });
            notification.on('click', () => focusMainWindow(mainWindow));
            notification.show();
            _log.info(`[NotificationManager] Notificação: falha nos metadados — ${item.name}`);
        }
    };

    // Limpar o rastreamento de status quando um torrent é removido
    const onRemove = (infoHash: string): void => {
        previousStatus.delete(infoHash);
    };

    downloadManager.on('update', onUpdate);
    downloadManager.on('remove', onRemove);

    return {
        dispose(): void {
            downloadManager.removeListener('update', onUpdate);
            downloadManager.removeListener('remove', onRemove);
            previousStatus.clear();
        },
    };
}

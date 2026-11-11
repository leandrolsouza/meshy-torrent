import { EventEmitter } from 'events';
import { createNotificationManager } from '../../main/notificationManager';
import type { DownloadItem } from '../../shared/types';
import type { DownloadManager } from '../../main/downloadManager';
import type { SettingsManager } from '../../main/settingsManager';

jest.mock('electron', () => ({
    Notification: Object.assign(
        jest.fn().mockImplementation(() => ({
            on: jest.fn(),
            show: jest.fn(),
        })),
        { isSupported: jest.fn(() => true) },
    ),
}));

const NotificationMock = jest.requireMock('electron').Notification as jest.Mock & {
    isSupported: jest.Mock;
};

function createItem(status: DownloadItem['status']): DownloadItem {
    return {
        infoHash: 'a'.repeat(40),
        name: 'download',
        status,
        totalSize: 1024,
        elapsedMs: 1000,
    } as DownloadItem;
}

test('resolve a janela atual no clique e remove os listeners ao descartar', () => {
    NotificationMock.mockClear();
    const manager = Object.assign(new EventEmitter(), { getAll: () => [] });
    const settings = { get: () => ({ notificationsEnabled: true }) };
    const initialWindow = {
        isDestroyed: jest.fn(() => true),
        isMinimized: jest.fn(() => false),
        show: jest.fn(),
        focus: jest.fn(),
        restore: jest.fn(),
    };
    const currentWindow = {
        isDestroyed: jest.fn(() => false),
        isMinimized: jest.fn(() => false),
        show: jest.fn(),
        focus: jest.fn(),
        restore: jest.fn(),
    };
    let activeWindow = initialWindow;
    const notificationManager = createNotificationManager(
        manager as unknown as DownloadManager,
        settings as unknown as SettingsManager,
        { getMainWindow: () => activeWindow as never },
    );

    manager.emit('update', createItem('completed'));

    const notification = NotificationMock.mock.results[0]?.value as {
        on: jest.Mock;
        show: jest.Mock;
    };
    const clickHandler = notification.on.mock.calls[0]?.[1] as () => void;
    activeWindow = currentWindow;
    clickHandler();

    expect(initialWindow.show).not.toHaveBeenCalled();
    expect(currentWindow.show).toHaveBeenCalledTimes(1);
    expect(currentWindow.focus).toHaveBeenCalledTimes(1);

    notificationManager.dispose();
    expect(manager.listenerCount('update')).toBe(0);
    expect(manager.listenerCount('remove')).toBe(0);
});

test('não notifica conclusões restauradas, mas notifica uma nova conclusão', () => {
    NotificationMock.mockClear();
    const completed = createItem('completed');
    const seeding = { ...createItem('seeding'), infoHash: 'b'.repeat(40) };
    const downloading = { ...createItem('downloading'), infoHash: 'c'.repeat(40) };
    const manager = Object.assign(new EventEmitter(), {
        getAll: () => [completed, seeding, downloading],
    });
    const settings = { get: () => ({ notificationsEnabled: true }) };
    const notifications = createNotificationManager(
        manager as unknown as DownloadManager,
        settings as unknown as SettingsManager,
    );

    manager.emit('update', { ...completed, status: 'seeding' });
    manager.emit('update', { ...seeding, status: 'completed' });
    expect(NotificationMock).not.toHaveBeenCalled();

    manager.emit('update', { ...downloading, status: 'completed' });
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    manager.emit('update', { ...downloading, status: 'seeding' });
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    notifications.dispose();
});

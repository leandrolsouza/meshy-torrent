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
    const manager = new EventEmitter();
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

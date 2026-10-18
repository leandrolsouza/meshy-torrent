// Os testes de payload usam um renderer autorizado; o remetente é coberto em ipcSecurity.
jest.mock('../../main/rendererSecurity', () => ({
    isTrustedIpcSender: jest.fn(() => true),
}));

import fc from 'fast-check';
import { createSettingsManager, SettingsStore } from '../../main/settingsManager';
import { registerIpcHandlers } from '../../main/ipcHandler';
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
}));

const { ipcMain: mockIpcMain } = require('electron') as {
    ipcMain: { handle: jest.Mock };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createFakeStore(initial: Record<string, unknown> = {}): SettingsStore {
    const data = new Map<string, unknown>(Object.entries(initial));
    return {
        get: (key) => data.get(key) as any,
        set: (key, value) => {
            data.set(key, value);
        },
    };
}

const FAKE_DOWNLOADS_PATH = '/home/testuser/Downloads';

function makeManager(storeData: Record<string, unknown> = {}) {
    return createSettingsManager({
        store: createFakeStore(storeData),
        getDownloadsPath: () => FAKE_DOWNLOADS_PATH,
    });
}

function makeMockDownloadManager(): DownloadManager {
    return {
        addTorrentFile: jest.fn(),
        addMagnetLink: jest.fn(),
        pause: jest.fn().mockResolvedValue(undefined),
        resume: jest.fn().mockResolvedValue(undefined),
        remove: jest.fn().mockResolvedValue(undefined),
        getAll: jest.fn().mockReturnValue([]),
        restoreSession: jest.fn().mockResolvedValue(undefined),
        persistSession: jest.fn(),
        setMaxConcurrentDownloads: jest.fn(),
        on: jest.fn(),
    } as unknown as DownloadManager;
}

function makeMockSettingsManager(): SettingsManager {
    const store = createFakeStore();
    const manager = createSettingsManager({
        store,
        getDownloadsPath: () => FAKE_DOWNLOADS_PATH,
    });
    return manager;
}

/**
 * Registers IPC handlers and returns the handler function for a given channel.
 */
function getIpcHandler(channel: string): (event: unknown, payload: unknown) => Promise<unknown> {
    mockIpcMain.handle.mockClear();

    const dm = makeMockDownloadManager();
    const sm = makeMockSettingsManager();
    registerIpcHandlers(dm, sm);

    const call = mockIpcMain.handle.mock.calls.find(([ch]: [string]) => ch === channel);
    if (!call) {
        throw new Error(`IPC handler for channel "${channel}" not found`);
    }
    return call[1];
}

// ─── Supported locales ────────────────────────────────────────────────────────

const SUPPORTED_LOCALES = ['pt-BR', 'en-US'] as const;

// ─── Property-Based Tests ─────────────────────────────────────────────────────

// Feature: i18n-support, Property 6: Locale persistence round-trip
describe('Property 6: Locale persistence round-trip', () => {
    // **Validates: Requirements 4.1, 5.3**
    it('persisting a supported locale via set() and retrieving via get().locale returns the same locale', () => {
        fc.assert(
            fc.property(fc.constantFrom(...SUPPORTED_LOCALES), (locale) => {
                const manager = makeManager();

                manager.set({ locale });
                const result = manager.get().locale;

                expect(result).toBe(locale);
            }),
            { numRuns: 100 },
        );
    });
});

// Feature: i18n-support, Property 7: Unrecognized locale fallback
describe('Property 7: Unrecognized locale fallback', () => {
    // **Validates: Requirements 3.3, 4.4**

    it('settingsManager defaults to pt-BR when no locale has been persisted', () => {
        fc.assert(
            fc.property(
                // Generate arbitrary strings that are NOT supported locales to use as
                // other settings values — the point is that regardless of other state,
                // an uninitialised locale always defaults to pt-BR.
                fc.string({ minLength: 0, maxLength: 20 }),
                (_arbitraryString) => {
                    const manager = makeManager(); // no locale in store
                    const result = manager.get().locale;

                    expect(result).toBe('pt-BR');
                },
            ),
            { numRuns: 100 },
        );
    });

    it('settings:set rejects non-string locale values with error.settings.invalidLocale', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    fc.integer(),
                    fc.boolean(),
                    fc.constant(null),
                    fc.double(),
                    fc.array(fc.string()),
                    fc.dictionary(fc.string(), fc.string()),
                ),
                async (invalidLocale) => {
                    const handler = getIpcHandler('settings:set');
                    const result = (await handler(null, { locale: invalidLocale })) as {
                        success: boolean;
                        error?: string;
                    };

                    expect(result.success).toBe(false);
                    expect(result.error).toBe(ErrorCodes.INVALID_LOCALE);
                },
            ),
            { numRuns: 100 },
        );
    });

    it('settings:set rejects empty and whitespace-only locale strings with error.settings.invalidLocale', async () => {
        await fc.assert(
            fc.asyncProperty(
                // Generate strings that are empty or contain only whitespace
                fc
                    .string({ unit: fc.constantFrom(' ', '\t', '\n', '\r') })
                    .filter((s) => s.trim() === ''),
                async (blankLocale) => {
                    const handler = getIpcHandler('settings:set');
                    const result = (await handler(null, { locale: blankLocale })) as {
                        success: boolean;
                        error?: string;
                    };

                    expect(result.success).toBe(false);
                    expect(result.error).toBe(ErrorCodes.INVALID_LOCALE);
                },
            ),
            { numRuns: 100 },
        );
    });
});

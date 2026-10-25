import { createSettingsManager } from '../../main/settingsManager';
import type { SettingsStore } from '../../main/settingsManager';
import fc from 'fast-check';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Cria um store em memória que satisfaz a interface SettingsStore.
 * Evita acesso ao sistema de arquivos ou dependência do Electron.
 */
function createFakeStore(initial: Record<string, unknown> = {}): SettingsStore {
    const data = new Map<string, unknown>(Object.entries(initial));
    return {
        get: (key) => data.get(key) as any,
        set: (key, value) => {
            data.set(key, value);
        },
        setMany: (values) => {
            for (const [key, value] of Object.entries(values)) data.set(key, value);
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

// ─── Property-Based Tests ─────────────────────────────────────────────────────

// Feature: theme-switcher, Property 4: Round-trip de persistência de tema
describe('Property 4: Round-trip de persistência de tema', () => {
    // **Validates: Requirements 2.1, 5.2**
    it('set({ theme: id }) seguido de get().theme retorna o mesmo id para qualquer string não-vazia', () => {
        fc.assert(
            fc.property(fc.string({ minLength: 1 }), (themeId) => {
                const manager = makeManager();

                manager.set({ theme: themeId });
                const result = manager.get().theme;

                expect(result).toBe(themeId);
            }),
            { numRuns: 100 },
        );
    });
});

/**
 * Testes unitários para o downloadStore (Zustand).
 *
 * Cobre: setItems, mergeItems, updateItem, removeItem.
 * Foco especial no merge inteligente que preserva status local 'error'.
 */
import type { DownloadItem } from '../../shared/types';

// ─── Helper: cria um DownloadItem com valores padrão ──────────────────────────

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
    return {
        infoHash: 'abc123',
        name: 'Test Torrent',
        totalSize: 1024 * 1024,
        downloadedSize: 0,
        progress: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        numSeeders: 0,
        timeRemaining: Infinity,
        status: 'downloading',
        destinationFolder: '/tmp',
        addedAt: Date.now(),
        ...overrides,
    };
}

// ─── Import store after helpers ───────────────────────────────────────────────

import { useDownloadStore } from '../../src/store/downloadStore';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('downloadStore', () => {
    beforeEach(() => {
        // Resetar o store entre testes
        useDownloadStore.setState({ items: [] });
    });

    // ── setItems ──────────────────────────────────────────────────────────

    describe('setItems', () => {
        it('substitui a lista inteira de items', () => {
            const items = [makeItem({ infoHash: 'a' }), makeItem({ infoHash: 'b' })];

            useDownloadStore.getState().setItems(items);

            expect(useDownloadStore.getState().items).toHaveLength(2);
            expect(useDownloadStore.getState().items[0].infoHash).toBe('a');
            expect(useDownloadStore.getState().items[1].infoHash).toBe('b');
        });

        it('substitui items existentes por uma nova lista', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'old' })]);
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'new' })]);

            expect(useDownloadStore.getState().items).toHaveLength(1);
            expect(useDownloadStore.getState().items[0].infoHash).toBe('new');
        });

        it('aceita lista vazia', () => {
            useDownloadStore.getState().setItems([makeItem()]);
            useDownloadStore.getState().setItems([]);

            expect(useDownloadStore.getState().items).toHaveLength(0);
        });
    });

    // ── updateItem ────────────────────────────────────────────────────────

    describe('updateItem', () => {
        it('atualiza um item existente pelo infoHash', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'a', progress: 0 })]);

            useDownloadStore.getState().updateItem(makeItem({ infoHash: 'a', progress: 0.5 }));

            expect(useDownloadStore.getState().items[0].progress).toBe(0.5);
        });

        it('adiciona o item se não existir (append)', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'a' })]);

            useDownloadStore.getState().updateItem(makeItem({ infoHash: 'b' }));

            expect(useDownloadStore.getState().items).toHaveLength(2);
            expect(useDownloadStore.getState().items[1].infoHash).toBe('b');
        });

        it('não duplica items ao atualizar', () => {
            useDownloadStore
                .getState()
                .setItems([makeItem({ infoHash: 'a' }), makeItem({ infoHash: 'b' })]);

            useDownloadStore.getState().updateItem(makeItem({ infoHash: 'a', progress: 1 }));

            expect(useDownloadStore.getState().items).toHaveLength(2);
        });
    });

    // ── removeItem ────────────────────────────────────────────────────────

    describe('removeItem', () => {
        it('remove o item pelo infoHash', () => {
            useDownloadStore
                .getState()
                .setItems([makeItem({ infoHash: 'a' }), makeItem({ infoHash: 'b' })]);

            useDownloadStore.getState().removeItem('a');

            expect(useDownloadStore.getState().items).toHaveLength(1);
            expect(useDownloadStore.getState().items[0].infoHash).toBe('b');
        });

        it('não altera a lista se o infoHash não existir', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'a' })]);

            useDownloadStore.getState().removeItem('inexistente');

            expect(useDownloadStore.getState().items).toHaveLength(1);
        });

        it('resulta em lista vazia ao remover o último item', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'a' })]);

            useDownloadStore.getState().removeItem('a');

            expect(useDownloadStore.getState().items).toHaveLength(0);
        });
    });

    // ── mergeItems ────────────────────────────────────────────────────────

    describe('mergeItems', () => {
        it('adiciona novos items do snapshot remoto', () => {
            useDownloadStore.getState().setItems([]);

            useDownloadStore.getState().mergeItems([makeItem({ infoHash: 'a', progress: 0.5 })]);

            expect(useDownloadStore.getState().items).toHaveLength(1);
            expect(useDownloadStore.getState().items[0].progress).toBe(0.5);
        });

        it('atualiza items existentes com dados do snapshot remoto', () => {
            useDownloadStore
                .getState()
                .setItems([makeItem({ infoHash: 'a', progress: 0.2, downloadSpeed: 100 })]);

            useDownloadStore
                .getState()
                .mergeItems([makeItem({ infoHash: 'a', progress: 0.8, downloadSpeed: 500 })]);

            const item = useDownloadStore.getState().items[0];
            expect(item.progress).toBe(0.8);
            expect(item.downloadSpeed).toBe(500);
        });

        it('preserva referências e não notifica quando o snapshot é idêntico', () => {
            const item = makeItem({ infoHash: 'a', progress: 0.5 });
            const items = [item];
            useDownloadStore.getState().setItems(items);
            const currentItems = useDownloadStore.getState().items;
            const listener = jest.fn();
            const unsubscribe = useDownloadStore.subscribe(listener);

            useDownloadStore.getState().mergeItems([{ ...item }]);

            expect(useDownloadStore.getState().items).toBe(currentItems);
            expect(useDownloadStore.getState().items[0]).toBe(item);
            expect(listener).not.toHaveBeenCalled();
            unsubscribe();
        });

        it('mantém a referência dos itens inalterados quando outro item muda', () => {
            const unchangedItem = makeItem({ infoHash: 'a', progress: 0.5 });
            const changedItem = makeItem({ infoHash: 'b', progress: 0.2 });
            const currentItems = [unchangedItem, changedItem];
            useDownloadStore.getState().setItems(currentItems);

            useDownloadStore
                .getState()
                .mergeItems([{ ...unchangedItem }, { ...changedItem, progress: 0.8 }]);

            const merged = useDownloadStore.getState().items;
            expect(merged).not.toBe(currentItems);
            expect(merged[0]).toBe(unchangedItem);
            expect(merged[1]).not.toBe(changedItem);
            expect(merged[1].progress).toBe(0.8);
        });

        it('preserva status local "error" quando o remoto ainda mostra "downloading"', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'a', status: 'error' })]);

            useDownloadStore
                .getState()
                .mergeItems([makeItem({ infoHash: 'a', status: 'downloading', progress: 0.5 })]);

            const item = useDownloadStore.getState().items[0];
            expect(item.status).toBe('error');
            expect(item.progress).toBe(0.5);
        });

        it('NÃO preserva status local "error" quando o remoto também mostra "error"', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'a', status: 'error' })]);

            useDownloadStore
                .getState()
                .mergeItems([makeItem({ infoHash: 'a', status: 'error', progress: 0.3 })]);

            const item = useDownloadStore.getState().items[0];
            expect(item.status).toBe('error');
            expect(item.progress).toBe(0.3);
        });

        it('NÃO preserva status local "error" quando o remoto mostra "completed"', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'a', status: 'error' })]);

            useDownloadStore
                .getState()
                .mergeItems([makeItem({ infoHash: 'a', status: 'completed' })]);

            expect(useDownloadStore.getState().items[0].status).toBe('completed');
        });

        it('aceita status "paused" do remoto sem preservar status local', () => {
            useDownloadStore
                .getState()
                .setItems([makeItem({ infoHash: 'a', status: 'downloading' })]);

            useDownloadStore.getState().mergeItems([makeItem({ infoHash: 'a', status: 'paused' })]);

            expect(useDownloadStore.getState().items[0].status).toBe('paused');
        });

        it('remove items locais que não estão no snapshot remoto', () => {
            useDownloadStore
                .getState()
                .setItems([makeItem({ infoHash: 'a' }), makeItem({ infoHash: 'b' })]);

            useDownloadStore.getState().mergeItems([makeItem({ infoHash: 'a' })]);

            expect(useDownloadStore.getState().items).toHaveLength(1);
            expect(useDownloadStore.getState().items[0].infoHash).toBe('a');
        });

        it('funciona com lista vazia (limpa tudo)', () => {
            useDownloadStore.getState().setItems([makeItem({ infoHash: 'a' })]);

            useDownloadStore.getState().mergeItems([]);

            expect(useDownloadStore.getState().items).toHaveLength(0);
        });
    });
});

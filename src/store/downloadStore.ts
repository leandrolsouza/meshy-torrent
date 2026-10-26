import { create } from 'zustand';
import type { DownloadItem } from '../../shared/types';

// ─── Store interface ──────────────────────────────────────────────────────────

interface DownloadStore {
    items: DownloadItem[];
    setItems(items: DownloadItem[]): void;
    mergeItems(incoming: DownloadItem[]): void;
    updateItem(item: DownloadItem): void;
    removeItem(infoHash: string): void;
}

function itemsEqual(left: DownloadItem, right: DownloadItem): boolean {
    const leftKeys = Object.keys(left) as (keyof DownloadItem)[];
    const rightKeys = Object.keys(right) as (keyof DownloadItem)[];
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every(
            (key) =>
                Object.prototype.hasOwnProperty.call(right, key) &&
                Object.is(left[key], right[key]),
        )
    );
}

// ─── Store implementation ─────────────────────────────────────────────────────

export const useDownloadStore = create<DownloadStore>((set) => ({
    items: [],

    /**
     * Replaces the entire items array.
     * Usado para carga inicial (getAll) onde não há estado local a preservar.
     */
    setItems(items: DownloadItem[]): void {
        set({ items });
    },

    /**
     * Merge inteligente: atualiza a lista com o snapshot do main process.
     *
     * O main process é a fonte de verdade absoluta. O status no main process
     * é atualizado sincronamente ANTES das operações assíncronas do engine,
     * então o snapshot sempre reflete o estado correto.
     *
     * A única exceção é o status 'error' definido localmente via onError,
     * que pode chegar antes do próximo snapshot de progresso.
     */
    mergeItems(incoming: DownloadItem[]): void {
        set((state) => {
            const localMap = new Map(state.items.map((item) => [item.infoHash, item]));
            let unchanged = incoming.length === state.items.length;

            const merged = incoming.map((remote, index) => {
                const local = localMap.get(remote.infoHash);
                if (!local) {
                    unchanged = false;
                    return remote;
                }

                // Preservar status local 'error' quando o main ainda reporta 'downloading'.
                // O onError do renderer pode marcar como error antes do próximo snapshot.
                const reconciled =
                    local.status === 'error' && remote.status === 'downloading'
                        ? { ...remote, status: local.status }
                        : remote;
                const item = itemsEqual(local, reconciled) ? local : reconciled;

                if (item !== local || state.items[index] !== local) unchanged = false;
                return item;
            });

            if (unchanged) return state;
            return { items: merged };
        });
    },

    /**
     * Finds the item by infoHash and replaces it.
     * If the item is not found, it is appended to the list.
     */
    updateItem(item: DownloadItem): void {
        set((state) => {
            const index = state.items.findIndex((i) => i.infoHash === item.infoHash);
            if (index === -1) {
                return { items: [...state.items, item] };
            }
            const updated = [...state.items];
            updated[index] = item;
            return { items: updated };
        });
    },

    /**
     * Filters out the item with the given infoHash.
     */
    removeItem(infoHash: string): void {
        set((state) => ({
            items: state.items.filter((i) => i.infoHash !== infoHash),
        }));
    },
}));

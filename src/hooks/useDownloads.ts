import { useEffect, useRef, useCallback } from 'react';
import type {
    DownloadItem,
    IPCResponse,
    TorrentFileInfo,
    TorrentErrorEvent,
} from '../../shared/types';
import { useDownloadStore } from '../store/downloadStore';

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Manages the downloads state by:
 * - Registering a `window.meshy.onProgress` listener that updates the store every second.
 * - Registering a `window.meshy.onError` listener to handle torrent errors.
 * - Exposing action functions that delegate to the contextBridge API.
 *
 * Cleans up all listeners on unmount.
 */
export function useDownloads() {
    const { mergeItems, updateItem, removeItem } = useDownloadStore();

    // Rastreia operações de pause/resume em andamento por infoHash
    // para evitar chamadas duplicadas quando o usuário clica rapidamente.
    const pendingOps = useRef(new Set<string>());

    // ── Register IPC event listeners ──────────────────────────────────────────

    useEffect(() => {
        // onProgress: main process emits the full list of active items every second.
        const removeProgressListener = window.meshy.onProgress((items: DownloadItem[]) => {
            mergeItems(items);
        });

        // onError: main process emits an error event for a specific torrent
        const removeErrorListener = window.meshy.onError((data: TorrentErrorEvent) => {
            console.error(`[useDownloads] Torrent error for ${data.infoHash}: ${data.message}`, {
                traceContext: data.traceContext,
            });
            // Update the item status to 'error' in the store
            const items = useDownloadStore.getState().items;
            const item = items.find((i) => i.infoHash === data.infoHash);
            if (item) {
                updateItem({ ...item, status: 'error' });
            }
        });

        // Cleanup: remove both listeners when the component unmounts
        return () => {
            removeProgressListener();
            removeErrorListener();
        };
    }, [mergeItems, updateItem]);

    // ── Actions ───────────────────────────────────────────────────────────────

    /**
     * Adds a torrent from a local `.torrent` file path.
     * Updates the store with the new item on success.
     */
    async function addTorrentFile(filePath: string): Promise<IPCResponse<DownloadItem>> {
        const response = await window.meshy.addTorrentFile(filePath);
        if (response.success) {
            updateItem(response.data);
        }
        return response;
    }

    /**
     * Adds a torrent from a magnet URI.
     * Updates the store with the new item on success.
     */
    async function addMagnetLink(magnetUri: string): Promise<IPCResponse<DownloadItem>> {
        const response = await window.meshy.addMagnetLink(magnetUri);
        if (response.success) {
            updateItem(response.data);
        }
        return response;
    }

    /**
     * Pauses the torrent with the given infoHash.
     * Ignora chamadas duplicadas enquanto uma operação está em andamento.
     */
    const pause = useCallback(
        async (infoHash: string): Promise<IPCResponse<void>> => {
            const opKey = `pause:${infoHash}`;
            if (pendingOps.current.has(opKey)) {
                return { success: true, data: undefined };
            }
            pendingOps.current.add(opKey);
            try {
                const response = await window.meshy.pause(infoHash);
                if (response.success) {
                    const item = useDownloadStore
                        .getState()
                        .items.find((i) => i.infoHash === infoHash);
                    if (item) {
                        updateItem({ ...item, status: 'paused' });
                    }
                }
                return response;
            } finally {
                pendingOps.current.delete(opKey);
            }
        },
        [updateItem],
    );

    /**
     * Resumes the torrent with the given infoHash.
     * Ignora chamadas duplicadas enquanto uma operação está em andamento.
     */
    const resume = useCallback(
        async (infoHash: string): Promise<IPCResponse<void>> => {
            const opKey = `resume:${infoHash}`;
            if (pendingOps.current.has(opKey)) {
                return { success: true, data: undefined };
            }
            pendingOps.current.add(opKey);
            try {
                const response = await window.meshy.resume(infoHash);
                if (response.success) {
                    const item = useDownloadStore
                        .getState()
                        .items.find((i) => i.infoHash === infoHash);
                    if (item) {
                        if (item.completedAt !== undefined && item.progress === 1) {
                            const snapshot = await window.meshy.getAll();
                            if (snapshot.success) mergeItems(snapshot.data);
                        } else updateItem({ ...item, status: 'downloading' });
                    }
                }
                return response;
            } finally {
                pendingOps.current.delete(opKey);
            }
        },
        [updateItem, mergeItems],
    );

    /**
     * Removes the torrent with the given infoHash.
     * Optionally deletes the downloaded files.
     */
    async function remove(infoHash: string, deleteFiles: boolean): Promise<IPCResponse<void>> {
        const response = await window.meshy.remove(infoHash, deleteFiles);
        if (response.success) {
            removeItem(infoHash);
        }
        return response;
    }

    /**
     * Retrieves the list of files for a torrent identified by infoHash.
     */
    async function getFiles(infoHash: string): Promise<IPCResponse<TorrentFileInfo[]>> {
        return window.meshy.getFiles(infoHash);
    }

    /**
     * Applies file selection for a torrent: selects the given indices, deselects the rest.
     */
    async function setFileSelection(
        infoHash: string,
        selectedIndices: number[],
    ): Promise<IPCResponse<TorrentFileInfo[]>> {
        return window.meshy.setFileSelection(infoHash, selectedIndices);
    }

    /**
     * Reordena um item na fila de downloads para a nova posição.
     */
    async function reorderQueue(
        infoHash: string,
        newIndex: number,
    ): Promise<IPCResponse<string[]>> {
        return window.meshy.reorderQueue(infoHash, newIndex);
    }

    /**
     * Retorna a ordem atual da fila de downloads.
     */
    async function getQueueOrder(): Promise<IPCResponse<string[]>> {
        return window.meshy.getQueueOrder();
    }

    return {
        items: useDownloadStore((state) => state.items),
        addTorrentFile,
        addMagnetLink,
        pause,
        resume,
        remove,
        getFiles,
        setFileSelection,
        reorderQueue,
        getQueueOrder,
    };
}

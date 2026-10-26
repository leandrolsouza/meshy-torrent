import { dialog, shell } from 'electron';
import { existsSync, accessSync, statSync, constants as fsConstants } from 'fs';
import { resolve, basename } from 'path';
import type {
    DownloadItem,
    IPCResponse,
    TorrentFileInfo,
    TorrentMetadata,
    PeerInfo,
    PieceStatus,
} from '../../shared/types';
import type { TorrentSource } from '../../shared/types';
import {
    isValidTorrentFile,
    hasTorrentMagicBytes,
    MAX_TORRENT_BYTES,
} from '../../shared/validators';
import { logger } from '../logger';
import { resolveTorrentFile } from '../torrentFiles';
import { canOpenDownloadedFile } from '../fileOpening';
import type { IpcHandlerContext } from './context';

const IPC_TIMEOUT_MS = 30_000;

function hasWritePermission(dirPath: string): boolean {
    try {
        accessSync(dirPath, fsConstants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function withTimeout<T>(
    promise: Promise<T>,
    _channel: string,
    timeoutMs = IPC_TIMEOUT_MS,
): Promise<T> {
    return new Promise<T>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
            reject(
                Object.assign(new Error(`Operação expirou após ${timeoutMs}ms`), {
                    code: 'ERR_REQUEST_TIMEOUT',
                }),
            );
        }, timeoutMs);

        promise
            .then((result) => {
                clearTimeout(timer);
                resolvePromise(result);
            })
            .catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}
export function registerTorrentIpcHandlers({
    trackedHandle,
    downloadManager,
    torrentEngine,
    preparation,
    desktop,
    ok,
    fail,
    failWithLog,
    validatePayload,
    infoHashSchema,
    infoHashHexSchema,
    errorCodes: ErrorCodes,
}: IpcHandlerContext): void {
    trackedHandle('dialog:select-torrent-files', async (): Promise<IPCResponse<string[]>> => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openFile', 'multiSelections'],
                filters: [{ name: 'Torrent', extensions: ['torrent'] }],
            });
            if (result.canceled || !result.filePaths.length)
                return fail(ErrorCodes.NO_FILE_SELECTED);
            return ok(result.filePaths.slice(0, 200));
        } catch (error) {
            return failWithLog('dialog:select-torrent-files', error);
        }
    });

    // ── torrent:add-file ──────────────────────────────────────────────────────
    const requestSchema = { requestId: { type: 'string' as const, nonEmpty: true } };
    const requestIdFor = (payload: unknown): string => {
        const result = validatePayload<{ requestId: string }>(payload, requestSchema);
        if (!result.valid || !/^[a-zA-Z0-9-]{8,80}$/.test(result.data.requestId))
            throw new Error(ErrorCodes.INVALID_PARAMS);
        return result.data.requestId;
    };
    const selectionFor = (
        event: Electron.IpcMainInvokeEvent,
        payload: unknown,
    ): { requestId: string; destinationFolder: string; selectedIndices: number[] } => {
        const requestId = scopedRequestId(event, requestIdFor(payload));
        const data = payload as Record<string, unknown>;
        if (
            typeof data.destinationFolder !== 'string' ||
            !data.destinationFolder.trim() ||
            !Array.isArray(data.selectedIndices)
        )
            throw new Error(ErrorCodes.INVALID_PARAMS);
        const selectedIndices: number[] = [];
        for (const index of data.selectedIndices) {
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0)
                throw new Error(ErrorCodes.FILE_INDEX_INVALID);
            selectedIndices.push(index);
        }
        if (!preparation) throw new Error(ErrorCodes.ENGINE_NOT_AVAILABLE);
        const draft = preparation.get(requestId);
        if (
            !selectedIndices.every((index) =>
                draft.preview.files.some((file) => file.index === index),
            )
        )
            throw new Error(ErrorCodes.FILE_INDEX_INVALID);
        return {
            requestId,
            destinationFolder: resolve(data.destinationFolder),
            selectedIndices: [...new Set(selectedIndices)],
        };
    };

    const scopedRequestId = (event: Electron.IpcMainInvokeEvent, requestId: string): string => {
        if (
            event.senderFrame &&
            event.sender?.mainFrame &&
            event.senderFrame !== event.sender.mainFrame
        )
            throw new Error(ErrorCodes.INVALID_PARAMS);
        return `${event.sender?.id ?? 0}-${requestId}`;
    };

    trackedHandle('torrent:prepare', async (_event, payload) => {
        try {
            const publicId = requestIdFor(payload);
            const requestId = scopedRequestId(_event, publicId);
            if (!preparation) return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
            const source = (payload as Record<string, unknown>).source as
                Record<string, unknown> | undefined;
            if (!source || typeof source !== 'object') return fail(ErrorCodes.INVALID_PARAMS);
            let input: TorrentSource;
            if (source.kind === 'magnet' && typeof source.magnetUri === 'string')
                input = { kind: 'magnet', magnetUri: source.magnetUri };
            else if (
                source.kind === 'file' &&
                typeof source.filePath === 'string' &&
                source.filePath.trim()
            )
                input = { kind: 'file', filePath: resolve(source.filePath) };
            else if (
                source.kind === 'buffer' &&
                source.buffer instanceof Uint8Array &&
                source.buffer.length > 0 &&
                source.buffer.length <= MAX_TORRENT_BYTES
            )
                input = { kind: 'buffer', buffer: source.buffer };
            else return fail(ErrorCodes.INVALID_PARAMS);
            const preview = await preparation.prepare(requestId, input);
            if (downloadManager.getAll().some((item) => item.infoHash === preview.infoHash)) {
                preparation.cancel(requestId);
                return fail(ErrorCodes.TORRENT_DUPLICATE);
            }
            return ok({ ...preview, requestId: publicId });
        } catch (error) {
            return failWithLog('torrent:prepare', error);
        }
    });
    trackedHandle('torrent:cancel-preparation', async (_event, payload) => {
        try {
            preparation?.cancel(scopedRequestId(_event, requestIdFor(payload)));
            return ok(undefined);
        } catch (error) {
            return failWithLog('torrent:cancel-preparation', error);
        }
    });
    trackedHandle('torrent:disk-space', async (_event, payload) => {
        try {
            const selection = selectionFor(_event, payload);
            const draft = preparation!.get(selection.requestId);
            const bytes = draft.preview.files
                .filter((file) => selection.selectedIndices.includes(file.index))
                .reduce((sum, file) => sum + file.length, 0);
            return ok(
                await downloadManager.getDiskSpace(
                    selection.destinationFolder,
                    bytes,
                    draft.preview.infoHash,
                ),
            );
        } catch (error) {
            return failWithLog('torrent:disk-space', error);
        }
    });
    const confirming = new Set<string>();
    trackedHandle('torrent:manage-files', async (_event, payload) => {
        const result = validatePayload<{ infoHash: string }>(payload, infoHashHexSchema);
        if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);
        const { operation, destinationFolder } = payload as Record<string, unknown>;
        if (
            !['locate', 'move', 'verify'].includes(String(operation)) ||
            (operation !== 'verify' &&
                (typeof destinationFolder !== 'string' || !destinationFolder.trim()))
        )
            return fail(ErrorCodes.INVALID_PARAMS);
        if (
            downloadManager.getAll().find((item) => item.infoHash === result.data.infoHash)
                ?.fileOperation
        )
            return fail(ErrorCodes.FILE_OPERATION_BUSY);
        try {
            return ok(
                await downloadManager.manageFiles(
                    result.data.infoHash,
                    operation as import('../../shared/types').FileOperation,
                    typeof destinationFolder === 'string' ? resolve(destinationFolder) : undefined,
                ),
            );
        } catch (error) {
            return failWithLog('torrent:manage-files', error);
        }
    });
    trackedHandle('torrent:confirm', async (_event, payload) => {
        let requestId: string | undefined;
        let ownsConfirmation = false;
        try {
            const selection = selectionFor(_event, payload);
            requestId = selection.requestId;
            if (selection.selectedIndices.length === 0)
                return fail(ErrorCodes.FILE_SELECTION_EMPTY);
            if (confirming.has(requestId)) return fail(ErrorCodes.INVALID_PARAMS);
            if (torrentEngine?.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);
            if (
                !existsSync(selection.destinationFolder) ||
                !hasWritePermission(selection.destinationFolder)
            )
                return fail(ErrorCodes.DESTINATION_FOLDER_NOT_FOUND);
            confirming.add(requestId);
            ownsConfirmation = true;
            const item = await downloadManager.addPreparedTorrent(
                preparation!.get(requestId),
                selection.destinationFolder,
                selection.selectedIndices,
            );
            preparation!.cancel(requestId);
            return ok(item);
        } catch (error) {
            return failWithLog('torrent:confirm', error);
        } finally {
            if (requestId && ownsConfirmation) confirming.delete(requestId);
        }
    });

    trackedHandle(
        'torrent:add-file',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ filePath: string }>(payload, {
                    filePath: { type: 'string', nonEmpty: true },
                });
                if (!result.valid) return fail(ErrorCodes.INVALID_FILE_PATH);

                // Resolver o caminho antes de qualquer validação ou uso.
                // Normaliza separadores e resolve componentes relativos como '..'.
                const filePath = resolve(result.data.filePath);

                // Validar extensão .torrent antes de ler o arquivo do filesystem
                if (!isValidTorrentFile(filePath)) {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                logger.info('[IPC] torrent:add-file início:', basename(filePath));
                const item = await withTimeout(
                    downloadManager.addTorrentFile(filePath),
                    'torrent:add-file',
                );
                logger.info('[IPC] torrent:add-file sucesso:', item.infoHash.slice(0, 8));
                return ok(item);
            } catch (err) {
                return failWithLog('torrent:add-file', err);
            }
        },
    );

    // ── torrent:add-file-buffer ───────────────────────────────────────────────
    // Adiciona um torrent a partir de um buffer (Uint8Array) enviado pelo renderer.
    // Necessário para drag-and-drop com sandbox: true, onde File.path não está disponível.
    trackedHandle(
        'torrent:add-file-buffer',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                // Validação manual do campo `buffer` proveniente do renderer.
                // `validatePayload` suporta apenas tipos primitivos (string/number/boolean) e
                // não pode validar Buffer/Uint8Array/ArrayBuffer diretamente. Os campos
                // validados aqui são:
                //   - `buffer`: presença no objeto payload
                //   - tipo compatível (Buffer, Uint8Array ou ArrayBuffer) — Electron serializa
                //     Uint8Array como objeto numérico ao cruzar o processo IPC
                //   - conteúdo não-vazio (length > 0)
                //   - magic bytes bencode (primeiro byte === 0x64), rejeitando arquivos que não
                //     sejam torrents antes de passá-los ao WebTorrent
                if (typeof payload !== 'object' || payload === null || !('buffer' in payload)) {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                const raw = (payload as Record<string, unknown>).buffer;

                if (
                    !(raw instanceof Uint8Array || raw instanceof ArrayBuffer) ||
                    raw.byteLength === 0 ||
                    raw.byteLength > MAX_TORRENT_BYTES
                )
                    return fail(ErrorCodes.INVALID_FILE_PATH);

                // O IPC do Electron serializa Uint8Array como objeto com dados numéricos.
                // Aceitar Buffer, Uint8Array, ou ArrayBuffer.
                let buffer: Buffer;
                if (Buffer.isBuffer(raw)) {
                    buffer = raw;
                } else if (raw instanceof Uint8Array) {
                    buffer = Buffer.from(raw);
                } else if (raw instanceof ArrayBuffer) {
                    buffer = Buffer.from(raw);
                } else {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                if (buffer.length === 0) {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                // Verificar magic bytes bencode: todo arquivo .torrent começa com 'd' (0x64),
                // indicador de dicionário bencode. Rejeita buffers que não sejam torrents
                // antes de enviá-los ao engine, consistente com a validação de extensão em
                // torrent:add-file.
                if (!hasTorrentMagicBytes(buffer)) {
                    return fail(ErrorCodes.INVALID_FILE_PATH);
                }

                logger.info('[IPC] torrent:add-file-buffer início:', buffer.length, 'bytes');
                const item = await withTimeout(
                    downloadManager.addTorrentBuffer(buffer),
                    'torrent:add-file-buffer',
                );
                logger.info('[IPC] torrent:add-file-buffer sucesso:', item.infoHash.slice(0, 8));
                return ok(item);
            } catch (err) {
                return failWithLog('torrent:add-file-buffer', err);
            }
        },
    );

    // ── torrent:add-magnet ────────────────────────────────────────────────────
    trackedHandle(
        'torrent:add-magnet',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ magnetUri: string }>(payload, {
                    magnetUri: { type: 'string', nonEmpty: true },
                });
                if (!result.valid) return fail(ErrorCodes.INVALID_MAGNET_URI);

                logger.info('[IPC] torrent:add-magnet início');
                const item = await withTimeout(
                    downloadManager.addMagnetLink(result.data.magnetUri),
                    'torrent:add-magnet',
                );
                logger.info('[IPC] torrent:add-magnet sucesso:', item.infoHash.slice(0, 8));
                return ok(item);
            } catch (err) {
                return failWithLog('torrent:add-magnet', err);
            }
        },
    );

    trackedHandle(
        'torrent:set-seeding-enabled',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);
                const result = validatePayload<{ infoHash: string; enabled: boolean }>(payload, {
                    ...infoHashSchema,
                    enabled: { type: 'boolean' },
                });
                if (!result.valid || !/^[a-f0-9]{40}$/i.test(result.data.infoHash))
                    return fail(ErrorCodes.INVALID_PARAMS);
                return ok(
                    await withTimeout(
                        downloadManager.setSeedingEnabled(
                            result.data.infoHash,
                            result.data.enabled,
                        ),
                        'torrent:set-seeding-enabled',
                    ),
                );
            } catch (err) {
                return failWithLog('torrent:set-seeding-enabled', err);
            }
        },
    );

    // ── torrent:pause ─────────────────────────────────────────────────────────
    trackedHandle('torrent:pause', async (_event, payload: unknown): Promise<IPCResponse<void>> => {
        try {
            if (torrentEngine?.isRestarting()) {
                return fail(ErrorCodes.ENGINE_RESTARTING);
            }

            const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
            if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

            await withTimeout(downloadManager.pause(result.data.infoHash), 'torrent:pause');
            return ok(undefined);
        } catch (err) {
            return failWithLog('torrent:pause', err);
        }
    });

    // ── torrent:resume ────────────────────────────────────────────────────────
    trackedHandle(
        'torrent:resume',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                await withTimeout(downloadManager.resume(result.data.infoHash), 'torrent:resume');
                return ok(undefined);
            } catch (err) {
                return failWithLog('torrent:resume', err);
            }
        },
    );

    // ── torrent:remove ────────────────────────────────────────────────────────
    trackedHandle(
        'torrent:remove',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ infoHash: string; deleteFiles: boolean }>(
                    payload,
                    {
                        infoHash: { type: 'string', nonEmpty: true },
                        deleteFiles: { type: 'boolean' },
                    },
                );
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                await withTimeout(
                    downloadManager.remove(result.data.infoHash, result.data.deleteFiles),
                    'torrent:remove',
                );
                return ok(undefined);
            } catch (err) {
                return failWithLog('torrent:remove', err);
            }
        },
    );

    // ── torrent:get-all ───────────────────────────────────────────────────────
    trackedHandle('torrent:get-all', async (_event): Promise<IPCResponse<DownloadItem[]>> => {
        try {
            const items = downloadManager.getAll();
            return ok(desktop?.diagnostics?.enrich(items) ?? items);
        } catch (err) {
            return failWithLog('torrent:get-all', err);
        }
    });

    // ── dialog:select-torrent-file ────────────────────────────────────────────
    // Abre o diálogo nativo do SO para selecionar um arquivo .torrent.
    // Necessário porque sandbox: true impede o acesso a File.path no renderer.
    trackedHandle('dialog:select-torrent-file', async (_event): Promise<IPCResponse<string>> => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openFile'],
                filters: [{ name: 'Torrent', extensions: ['torrent'] }],
            });

            if (result.canceled || result.filePaths.length === 0) {
                return fail(ErrorCodes.NO_FILE_SELECTED);
            }

            // noUncheckedIndexedAccess: filePaths[0] garantido pela guarda length === 0 acima
            return ok(result.filePaths[0]!);
        } catch (err) {
            return failWithLog('dialog:select-torrent-file', err);
        }
    });

    // ── torrent:get-files ─────────────────────────────────────────────────────
    trackedHandle(
        'torrent:get-files',
        async (_event, payload: unknown): Promise<IPCResponse<TorrentFileInfo[]>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;

                // Check if torrent exists in the download manager
                const allItems = downloadManager.getAll();
                const item = allItems.find((i) => i.infoHash === infoHash);

                if (!item) {
                    return fail(ErrorCodes.TORRENT_NOT_FOUND);
                }

                // If torrent is resolving metadata, return empty array
                if (item.status === 'resolving-metadata') {
                    return ok([]);
                }

                if (!torrentEngine && !downloadManager.getFiles) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                const files =
                    downloadManager.getFiles?.(infoHash) ?? torrentEngine!.getFiles(infoHash);
                return ok(files);
            } catch (err) {
                return failWithLog('torrent:get-files', err);
            }
        },
    );

    // ── torrent:set-file-selection ────────────────────────────────────────────
    trackedHandle(
        'torrent:set-file-selection',
        async (_event, payload: unknown): Promise<IPCResponse<TorrentFileInfo[]>> => {
            try {
                // Campos validados via validatePayload:
                //   - `infoHash`: string não-vazia, identifica o torrent alvo
                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;

                // `selectedIndices` é um array de inteiros e não pode ser validado pelo
                // validatePayload (suporta apenas tipos primitivos). Validação manual:
                //   - deve ser um array não-vazio
                //   - cada elemento deve ser um inteiro não-negativo
                //   - cada índice deve estar dentro do intervalo [0, totalFiles - 1]
                const rawIndices = (payload as Record<string, unknown>).selectedIndices;

                if (!Array.isArray(rawIndices) || rawIndices.length === 0) {
                    return fail(ErrorCodes.FILE_SELECTION_EMPTY);
                }

                for (const idx of rawIndices) {
                    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) {
                        return fail(ErrorCodes.FILE_INDEX_INVALID);
                    }
                }

                const selectedIndices = rawIndices as number[];

                // Check if torrent exists
                const allItems = downloadManager.getAll();
                const item = allItems.find((i) => i.infoHash === infoHash);

                if (!item) {
                    return fail(ErrorCodes.TORRENT_NOT_FOUND);
                }

                if (!torrentEngine) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                // Validação de índices fora de range: obtém o número real de arquivos do
                // torrent e rejeita qualquer índice >= totalFiles. Também rejeita quando
                // o torrent ainda não possui arquivos conhecidos (totalFiles === 0), pois
                // índices seriam inválidos independente do valor.
                const currentFiles = torrentEngine.getFiles(infoHash);
                const totalFiles = currentFiles.length;

                if (totalFiles === 0) {
                    return fail(ErrorCodes.FILE_INDEX_INVALID);
                }

                for (const idx of selectedIndices) {
                    if (idx >= totalFiles) {
                        return fail(ErrorCodes.FILE_INDEX_INVALID);
                    }
                }

                const updatedFiles = downloadManager.setFileSelection(infoHash, selectedIndices);
                return ok(updatedFiles);
            } catch (err) {
                return failWithLog('torrent:set-file-selection', err);
            }
        },
    );

    // ── torrent:retry ─────────────────────────────────────────────────────────
    trackedHandle(
        'torrent:retry',
        async (_event, payload: unknown): Promise<IPCResponse<DownloadItem>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const item = await withTimeout(
                    downloadManager.retryDownload(result.data.infoHash),
                    'torrent:retry',
                );
                return ok(item);
            } catch (err) {
                return failWithLog('torrent:retry', err);
            }
        },
    );

    // ── torrent:open-folder ───────────────────────────────────────────────────
    // Abre a pasta de destino do download no gerenciador de arquivos do SO.
    trackedHandle(
        'torrent:open-folder',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;

                // Buscar o DownloadItem correspondente
                const allItems = downloadManager.getAll();
                const item = allItems.find((i) => i.infoHash === infoHash);

                if (!item) {
                    return fail(ErrorCodes.TORRENT_NOT_FOUND);
                }

                // Verificar se a pasta de destino existe
                if (
                    !existsSync(item.destinationFolder) ||
                    !statSync(item.destinationFolder).isDirectory()
                ) {
                    return fail(ErrorCodes.DESTINATION_FOLDER_NOT_FOUND);
                }

                // Abrir a pasta no gerenciador de arquivos do SO
                const shellError = await shell.openPath(item.destinationFolder);

                if (shellError) {
                    return fail(ErrorCodes.DESTINATION_OPEN_FAILED);
                }

                return ok(undefined);
            } catch (err) {
                return failWithLog('torrent:open-folder', err);
            }
        },
    );

    // ── torrent:open-file ────────────────────────────────────────────────────
    // Abre o arquivo baixado diretamente no aplicativo padrão do SO.
    trackedHandle(
        'torrent:open-file',
        async (_event, payload: unknown): Promise<IPCResponse<void>> => {
            try {
                if (torrentEngine?.isRestarting()) {
                    return fail(ErrorCodes.ENGINE_RESTARTING);
                }

                const result = validatePayload<{ infoHash: string }>(payload, infoHashSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;

                // Buscar o DownloadItem correspondente
                const allItems = downloadManager.getAll();
                const item = allItems.find((i) => i.infoHash === infoHash);

                if (!item) {
                    return fail(ErrorCodes.TORRENT_NOT_FOUND);
                }

                // Verificar se o download está concluído
                if (item.status !== 'completed' && item.status !== 'seeding') {
                    return fail(ErrorCodes.DESTINATION_NOT_COMPLETED);
                }

                // Obter a lista de arquivos do torrent
                if (!torrentEngine && !downloadManager.getFiles) {
                    return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                }

                const files =
                    downloadManager.getFiles?.(infoHash) ?? torrentEngine!.getFiles(infoHash);

                // Encontrar o primeiro arquivo selecionado
                const selectedFile = files.find((file) => file.selected === true);

                if (!selectedFile) {
                    return fail(ErrorCodes.DESTINATION_FILE_NOT_FOUND);
                }

                // Construir o caminho completo do arquivo
                const fullPath = await resolveTorrentFile(
                    item.destinationFolder,
                    selectedFile.path,
                );

                // Verificar se o arquivo existe
                if (!existsSync(fullPath)) {
                    return fail(ErrorCodes.DESTINATION_FILE_NOT_FOUND);
                }

                // Executáveis, scripts e formatos desconhecidos exigem ação no SO.
                if (!canOpenDownloadedFile(fullPath)) {
                    shell.showItemInFolder(fullPath);
                    return ok(undefined);
                }

                // Abrir o arquivo no aplicativo padrão do SO
                const shellError = await shell.openPath(fullPath);

                if (shellError) {
                    return fail(ErrorCodes.DESTINATION_OPEN_FAILED);
                }

                return ok(undefined);
            } catch (err) {
                return failWithLog('torrent:open-file', err);
            }
        },
    );

    // ── torrent:get-metadata ──────────────────────────────────────────────────
    // Retorna metadados detalhados do torrent (creator, comment, creationDate).
    trackedHandle(
        'torrent:get-metadata',
        async (_event, payload: unknown): Promise<IPCResponse<TorrentMetadata>> => {
            const result = validatePayload<{ infoHash: string }>(payload, infoHashHexSchema);
            if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

            const { infoHash } = result.data;
            const item = downloadManager.getAll().find((i) => i.infoHash === infoHash);
            if (!item) return fail(ErrorCodes.TORRENT_NOT_FOUND);

            if (!torrentEngine) return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
            if (torrentEngine.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);

            try {
                const metadata = torrentEngine.getMetadata(infoHash);
                return ok(metadata);
            } catch (err) {
                const cached = downloadManager.getCachedMetadata(infoHash);
                if (cached) return ok(cached);
                return failWithLog('torrent:get-metadata', err);
            }
        },
    );

    // ── torrent:get-peers ─────────────────────────────────────────────────────
    // Retorna a lista de peers conectados ao torrent.
    trackedHandle(
        'torrent:get-peers',
        async (_event, payload: unknown): Promise<IPCResponse<PeerInfo[]>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashHexSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;
                const item = downloadManager.getAll().find((i) => i.infoHash === infoHash);
                if (!item) return fail(ErrorCodes.TORRENT_NOT_FOUND);

                if (!torrentEngine) return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                if (torrentEngine.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);

                // Torrent em resolving-metadata retorna array vazio
                if (item.status === 'resolving-metadata') return ok([]);

                const peers = torrentEngine.getPeers(infoHash);
                return ok(peers);
            } catch (err) {
                return failWithLog('torrent:get-peers', err);
            }
        },
    );

    // ── torrent:get-pieces ────────────────────────────────────────────────────
    // Retorna o status de cada peça do torrent (true = completa, false = pendente).
    trackedHandle(
        'torrent:get-pieces',
        async (_event, payload: unknown): Promise<IPCResponse<PieceStatus>> => {
            try {
                const result = validatePayload<{ infoHash: string }>(payload, infoHashHexSchema);
                if (!result.valid) return fail(ErrorCodes.INVALID_PARAMS);

                const { infoHash } = result.data;
                const item = downloadManager.getAll().find((i) => i.infoHash === infoHash);
                if (!item) return fail(ErrorCodes.TORRENT_NOT_FOUND);

                if (!torrentEngine) return fail(ErrorCodes.ENGINE_NOT_AVAILABLE);
                if (torrentEngine.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);

                // Torrent em resolving-metadata retorna array vazio
                if (item.status === 'resolving-metadata') return ok([]);

                const pieces = torrentEngine.getPieces(infoHash);
                return ok(pieces);
            } catch (err) {
                return failWithLog('torrent:get-pieces', err);
            }
        },
    );
}

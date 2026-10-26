import { dialog } from 'electron';
import { access, stat } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { resolve } from 'path';
import type { AppSettings, IPCResponse } from '../../shared/types';
import { validateSettingsPayload } from '../settingsValidator';
import type { IpcHandlerContext } from './context';

async function hasWritePermission(dirPath: string): Promise<boolean> {
    try {
        const details = await stat(dirPath);
        if (!details.isDirectory()) return false;
        await access(dirPath, fsConstants.W_OK);
        return true;
    } catch {
        return false;
    }
}
export function registerSettingsIpcHandlers({
    trackedHandle,
    settingsManager,
    downloadManager,
    torrentEngine,
    ok,
    fail,
    failWithLog,
    errorCodes: ErrorCodes,
    applyBandwidth,
}: IpcHandlerContext): void {
    // O valor salvo representa a intenção; uma falha deixa sua aplicação pendente.
    // Ao iniciar outro processo, a engine já recebe as configurações persistidas.
    let networkRestartPending = false;

    // ── settings:get ──────────────────────────────────────────────────────────
    trackedHandle('settings:get', async (_event): Promise<IPCResponse<AppSettings>> => {
        try {
            const settings = settingsManager.get();
            return ok(settings);
        } catch (err) {
            return failWithLog('settings:get', err);
        }
    });

    // ── settings:set ──────────────────────────────────────────────────────────
    trackedHandle(
        'settings:set',
        async (_event, payload: unknown): Promise<IPCResponse<AppSettings>> => {
            try {
                if (torrentEngine?.isRestarting()) return fail(ErrorCodes.ENGINE_RESTARTING);
                if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
                    return fail(ErrorCodes.INVALID_SETTINGS_PAYLOAD);
                }

                const partial = payload as Partial<AppSettings>;

                // Validação declarativa de todos os campos
                const validationError = validateSettingsPayload(partial);
                if (validationError) {
                    return fail(validationError);
                }

                // Validar que a pasta de destino existe e tem permissão de escrita
                if (partial.destinationFolder !== undefined) {
                    // Resolver o caminho antes de validar (normaliza separadores, expande
                    // '..'). O caminho resolvido é também
                    // persistido para evitar caminhos relativos em configurações salvas.
                    const resolvedFolder = resolve(partial.destinationFolder);
                    if (!(await hasWritePermission(resolvedFolder))) {
                        return fail(ErrorCodes.INVALID_PARAMS);
                    }
                    partial.destinationFolder = resolvedFolder;
                }

                // Capturar configurações anteriores ANTES de persistir (para detecção de mudança)
                const previousSettings = settingsManager.get();
                const networkChanged =
                    (partial.dhtEnabled !== undefined &&
                        partial.dhtEnabled !== previousSettings.dhtEnabled) ||
                    (partial.pexEnabled !== undefined &&
                        partial.pexEnabled !== previousSettings.pexEnabled) ||
                    (partial.utpEnabled !== undefined &&
                        partial.utpEnabled !== previousSettings.utpEnabled);
                const needsNetworkRestart = networkChanged || networkRestartPending;

                if (
                    needsNetworkRestart &&
                    torrentEngine &&
                    downloadManager.getAll().some((item) => item.fileOperation)
                )
                    return fail(ErrorCodes.FILE_OPERATION_BUSY);

                settingsManager.set(partial);

                // Notificar o downloadManager sobre a mudança no limite de downloads simultâneos
                if (partial.maxConcurrentDownloads !== undefined) {
                    downloadManager.setMaxConcurrentDownloads(partial.maxConcurrentDownloads);
                }

                if (needsNetworkRestart && torrentEngine) {
                    const currentSettings = settingsManager.get();
                    networkRestartPending = true;
                    await torrentEngine.restart({
                        downloadPath: currentSettings.destinationFolder,
                        downloadSpeedLimit: currentSettings.downloadSpeedLimit,
                        uploadSpeedLimit: currentSettings.uploadSpeedLimit,
                        dhtEnabled: currentSettings.dhtEnabled,
                        pexEnabled: currentSettings.pexEnabled,
                        utpEnabled: currentSettings.utpEnabled,
                    });
                    networkRestartPending = false;
                }

                if (
                    partial.seedingEnabled !== undefined ||
                    partial.maxConcurrentSeeders !== undefined
                ) {
                    await downloadManager.applySeedingSettings();
                }
                const updated = settingsManager.get();
                applyBandwidth(needsNetworkRestart);
                return ok(updated);
            } catch (err) {
                return failWithLog('settings:set', err);
            }
        },
    );

    // ── settings:select-folder ────────────────────────────────────────────────
    trackedHandle('settings:select-folder', async (_event): Promise<IPCResponse<string>> => {
        try {
            const result = await dialog.showOpenDialog({
                properties: ['openDirectory'],
            });

            if (result.canceled || result.filePaths.length === 0) {
                return fail(ErrorCodes.NO_FOLDER_SELECTED);
            }

            // noUncheckedIndexedAccess: filePaths[0] garantido pela guarda length === 0 acima
            return ok(result.filePaths[0]!);
        } catch (err) {
            return failWithLog('settings:select-folder', err);
        }
    });
}

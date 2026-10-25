import type { IpcMainInvokeEvent } from 'electron';
import type { DownloadManager } from '../downloadManager';
import type { SettingsManager } from '../settingsManager';
import type { TorrentIpcEngine } from '../enginePorts';
import type { BandwidthController } from '../bandwidthController';
import type { DownloadDiagnostics } from '../downloadDiagnostics';
import type { TorrentPreparation } from '../torrentPreparation';
import type { ExternalTorrentInbox } from '../externalTorrents';
import type { UpdateManager } from '../updateManager';
import type { BandwidthStatus, IPCResponse, MagnetHandlerStatus } from '../../shared/types';
import type { PayloadSchema, ValidationResult } from '../payloadValidator';
import type { ScopedLogger } from '../logger';
import type { ErrorCodes } from '../../shared/errorCodes';

export type IpcHandler = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, payload: unknown) => Promise<IPCResponse<T>>,
) => void;

export interface DesktopIpcServices {
    inbox: ExternalTorrentInbox;
    registerMagnetHandler: () => Promise<MagnetHandlerStatus>;
    getMagnetHandlerStatus: () => Promise<MagnetHandlerStatus>;
    openMagnetDefaultApps: () => Promise<void>;
    bandwidth?: BandwidthController;
    diagnostics?: DownloadDiagnostics;
    updates?: UpdateManager;
}

export interface IpcHandlerContext {
    trackedHandle: IpcHandler;
    downloadManager: DownloadManager;
    settingsManager: SettingsManager;
    torrentEngine?: TorrentIpcEngine;
    preparation?: TorrentPreparation;
    desktop?: DesktopIpcServices;
    ok: <T>(data: T) => IPCResponse<T>;
    fail: (error: string) => IPCResponse<never>;
    failWithLog: (channel: string, error: unknown, scopedLog?: ScopedLogger) => IPCResponse<never>;
    validatePayload: <T>(payload: unknown, schema: PayloadSchema) => ValidationResult<T>;
    infoHashSchema: PayloadSchema;
    infoHashHexSchema: PayloadSchema;
    infoHashUrlSchema: PayloadSchema;
    urlSchema: PayloadSchema;
    errorCodes: typeof ErrorCodes;
    applyBandwidth: (force?: boolean) => BandwidthStatus;
}

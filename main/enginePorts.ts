import type { TorrentEngine } from './torrentEngine';

/** Operações de que o DownloadManager precisa para coordenar o ciclo de vida. */
export type DownloadManagerEngine = Pick<
    TorrentEngine,
    | 'addTorrentFile'
    | 'addTorrentBuffer'
    | 'addMagnetLink'
    | 'pause'
    | 'resume'
    | 'remove'
    | 'detachTorrent'
    | 'getTorrentFile'
    | 'getFiles'
    | 'getAll'
    | 'setFileSelection'
    | 'getMetadata'
    | 'addTracker'
    | 'isRestarting'
    | 'on'
>;

/** Ajuste de banda e observação do fim de um reinício do engine. */
export interface BandwidthControlEngine {
    isRestarting(): boolean;
    setDownloadSpeedLimit(kbps: number): void;
    setUploadSpeedLimit(kbps: number): void;
    on(event: 'restarted', listener: () => void): void;
    removeListener: TorrentEngine['removeListener'];
}

/** Consulta de trackers usada apenas para enriquecer diagnósticos. */
export type DownloadDiagnosticsEngine = Pick<TorrentEngine, 'getTrackers'>;

/** Capacidades do engine chamadas pelos handlers IPC. */
export type TorrentIpcEngine = Pick<
    TorrentEngine,
    | 'isRestarting'
    | 'setDownloadSpeedLimit'
    | 'setUploadSpeedLimit'
    | 'restart'
    | 'getFiles'
    | 'setFileSelection'
    | 'getMetadata'
    | 'getPeers'
    | 'getPieces'
    | 'getTrackers'
    | 'addTracker'
    | 'removeTracker'
>;

/** Evento de erro encaminhado à janela do renderer. */
export interface TorrentErrorEventSource {
    on(event: 'error', listener: (infoHash: string, error: Error) => void): void;
    removeListener: TorrentEngine['removeListener'];
}

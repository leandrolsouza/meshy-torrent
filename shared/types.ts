// ─── Shared types for Main Process and Renderer Process ──────────────────────
//
// Single source of truth for types used across both processes.
// Both tsconfig.node.json and tsconfig.web.json include this directory.

// ─── TrackerStatus ─────────────────────────────────────────────────────────────

/** Status de conexão de um tracker */
export type TrackerStatus = 'connected' | 'error' | 'pending';

/** Informações de um tracker associado a um torrent */
export interface TrackerInfo {
    url: string; // Tracker URL completa
    status: TrackerStatus; // Status de conexão atual
    message?: string; // Mensagem de erro (quando status === 'error')
}

// ─── TorrentStatus ────────────────────────────────────────────────────────────

export type TorrentStatus =
    | 'queued'
    | 'resolving-metadata'
    | 'downloading'
    | 'paused'
    | 'completed'
    | 'error'
    | 'metadata-failed'
    | 'files-not-found';

// ─── TorrentFileInfo ──────────────────────────────────────────────────────────

/** Representação de um arquivo individual dentro de um torrent */
export interface TorrentFileInfo {
    index: number; // índice no array torrent.files
    name: string; // nome do arquivo (ex: "video.mp4")
    path: string; // caminho relativo (ex: "Movie/video.mp4")
    length: number; // tamanho em bytes
    downloaded: number; // bytes já baixados
    selected: boolean; // se o arquivo está selecionado para download
}

// ─── DownloadItem ─────────────────────────────────────────────────────────────

export interface DownloadItem {
    infoHash: string;
    name: string;
    totalSize: number;
    downloadedSize: number;
    progress: number;
    downloadSpeed: number;
    uploadSpeed: number;
    numPeers: number;
    numSeeders: number;
    timeRemaining: number;
    status: TorrentStatus;
    destinationFolder: string;
    addedAt: number; // timestamp ms
    completedAt?: number; // timestamp ms
    elapsedMs?: number;
    selectedFileCount?: number; // quantidade de arquivos selecionados
    totalFileCount?: number; // quantidade total de arquivos
    errorMessage?: string; // mensagem de erro (quando status === 'error')
    queuePosition?: number; // posição na fila (1-based), undefined para não-enfileirados
    pauseReason?: 'disk-space';
    fileOperation?: FileOperation;
    diagnostic?: DownloadDiagnostic;
}

export type DownloadDiagnostic =
    | 'metadata'
    | 'metadata-failed'
    | 'queued'
    | 'disk-space'
    | 'folder-unavailable'
    | 'trackers-error'
    | 'no-peers'
    | 'no-selection'
    | 'stalled';

export type BatchAction = 'pause' | 'resume' | 'remove';
export interface BatchActionResult {
    infoHash: string;
    name: string;
    success: boolean;
    error?: string;
}

export interface BandwidthSettings {
    manualEnabled: boolean;
    downloadLimit: number; // KB/s, positivo
    uploadLimit: number; // KB/s, positivo
    scheduleEnabled: boolean;
    days: number[]; // dias locais em que o intervalo começa: domingo = 0
    start: string; // HH:mm, horário local
    end: string; // HH:mm; menor que start atravessa a meia-noite
}
export interface BandwidthStatus {
    mode: 'normal' | 'manual' | 'scheduled';
    downloadLimit: number; // KB/s, 0 = ilimitado
    uploadLimit: number; // KB/s, 0 = ilimitado
    manualEnabled: boolean;
}

// ─── PersistedDownloadItem ────────────────────────────────────────────────────

export interface PersistedDownloadItem {
    infoHash: string;
    name: string;
    totalSize: number;
    downloadedSize: number;
    progress: number;
    status: TorrentStatus;
    destinationFolder: string;
    addedAt: number;
    completedAt?: number;
    elapsedMs?: number;
    magnetUri?: string;
    torrentFilePath?: string;
    selectedFileIndices?: number[]; // índices dos arquivos selecionados
    errorMessage?: string; // mensagem de erro (persistida)
    pauseReason?: 'disk-space';
    /** Metadados confirmados, sem conteúdo dos arquivos; mantém trackers e flag private. */
    torrentFileBase64?: string;
    selectedFileCount?: number;
    totalFileCount?: number;
    files?: TorrentFileInfo[];
    creator?: string | null;
    comment?: string | null;
    creationDate?: number | null;
}

export type FileOperation = 'locate' | 'move' | 'verify';
export interface ExternalTorrentRequest {
    id: string;
    source: TorrentSource;
}

/** Metadados temporários: preparar não inicia o download dos arquivos. */
export interface TorrentPreview {
    requestId: string;
    infoHash: string;
    name: string;
    files: TorrentFileInfo[];
}

export type TorrentSource =
    | { kind: 'magnet'; magnetUri: string }
    | { kind: 'file'; filePath: string }
    | { kind: 'buffer'; buffer: Uint8Array; name?: string };

export interface DiskSpaceInfo {
    freeBytes: number;
    selectedBytes: number;
    reservedBytes: number;
    safetyMarginBytes: number;
    sufficient: boolean;
}

// ─── AppSettings ──────────────────────────────────────────────────────────────

export interface AppSettings {
    destinationFolder: string;
    downloadSpeedLimit: number; // KB/s, 0 = sem limite
    uploadSpeedLimit: number; // KB/s, 0 = sem limite
    maxConcurrentDownloads: number; // máx downloads simultâneos (1–10, padrão 3)
    notificationsEnabled: boolean; // notificações nativas do OS (padrão: true)
    theme: string; // identificador do tema ativo (ex: "vs-code-dark")
    locale: string; // identificador de locale BCP 47 (ex: "pt-BR", "en-US")
    globalTrackers: string[]; // lista de Tracker URLs favoritas (padrão: [])
    autoApplyGlobalTrackers: boolean; // aplicar automaticamente a novos torrents (padrão: false)
    // Configurações avançadas de rede
    dhtEnabled: boolean; // DHT — Distributed Hash Table (padrão: true)
    pexEnabled: boolean; // PEX — Peer Exchange (padrão: true)
    utpEnabled: boolean; // uTP — Micro Transport Protocol (padrão: true)
    closeToTray: boolean; // continuar baixando ao fechar a janela (padrão: false)
    bandwidth?: BandwidthSettings; // ausente em sessões anteriores; default desativado
}

// ─── TorrentMetadata ──────────────────────────────────────────────────────────

/** Metadados detalhados de um torrent */
export interface TorrentMetadata {
    infoHash: string; // hash de 40 caracteres hex
    creator: string | null; // criador do torrent (null se ausente)
    comment: string | null; // comentário do torrent (null se ausente)
    creationDate: number | null; // timestamp Unix em milissegundos (null se ausente)
}

// ─── PeerInfo ─────────────────────────────────────────────────────────────────

/** Informações de um peer conectado ao torrent */
export interface PeerInfo {
    address: string; // endereço no formato "ip:port"
    client: string; // identificador do cliente BitTorrent do peer
    downloadSpeed: number; // velocidade de download em bytes/s (>= 0)
    progress: number; // progresso do peer (0.0 a 1.0)
}

// ─── PieceStatus ──────────────────────────────────────────────────────────────

/**
 * Status de cada peça do torrent.
 * true = peça completa, false = peça pendente.
 * Comprimento = número total de peças do torrent.
 */
export type PieceStatus = boolean[];

// ─── IPCResponse ──────────────────────────────────────────────────────────────

export type IPCResponse<T> = { success: true; data: T } | { success: false; error: string };

export interface MagnetHandlerStatus {
    isDefault: boolean;
    canOpenDefaultApps: boolean;
    applicationName: string;
}

// ─── MeshyAPI ─────────────────────────────────────────────────────────────────

export type UpdateDisabledReason = 'development' | 'platform' | 'unsigned' | 'configuration';

export interface AppUpdateStatus {
    revision: number;
    currentVersion: string;
    phase:
    | 'disabled'
    | 'idle'
    | 'upToDate'
    | 'checking'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error';
    disabledReason?: UpdateDisabledReason;
    availableVersion?: string;
    /** Progresso de download de 0 a 100. */
    percent?: number;
    error?: string;
}

export interface MeshyAPI {
    getUpdateStatus(): Promise<IPCResponse<AppUpdateStatus>>;
    checkForUpdates(): Promise<IPCResponse<AppUpdateStatus>>;
    installUpdate(): Promise<IPCResponse<AppUpdateStatus>>;
    onUpdateStatus(callback: (status: AppUpdateStatus) => void): () => void;
    getBandwidthStatus(): Promise<IPCResponse<BandwidthStatus>>;
    setLightMode(enabled: boolean): Promise<IPCResponse<BandwidthStatus>>;
    batchAction(
        infoHashes: string[],
        operation: BatchAction,
        deleteFiles?: boolean,
    ): Promise<IPCResponse<BatchActionResult[]>>;
    selectTorrentFiles(): Promise<IPCResponse<string[]>>;
    prepareTorrent(requestId: string, source: TorrentSource): Promise<IPCResponse<TorrentPreview>>;
    cancelTorrentPreparation(requestId: string): Promise<IPCResponse<void>>;
    getDiskSpace(
        requestId: string,
        destinationFolder: string,
        selectedIndices: number[],
    ): Promise<IPCResponse<DiskSpaceInfo>>;
    confirmTorrent(
        requestId: string,
        destinationFolder: string,
        selectedIndices: number[],
    ): Promise<IPCResponse<DownloadItem>>;
    manageFiles(
        infoHash: string,
        operation: FileOperation,
        destinationFolder?: string,
    ): Promise<IPCResponse<DownloadItem>>;
    getExternalTorrentRequests(): Promise<IPCResponse<ExternalTorrentRequest[]>>;
    acknowledgeExternalTorrentRequest(id: string): Promise<IPCResponse<void>>;
    onExternalTorrentRequests(callback: (requests: ExternalTorrentRequest[]) => void): () => void;
    registerMagnetHandler(): Promise<IPCResponse<MagnetHandlerStatus>>;
    getMagnetHandlerStatus(): Promise<IPCResponse<MagnetHandlerStatus>>;
    openMagnetDefaultApps(): Promise<IPCResponse<void>>;
    // Commands
    addTorrentFile(filePath: string): Promise<IPCResponse<DownloadItem>>;
    addTorrentFileBuffer(buffer: Uint8Array): Promise<IPCResponse<DownloadItem>>;
    addMagnetLink(magnetUri: string): Promise<IPCResponse<DownloadItem>>;
    pause(infoHash: string): Promise<IPCResponse<void>>;
    resume(infoHash: string): Promise<IPCResponse<void>>;
    remove(infoHash: string, deleteFiles: boolean): Promise<IPCResponse<void>>;
    getAll(): Promise<IPCResponse<DownloadItem[]>>;
    getSettings(): Promise<IPCResponse<AppSettings>>;
    setSettings(partial: Partial<AppSettings>): Promise<IPCResponse<AppSettings>>;
    selectFolder(): Promise<IPCResponse<string>>;
    selectTorrentFile(): Promise<IPCResponse<string>>;
    // File selection
    getFiles(infoHash: string): Promise<IPCResponse<TorrentFileInfo[]>>;
    setFileSelection(
        infoHash: string,
        selectedIndices: number[],
    ): Promise<IPCResponse<TorrentFileInfo[]>>;
    // Trackers (por torrent)
    getTrackers(infoHash: string): Promise<IPCResponse<TrackerInfo[]>>;
    addTracker(infoHash: string, url: string): Promise<IPCResponse<TrackerInfo[]>>;
    removeTracker(infoHash: string, url: string): Promise<IPCResponse<TrackerInfo[]>>;
    applyGlobalTrackers(infoHash: string): Promise<IPCResponse<TrackerInfo[]>>;
    // Trackers globais
    getGlobalTrackers(): Promise<IPCResponse<string[]>>;
    addGlobalTracker(url: string): Promise<IPCResponse<string[]>>;
    removeGlobalTracker(url: string): Promise<IPCResponse<string[]>>;
    // Retry
    retryDownload(infoHash: string): Promise<IPCResponse<DownloadItem>>;
    // Destino — abrir pasta ou arquivo
    openFolder(infoHash: string): Promise<IPCResponse<void>>;
    openFile(infoHash: string): Promise<IPCResponse<void>>;
    // Fila de downloads — reordenação e consulta
    reorderQueue(infoHash: string, newIndex: number): Promise<IPCResponse<string[]>>;
    getQueueOrder(): Promise<IPCResponse<string[]>>;
    // Detalhes do torrent (painel de detalhes)
    getMetadata(infoHash: string): Promise<IPCResponse<TorrentMetadata>>;
    getPeers(infoHash: string): Promise<IPCResponse<PeerInfo[]>>;
    getPieces(infoHash: string): Promise<IPCResponse<PieceStatus>>;
    // Events
    onProgress(callback: (items: DownloadItem[]) => void): () => void;
    onError(callback: (data: { infoHash: string; message: string }) => void): () => void;
    // Observabilidade — reportar erros do renderer ao main process
    reportError(error: {
        message: string;
        source: string;
        stack?: string;
        componentStack?: string;
    }): void;
    // Observabilidade — obter métricas de operação do main process
    getMetrics(): Promise<IPCResponse<Record<string, unknown>>>;
}

// ─── Global window augmentation ───────────────────────────────────────────────

declare global {
    interface Window {
        meshy: MeshyAPI;
    }
}

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';
import {
    VscArrowDown,
    VscArrowUp,
    VscDebugPause,
    VscPlay,
    VscTrash,
    VscFolderOpened,
    VscGoToFile,
    VscInfo,
} from 'react-icons/vsc';
import type {
    DownloadItem as DownloadItemType,
    TorrentFileInfo,
    IPCResponse,
} from '../../../shared/types';
import { ProgressBar } from '../common/ProgressBar';
import { SpeedDisplay } from '../common/SpeedDisplay';
import { formatBytes } from '../../utils/formatters';
import { resolveErrorMessage } from '../../utils/resolveErrorMessage';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ActionMenu } from '../common/ActionMenu';
import { ManageFilesDialog } from './ManageFilesDialog';
import { FileSelector } from '../FileSelector/FileSelector';
import { TrackerPanel } from '../TrackerPanel/TrackerPanel';
import { DetailsPanel, isExpandable } from '../DownloadDetails/DetailsPanel';
import styles from './DownloadItem.module.css';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Detecta se o nome é um infoHash (hex longo) e retorna versão truncada. */
const HEX_HASH_RE = /^[0-9a-f]{32,}$/i;

function displayName(name: string): string {
    if (HEX_HASH_RE.test(name)) {
        return `${name.slice(0, 8)}…${name.slice(-8)}`;
    }
    return name;
}

function formatTimeParts(ms: number): string | null {
    if (!isFinite(ms) || ms <= 0) return null;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function progressVariant(status: DownloadItemType['status']): 'default' | 'success' | 'error' {
    if (status === 'completed') return 'success';
    if (status === 'error' || status === 'metadata-failed' || status === 'files-not-found')
        return 'error';
    return 'default';
}

const STATUS_LABEL_KEYS: Record<DownloadItemType['status'], string> = {
    queued: 'downloads.statusLabel.queued',
    'resolving-metadata': 'downloads.statusLabel.resolvingMetadata',
    downloading: 'downloads.statusLabel.downloading',
    paused: 'downloads.statusLabel.paused',
    completed: 'downloads.statusLabel.completed',
    error: 'downloads.statusLabel.error',
    'metadata-failed': 'downloads.statusLabel.metadataFailed',
    'files-not-found': 'downloads.statusLabel.filesNotFound',
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface DownloadItemProps {
    selected?: boolean;
    onSelectionToggle?: ((infoHash: string) => void) | undefined;
    selectionDisabled?: boolean;
    item: DownloadItemType;
    queueSize: number; // Tamanho total da fila (para desabilitar "mover para baixo")
    onPause: (infoHash: string) => Promise<unknown>;
    onResume: (infoHash: string) => Promise<unknown>;
    onRemove: (infoHash: string, deleteFiles: boolean) => Promise<IPCResponse<void>>;
    onMoveUp: (infoHash: string) => void;
    onMoveDown: (infoHash: string) => void;
    // Drag-and-drop (Task 8.1)
    onDragStart?: (infoHash: string) => void;
    onDragEnd?: () => void;
    isDragging?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const DownloadItem = React.memo(function DownloadItem({
    item,
    queueSize,
    onPause,
    onResume,
    onRemove,
    onMoveUp,
    onMoveDown,
    onDragStart,
    onDragEnd,
    isDragging,
    selected = false,
    onSelectionToggle,
    selectionDisabled = false,
}: DownloadItemProps): React.JSX.Element {
    const intl = useIntl();
    const progressPercent = Math.round(item.progress * 100);
    const isCompleted = item.status === 'completed';
    const isPaused = item.status === 'paused';
    const isWaiting = item.status === 'queued' || item.status === 'resolving-metadata';
    const isQueued = item.status === 'queued';
    const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);
    const [filesDialogOpen, setFilesDialogOpen] = useState(false);

    // ── Estado de operação em andamento (desabilita botões durante IPC) ──────
    const [isBusy, setIsBusy] = useState(false);

    // Resetar busy quando o status muda (o main process confirmou a operação).
    // O setState condicional aqui é intencional: só dispara quando o status realmente muda,
    // evitando loops infinitos. A regra é suprimida pois este é um padrão válido de
    // sincronização de estado derivado.
    const prevStatusRef = useRef(item.status);
    useEffect(() => {
        if (prevStatusRef.current !== item.status) {
            prevStatusRef.current = item.status;
            setIsBusy(false);
        }
    }, [item.status]);

    // ── Ref para rastrear mudança de posição na fila (aria-live) ─────────────
    const prevQueuePositionRef = useRef<number | undefined>(item.queuePosition);
    const [positionAnnouncement, setPositionAnnouncement] = useState<string>('');

    // Um único painel reúne arquivos, trackers e dados do torrent.
    const [detailsExpanded, setDetailsExpanded] = useState(false);
    const [detailsTab, setDetailsTab] = useState('general');
    const expanded = detailsExpanded && detailsTab === 'files';

    const [files, setFiles] = useState<TorrentFileInfo[]>([]);
    const [filesLoading, setFilesLoading] = useState(false);
    const [filesError, setFilesError] = useState<string | null>(null);
    const [selectionLoading, setSelectionLoading] = useState(false);
    const [selectionError, setSelectionError] = useState<string | null>(null);

    // ── Action error state (Task 5.3) ────────────────────────────────────────
    const [actionError, setActionError] = useState<string | null>(null);

    // ── Context menu state (Task 5.4) ────────────────────────────────────────
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    // Can expand when torrent is not in resolving-metadata state
    const canExpand = item.status !== 'resolving-metadata' && item.status !== 'queued';

    // ── Anunciar mudança de posição na fila via aria-live (Task 6.4) ─────────
    useEffect(() => {
        if (
            item.queuePosition !== undefined &&
            prevQueuePositionRef.current !== undefined &&
            item.queuePosition !== prevQueuePositionRef.current
        ) {
            setPositionAnnouncement(
                intl.formatMessage(
                    { id: 'downloads.queue.positionAnnounce' },
                    { name: item.name, position: item.queuePosition },
                ),
            );
        }
        prevQueuePositionRef.current = item.queuePosition;
    }, [item.queuePosition, item.name, intl]);

    // ── Fetch files when expanded (Task 6.2) ─────────────────────────────────
    // Busca inicial ao expandir. O setState no início do effect é intencional:
    // precisamos sinalizar loading antes do fetch assíncrono.
    useEffect(() => {
        if (!expanded) return;

        let cancelled = false;

        const fetchFiles = async (): Promise<void> => {
            try {
                const response = await window.meshy.getFiles(item.infoHash);
                if (cancelled) return;
                if (response.success) {
                    setFiles(response.data);
                    setFilesError(null);
                } else {
                    setFilesError(resolveErrorMessage(intl, response.error));
                }
            } catch (err: unknown) {
                if (cancelled) return;
                setFilesError(
                    err instanceof Error
                        ? err.message
                        : intl.formatMessage({ id: 'downloads.filesError' }),
                );
            } finally {
                if (!cancelled) {
                    setFilesLoading(false);
                }
            }
        };

        setFilesLoading(true);
        setFilesError(null);
        fetchFiles();

        return () => {
            cancelled = true;
        };
    }, [expanded, item.infoHash, intl]);

    // ── Atualizar progresso dos arquivos periodicamente enquanto baixando ─────
    const isActive = item.status === 'downloading' || item.status === 'resolving-metadata';

    const cardClassName = `${styles.card}${item.status === 'downloading' ? ` ${styles.cardActive}` : ''}${isDragging ? ` ${styles.isDragging}` : ''}`;

    useEffect(() => {
        if (!expanded || !isActive || files.length === 0) return;

        let cancelled = false;

        const interval = setInterval(() => {
            window.meshy
                .getFiles(item.infoHash)
                .then((response) => {
                    if (cancelled) return;
                    if (response.success) {
                        setFiles(response.data);
                    }
                })
                .catch(() => {
                    // Silenciar erros de polling — não sobrescrever o estado
                });
        }, 1500);

        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [expanded, isActive, item.infoHash, files.length]);

    // ── Handle selection change (Task 6.3) ───────────────────────────────────
    const handleSelectionChange = useCallback(
        (selectedIndices: number[]) => {
            setSelectionLoading(true);
            setSelectionError(null);

            window.meshy
                .setFileSelection(item.infoHash, selectedIndices)
                .then((response) => {
                    setSelectionLoading(false);
                    if (response.success) {
                        setFiles(response.data);
                    } else {
                        setSelectionError(resolveErrorMessage(intl, response.error));
                    }
                })
                .catch((err: unknown) => {
                    setSelectionLoading(false);
                    setSelectionError(
                        err instanceof Error
                            ? err.message
                            : intl.formatMessage({ id: 'downloads.speedLimits.error' }),
                    );
                });
        },
        [item.infoHash, intl],
    );

    const openDetailsTab = useCallback((tab: string) => {
        setDetailsTab(tab);
        setDetailsExpanded(true);
    }, []);

    const handleToggleDetails = useCallback(() => {
        setDetailsExpanded((previous) => !previous);
        setDetailsTab('general');
    }, []);

    // ── Auto-dismiss action error after 5 seconds (Task 5.3) ────────────────
    useEffect(() => {
        if (!actionError) return;

        const timer = setTimeout(() => {
            setActionError(null);
        }, 5000);

        return () => {
            clearTimeout(timer);
        };
    }, [actionError]);

    // ── Open folder handler (Task 5.1 + 5.3) ────────────────────────────────
    const handleOpenFolder = useCallback(async () => {
        setActionError(null);
        const response = await window.meshy.openFolder(item.infoHash);
        if (response.success === false) {
            setActionError(resolveErrorMessage(intl, response.error));
        }
    }, [item.infoHash, intl]);

    // ── Open file handler (Task 5.2 + 5.3) ──────────────────────────────────
    const handleOpenFile = useCallback(async () => {
        setActionError(null);
        const response = await window.meshy.openFile(item.infoHash);
        if (response.success === false) {
            setActionError(resolveErrorMessage(intl, response.error));
        }
    }, [item.infoHash, intl]);

    const handleRemove = useCallback(
        async (deleteFiles: boolean): Promise<void> => {
            setIsConfirmDialogOpen(false);
            setActionError(null);
            try {
                const response = await onRemove(item.infoHash, deleteFiles);
                if (!response.success) {
                    setActionError(resolveErrorMessage(intl, response.error));
                }
            } catch {
                setActionError(intl.formatMessage({ id: 'error.operation.failed' }));
            }
        },
        [intl, item.infoHash, onRemove],
    );

    // ── Context menu handler (Task 5.4) ─────────────────────────────────────
    const handleContextMenu = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
        },
        [setContextMenu],
    );

    // ── Close context menu on outside click (Task 5.4) ───────────────────────
    useEffect(() => {
        if (!contextMenu) return;

        const handleClick = (): void => {
            setContextMenu(null);
        };

        document.addEventListener('click', handleClick);

        return () => {
            document.removeEventListener('click', handleClick);
        };
    }, [contextMenu]);

    // ── File count display (Task 6.4) ────────────────────────────────────────
    const hasFileCount =
        item.selectedFileCount !== undefined &&
        item.totalFileCount !== undefined &&
        item.totalFileCount > 0;

    // ── Handlers de drag-and-drop (Task 8.1) ───────────────────────────────
    const handleDragStart = useCallback(
        (e: React.DragEvent) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.infoHash);
            onDragStart?.(item.infoHash);
        },
        [item.infoHash, onDragStart],
    );

    const handleDragEnd = useCallback(() => {
        onDragEnd?.();
    }, [onDragEnd]);

    return (
        <div
            className={cardClassName}
            role="listitem"
            inert={selectionDisabled}
            onContextMenu={handleContextMenu}
            draggable={item.status === 'queued'}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
        >
            {/* Name and status */}
            <div className={styles.header}>
                {onSelectionToggle && (
                    <input
                        type="checkbox"
                        checked={selected}
                        disabled={selectionDisabled || !!item.fileOperation}
                        onChange={() => onSelectionToggle(item.infoHash)}
                        aria-label={intl.formatMessage(
                            { id: 'batch.selectTorrent' },
                            { name: item.name },
                        )}
                    />
                )}
                <span className={styles.name} title={item.name}>
                    {displayName(item.name)}
                </span>
                <div className={styles.headerRight}>
                    {hasFileCount && (
                        <span className={styles.fileCount}>
                            {intl.formatMessage(
                                { id: 'downloads.fileCount' },
                                { selected: item.selectedFileCount, total: item.totalFileCount },
                            )}
                        </span>
                    )}
                    {/* Badge de posição na fila (Task 6.2) */}
                    {isQueued && item.queuePosition !== undefined && (
                        <span className={styles.queueBadge}>
                            {intl.formatMessage(
                                { id: 'downloads.queue.positionBadge' },
                                { position: item.queuePosition },
                            )}
                        </span>
                    )}
                    <span className={styles.status}>
                        {intl.formatMessage({ id: STATUS_LABEL_KEYS[item.status] ?? item.status })}
                    </span>
                </div>
            </div>

            {/* Progress bar */}
            <ProgressBar
                value={progressPercent}
                max={100}
                label={intl.formatMessage(
                    { id: 'downloads.progress.label' },
                    { name: item.name, percent: progressPercent },
                )}
                variant={progressVariant(item.status)}
            />

            {/* Details */}
            <div className={styles.details}>
                <span>
                    {formatBytes(item.downloadedSize)} / {formatBytes(item.totalSize)} (
                    {progressPercent}%)
                </span>
                {!isCompleted && !isPaused && !isWaiting && (
                    <SpeedDisplay speedBytesPerSec={item.downloadSpeed} icon={<VscArrowDown />} />
                )}
                {!isCompleted && !isPaused && !isWaiting && (
                    <SpeedDisplay speedBytesPerSec={item.uploadSpeed} icon={<VscArrowUp />} />
                )}
                {!isCompleted && !isPaused && !isWaiting && (
                    <span>
                        {intl.formatMessage(
                            { id: 'downloads.seedersAndPeers' },
                            { seeders: item.numSeeders, peers: item.numPeers },
                        )}
                    </span>
                )}
                {isCompleted ? (
                    <span>
                        {intl.formatMessage(
                            { id: 'downloads.timeElapsed' },
                            {
                                time:
                                    formatTimeParts(item.elapsedMs ?? 0) ??
                                    intl.formatMessage({ id: 'downloads.timeElapsed.none' }),
                            },
                        )}
                    </span>
                ) : isPaused || isWaiting ? null : (
                    <span>
                        {intl.formatMessage(
                            { id: 'downloads.timeRemaining' },
                            {
                                time:
                                    formatTimeParts(item.timeRemaining) ??
                                    intl.formatMessage({
                                        id: 'downloads.timeRemaining.calculating',
                                    }),
                            },
                        )}
                    </span>
                )}
            </div>

            {/* Actions */}
            {item.diagnostic && (
                <aside className={styles.diagnostic}>
                    <p>
                        {intl.formatMessage(
                            {
                                id: `diagnostic.${item.diagnostic.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`,
                            },
                            { position: item.queuePosition ?? '?' },
                        )}
                    </p>
                    {item.diagnostic === 'folder-unavailable' && (
                        <button className="btn" onClick={() => setFilesDialogOpen(true)}>
                            {intl.formatMessage({ id: 'diagnostic.locate' })}
                        </button>
                    )}
                    {['no-peers', 'trackers-error'].includes(item.diagnostic) && canExpand && (
                        <button className="btn" onClick={() => openDetailsTab('trackers')}>
                            {intl.formatMessage({ id: 'diagnostic.trackers' })}
                        </button>
                    )}
                    {item.diagnostic === 'no-selection' && (
                        <button
                            className="btn"
                            onClick={() => {
                                openDetailsTab('files');
                            }}
                        >
                            {intl.formatMessage({ id: 'diagnostic.selectFiles' })}
                        </button>
                    )}
                    {item.diagnostic === 'stalled' && (
                        <button className="btn" onClick={() => openDetailsTab('general')}>
                            {intl.formatMessage({ id: 'diagnostic.details' })}
                        </button>
                    )}
                </aside>
            )}
            <div className={styles.actions}>
                {/* Botões de reordenação na fila (Task 6.3) */}
                {isQueued && (
                    <button
                        className={`btn ${item.queuePosition === 1 ? styles.queueButtonDisabled : ''}`}
                        onClick={() => onMoveUp(item.infoHash)}
                        aria-label={intl.formatMessage(
                            { id: 'downloads.queue.moveUpAriaLabel' },
                            { name: item.name },
                        )}
                        aria-disabled={item.queuePosition === 1 ? 'true' : undefined}
                        disabled={item.queuePosition === 1}
                    >
                        <VscArrowUp /> {intl.formatMessage({ id: 'downloads.queue.moveUp' })}
                    </button>
                )}
                {isQueued && (
                    <button
                        className={`btn ${item.queuePosition === queueSize ? styles.queueButtonDisabled : ''}`}
                        onClick={() => onMoveDown(item.infoHash)}
                        aria-label={intl.formatMessage(
                            { id: 'downloads.queue.moveDownAriaLabel' },
                            { name: item.name },
                        )}
                        aria-disabled={item.queuePosition === queueSize ? 'true' : undefined}
                        disabled={item.queuePosition === queueSize}
                    >
                        <VscArrowDown /> {intl.formatMessage({ id: 'downloads.queue.moveDown' })}
                    </button>
                )}
                {/* Botão de expansão do painel de detalhes (Task 15.1) */}
                <button
                    className="btn"
                    onClick={handleToggleDetails}
                    aria-label={
                        detailsExpanded
                            ? intl.formatMessage({
                                id: 'downloads.actions.collapseDetailsAriaLabel',
                            })
                            : intl.formatMessage({
                                id: 'downloads.actions.expandDetailsAriaLabel',
                            })
                    }
                    aria-expanded={detailsExpanded}
                    disabled={!isExpandable(item.status)}
                >
                    <VscInfo /> {intl.formatMessage({ id: 'downloads.actions.expandDetails' })}
                </button>
                {isCompleted && (
                    <button
                        className="btn"
                        onClick={handleOpenFolder}
                        aria-label={intl.formatMessage(
                            { id: 'downloads.actions.openFolderAriaLabel' },
                            { name: item.name },
                        )}
                    >
                        <VscFolderOpened />{' '}
                        {intl.formatMessage({ id: 'downloads.actions.openFolder' })}
                    </button>
                )}
                {isCompleted && item.selectedFileCount === 1 && (
                    <button
                        className="btn"
                        onClick={handleOpenFile}
                        aria-label={intl.formatMessage(
                            { id: 'downloads.actions.openFileAriaLabel' },
                            { name: item.name },
                        )}
                    >
                        <VscGoToFile /> {intl.formatMessage({ id: 'downloads.actions.openFile' })}
                    </button>
                )}
                {item.status === 'downloading' && (
                    <button
                        className="btn"
                        onClick={() => {
                            if (isBusy || item.fileOperation) return;
                            setIsBusy(true);
                            onPause(item.infoHash).finally(() => setIsBusy(false));
                        }}
                        disabled={isBusy || !!item.fileOperation}
                        aria-label={intl.formatMessage(
                            { id: 'downloads.actions.pauseAriaLabel' },
                            { name: item.name },
                        )}
                    >
                        <VscDebugPause /> {intl.formatMessage({ id: 'downloads.actions.pause' })}
                    </button>
                )}
                {item.status === 'paused' && (
                    <button
                        className="btn"
                        onClick={() => {
                            if (isBusy || item.fileOperation) return;
                            setIsBusy(true);
                            onResume(item.infoHash).finally(() => setIsBusy(false));
                        }}
                        disabled={isBusy || !!item.fileOperation}
                        aria-label={intl.formatMessage(
                            { id: 'downloads.actions.resumeAriaLabel' },
                            { name: item.name },
                        )}
                    >
                        <VscPlay /> {intl.formatMessage({ id: 'downloads.actions.resume' })}
                    </button>
                )}
                <ActionMenu
                    label={intl.formatMessage(
                        { id: 'downloads.actions.more' },
                        { name: item.name },
                    )}
                    disabled={!!item.fileOperation}
                >
                    <button
                        type="button"
                        className="btn"
                        disabled={item.status === 'resolving-metadata'}
                        onClick={() => setFilesDialogOpen(true)}
                    >
                        {intl.formatMessage({ id: 'downloads.actions.manageFiles' })}
                    </button>
                    <button
                        type="button"
                        className="btn btn--danger"
                        onClick={() => setIsConfirmDialogOpen(true)}
                        aria-label={intl.formatMessage(
                            { id: 'downloads.actions.removeAriaLabel' },
                            { name: item.name },
                        )}
                    >
                        <VscTrash /> {intl.formatMessage({ id: 'common.remove' })}
                    </button>
                </ActionMenu>
            </div>

            {item.fileOperation && (
                <p role="status">{intl.formatMessage({ id: 'files.working' })}</p>
            )}
            {filesDialogOpen && (
                <ManageFilesDialog item={item} onClose={() => setFilesDialogOpen(false)} />
            )}

            {/* Action error display (Task 5.3) */}
            {actionError && (
                <div className={styles.actionError} role="alert">
                    {actionError}
                </div>
            )}

            {/* Expanded file selector section (Task 6.2) */}
            {item.pauseReason === 'disk-space' && (
                <div className={styles.actionError} role="alert">
                    {resolveErrorMessage(
                        intl,
                        item.errorMessage ?? 'error.destination.diskSpaceLow',
                    )}
                </div>
            )}
            {/* Details panel section (Task 15.1) */}
            <div className={detailsExpanded ? styles.detailsPanelSection : undefined}>
                <DetailsPanel
                    infoHash={item.infoHash}
                    status={item.status}
                    isExpanded={detailsExpanded}
                    onToggle={handleToggleDetails}
                    selectedTab={detailsTab}
                    onTabChange={setDetailsTab}
                    tabLabels={{
                        general: intl.formatMessage({ id: 'downloads.tabs.general' }),
                        peers: intl.formatMessage({ id: 'downloads.tabs.peers' }),
                        pieces: intl.formatMessage({ id: 'downloads.tabs.pieces' }),
                        speed: intl.formatMessage({ id: 'downloads.tabs.speed' }),
                    }}
                    additionalTabs={[
                        {
                            id: 'files',
                            label: intl.formatMessage({ id: 'downloads.tabs.files' }),
                            content: (
                                <div>
                                    {filesLoading && !files.length && (
                                        <p role="status" className={styles.fileSelectorLoading}>
                                            {intl.formatMessage({ id: 'downloads.filesLoading' })}
                                        </p>
                                    )}
                                    {filesError && (
                                        <p role="alert" className={styles.fileSelectorError}>
                                            {filesError}
                                        </p>
                                    )}
                                    {!filesLoading && !filesError && files.length === 0 && (
                                        <p>{intl.formatMessage({ id: 'downloads.filesEmpty' })}</p>
                                    )}
                                    {files.length > 0 && (
                                        <FileSelector
                                            files={files}
                                            onSelectionChange={handleSelectionChange}
                                            disabled={!!item.fileOperation}
                                            loading={selectionLoading}
                                            error={selectionError}
                                        />
                                    )}
                                </div>
                            ),
                        },
                        {
                            id: 'trackers',
                            label: intl.formatMessage({ id: 'downloads.tabs.trackers' }),
                            content: <TrackerPanel infoHash={item.infoHash} />,
                        },
                    ]}
                />
            </div>

            {createPortal(
                <ConfirmDialog
                    isOpen={isConfirmDialogOpen}
                    title={intl.formatMessage({ id: 'downloads.confirmRemove.title' })}
                    message={intl.formatMessage(
                        { id: 'downloads.confirmRemove.message' },
                        { name: item.name },
                    )}
                    onConfirmKeepFiles={() => void handleRemove(false)}
                    onConfirmDeleteFiles={() => void handleRemove(true)}
                    onCancel={() => setIsConfirmDialogOpen(false)}
                />,
                document.body,
            )}

            {/* Context menu (Task 5.4) */}
            {contextMenu && (
                <ul
                    role="menu"
                    className={styles.contextMenu}
                    style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
                >
                    <li
                        role="menuitem"
                        className={`${styles.contextMenuItem}${!isCompleted ? ` ${styles.contextMenuItemDisabled}` : ''}`}
                        aria-disabled={!isCompleted}
                        onClick={() => {
                            if (isCompleted) {
                                handleOpenFolder();
                                setContextMenu(null);
                            }
                        }}
                    >
                        {intl.formatMessage({ id: 'downloads.contextMenu.openFolder' })}
                    </li>
                    {item.selectedFileCount === 1 && (
                        <li
                            role="menuitem"
                            className={`${styles.contextMenuItem}${!isCompleted ? ` ${styles.contextMenuItemDisabled}` : ''}`}
                            aria-disabled={!isCompleted}
                            onClick={() => {
                                if (isCompleted) {
                                    handleOpenFile();
                                    setContextMenu(null);
                                }
                            }}
                        >
                            {intl.formatMessage({ id: 'downloads.contextMenu.openFile' })}
                        </li>
                    )}
                </ul>
            )}

            {/* Região aria-live para anúncio de mudança de posição (Task 6.4) */}
            <div aria-live="polite" className={styles.srOnly}>
                {positionAnnouncement}
            </div>
        </div>
    );
});

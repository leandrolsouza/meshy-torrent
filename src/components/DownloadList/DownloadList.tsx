import React, { useMemo, useCallback, useState, useRef } from 'react';
import { useIntl } from 'react-intl';
import { VscChevronDown, VscChevronRight } from 'react-icons/vsc';
import { useDownloads } from '../../hooks/useDownloads';
import { useFilterStore } from '../../store/filterStore';
import { applyFilters, groupByStatus } from '../../utils/downloadFilters';
import type { StatusGroup } from '../../utils/downloadFilters';
import { DownloadItem } from './DownloadItem';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { MeshyIcon } from '../common/MeshyIcon';
import { SearchBar } from './SearchBar';
import { ActionMenu } from '../common/ActionMenu';
import { BatchActions } from './BatchActions';
import styles from './DownloadList.module.css';

// ── Tempo mínimo que o overlay fica visível (ms) ─────────────────────────────
// Evita flash rápido demais que confunde o usuário.
const MIN_OVERLAY_MS = 400;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renderiza a lista completa de downloads ativos do store.
 *
 * Aplica o pipeline de filtragem (busca por nome, filtro por status e ordenação)
 * usando o estado do filterStore. O cabeçalho reúne busca, seleção e adição;
 * filtros de status e ordenação ficam no painel lateral. As ações secundárias
 * da lista continuam disponíveis em um popover.
 */
export const DownloadList = React.memo(function DownloadList({
    onAddTorrent,
    children,
}: {
    onAddTorrent?: () => void;
    children?: React.ReactNode;
}): React.JSX.Element {
    const intl = useIntl();
    const { items, pause, resume, remove, reorderQueue } = useDownloads();
    const searchTerm = useFilterStore((s) => s.searchTerm);
    const selectedStatuses = useFilterStore((s) => s.selectedStatuses);
    const sortField = useFilterStore((s) => s.sortField);
    const sortDirection = useFilterStore((s) => s.sortDirection);
    const resetFilters = useFilterStore((s) => s.resetFilters);

    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set());
    const [batchBusy, setBatchBusy] = useState(false);
    const selectHashes = useCallback((hashes: string[]) => setSelectedHashes(new Set(hashes)), []);
    const toggleSelection = useCallback(
        (hash: string) =>
            setSelectedHashes((previous) => {
                const next = new Set(previous);
                if (next.has(hash)) next.delete(hash);
                else next.add(hash);
                return next;
            }),
        [],
    );
    const [collapsedGroups, setCollapsedGroups] = useState<Set<StatusGroup>>(new Set());

    // ── Overlay de loading durante operações ─────────────────────────────────
    // Bloqueia interações enquanto pause/resume/remove estão em andamento.
    const [isBusy, setIsBusy] = useState(false);
    const opsInFlight = useRef(0);
    const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /**
     * Envolve uma operação async (pause/resume/remove) com o overlay de loading.
     * Mostra o overlay imediatamente e garante que ele fique visível por pelo
     * menos MIN_OVERLAY_MS para evitar flash.
     */
    const withBusy = useCallback(<T,>(op: Promise<T>): Promise<T> => {
        opsInFlight.current++;
        setIsBusy(true);
        if (overlayTimer.current) {
            clearTimeout(overlayTimer.current);
            overlayTimer.current = null;
        }
        const start = Date.now();
        return op.finally(() => {
            opsInFlight.current--;
            if (opsInFlight.current <= 0) {
                opsInFlight.current = 0;
                const elapsed = Date.now() - start;
                const remaining = Math.max(0, MIN_OVERLAY_MS - elapsed);
                overlayTimer.current = setTimeout(() => {
                    setIsBusy(false);
                    overlayTimer.current = null;
                }, remaining);
            }
        });
    }, []);

    // Wrappers que ativam o overlay
    const handlePause = useCallback(
        (infoHash: string) => withBusy(pause(infoHash)),
        [pause, withBusy],
    );
    const handleResume = useCallback(
        (infoHash: string) => withBusy(resume(infoHash)),
        [resume, withBusy],
    );
    const handleRemove = useCallback(
        (infoHash: string, deleteFiles: boolean) => withBusy(remove(infoHash, deleteFiles)),
        [remove, withBusy],
    );

    // ── Estado de drag-and-drop (Task 8.2) ───────────────────────────────────
    const [draggedInfoHash, setDraggedInfoHash] = useState<string | null>(null);
    const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

    // Pipeline de filtragem e ordenação aplicado sobre os itens do store
    const filteredItems = useMemo(
        () => applyFilters(items, searchTerm, selectedStatuses, sortField, sortDirection),
        [items, searchTerm, selectedStatuses, sortField, sortDirection],
    );

    // Agrupamento por status sobre os itens filtrados
    const groups = useMemo(() => groupByStatus(filteredItems), [filteredItems]);

    // Contagem de downloads concluídos (para o botão "Limpar concluídos")
    const completedCount = useMemo(
        () => items.filter((i) => i.status === 'completed' || i.status === 'seeding').length,
        [items],
    );

    // Contagem de itens enfileirados (para desabilitar botão "mover para baixo" no último)
    const queueSize = useMemo(() => items.filter((i) => i.status === 'queued').length, [items]);

    // Callback para mover item para cima na fila
    const handleMoveUp = useCallback(
        (infoHash: string) => {
            const item = items.find((i) => i.infoHash === infoHash);
            if (item?.queuePosition !== undefined && item.queuePosition > 1) {
                // queuePosition é 1-based; newIndex é 0-based, uma posição acima
                const newIndex = item.queuePosition - 2;
                reorderQueue(infoHash, newIndex);
            }
        },
        [items, reorderQueue],
    );

    // Callback para mover item para baixo na fila
    const handleMoveDown = useCallback(
        (infoHash: string) => {
            const item = items.find((i) => i.infoHash === infoHash);
            if (item?.queuePosition !== undefined && item.queuePosition < queueSize) {
                // queuePosition é 1-based; newIndex é 0-based, uma posição abaixo
                const newIndex = item.queuePosition;
                reorderQueue(infoHash, newIndex);
            }
        },
        [items, queueSize, reorderQueue],
    );

    // ── Callbacks de drag-and-drop (Task 8.2) ───────────────────────────────
    const handleDragStart = useCallback((infoHash: string) => {
        setDraggedInfoHash(infoHash);
    }, []);

    const handleDragEnd = useCallback(() => {
        setDraggedInfoHash(null);
        setDropTargetIndex(null);
    }, []);

    const handleDragOver = useCallback(
        (e: React.DragEvent<HTMLDivElement>, groupItems: { infoHash: string }[]) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';

            // Calcular posição de drop baseado na posição do mouse entre os itens
            const container = e.currentTarget;
            const children = Array.from(container.children) as HTMLElement[];
            let targetIndex = groupItems.length; // padrão: final da lista

            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (!child) continue;
                const rect = child.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    targetIndex = i;
                    break;
                }
            }

            setDropTargetIndex(targetIndex);
        },
        [],
    );

    const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        // Limpar apenas se saiu do container (não de um filho)
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDropTargetIndex(null);
        }
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            if (draggedInfoHash !== null && dropTargetIndex !== null) {
                reorderQueue(draggedInfoHash, dropTargetIndex);
            }
            setDraggedInfoHash(null);
            setDropTargetIndex(null);
        },
        [draggedInfoHash, dropTargetIndex, reorderQueue],
    );

    // Toggle de colapso de um grupo
    const toggleGroup = useCallback((groupId: StatusGroup) => {
        setCollapsedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) {
                next.delete(groupId);
            } else {
                next.add(groupId);
            }
            return next;
        });
    }, []);

    // Limpa todos os downloads concluídos da lista
    const handleClearCompleted = useCallback(
        (deleteFiles: boolean) => {
            const completedItems = items.filter(
                (i) => i.status === 'completed' || i.status === 'seeding',
            );
            const ops = completedItems.map((i) => remove(i.infoHash, deleteFiles));
            withBusy(Promise.all(ops));
        },
        [items, remove, withBusy],
    );

    // Mensagem para a região aria-live
    const ariaMessage =
        filteredItems.length === 0
            ? intl.formatMessage({ id: 'downloads.ariaLive.none' })
            : filteredItems.length === 1
              ? intl.formatMessage({ id: 'downloads.ariaLive.one' })
              : intl.formatMessage(
                    { id: 'downloads.ariaLive.many' },
                    { count: filteredItems.length },
                );

    // Verifica se algum filtro está ativo
    const hasActiveFilters = searchTerm.trim() !== '' || selectedStatuses.length > 0;

    return (
        <div className={styles.container}>
            <header className={styles.toolbar}>
                <div className={styles.heading}>
                    <h1>{intl.formatMessage({ id: 'app.nav.downloads' })}</h1>
                    <span>
                        {intl.formatMessage({ id: 'downloads.total' }, { count: items.length })}
                    </span>
                </div>
                <div className={styles.search}>
                    <SearchBar />
                </div>
                <div className={styles.toolbarActions}>
                    <button
                        className="btn"
                        type="button"
                        disabled={batchBusy || isBusy || items.length === 0}
                        aria-pressed={selectionMode}
                        onClick={() => {
                            setSelectionMode(!selectionMode);
                            setSelectedHashes(new Set());
                        }}
                    >
                        {intl.formatMessage({
                            id: selectionMode ? 'batch.finish' : 'batch.select',
                        })}
                    </button>

                    {completedCount > 0 && (
                        <ActionMenu
                            label={intl.formatMessage({ id: 'downloads.listActions' })}
                            disabled={batchBusy || isBusy}
                        >
                            <button
                                className="btn"
                                onClick={() => setIsConfirmOpen(true)}
                                aria-label={intl.formatMessage({
                                    id: 'downloads.clearCompletedAriaLabel',
                                })}
                            >
                                {intl.formatMessage(
                                    { id: 'downloads.clearCompleted' },
                                    { count: completedCount },
                                )}
                            </button>
                        </ActionMenu>
                    )}
                    {onAddTorrent && (
                        <button
                            type="button"
                            className="btn btn--primary"
                            onClick={onAddTorrent}
                            disabled={batchBusy || isBusy}
                        >
                            <MeshyIcon name="add-torrent" />{' '}
                            {intl.formatMessage({ id: 'app.nav.addTorrent' })}
                        </button>
                    )}
                </div>
            </header>
            {children}

            {/* Overlay de loading durante operações de pause/resume/remove */}
            {isBusy && (
                <div className={styles.busyOverlay} aria-live="assertive" role="status">
                    <div className={styles.busySpinner} />
                    <span className={styles.busyText}>
                        {intl.formatMessage({ id: 'downloads.processing' })}
                    </span>
                </div>
            )}
            {/* Ações em lote aparecem somente durante a seleção. */}
            {selectionMode && (
                <BatchActions
                    visibleItems={filteredItems}
                    selectedHashes={selectedHashes}
                    onSelect={selectHashes}
                    onClear={() => setSelectedHashes(new Set())}
                    onBusy={setBatchBusy}
                />
            )}
            {/* Região aria-live para anunciar contagem de resultados */}
            <div className={styles.ariaLive} aria-live="polite" role="status">
                {ariaMessage}
            </div>

            {/* Indicador de filtros ativos */}
            {hasActiveFilters && filteredItems.length > 0 && (
                <div className={styles.filterIndicator}>
                    <span>
                        {intl.formatMessage(
                            { id: 'downloads.filterIndicator' },
                            { filtered: filteredItems.length, total: items.length },
                        )}
                    </span>
                    <button
                        type="button"
                        className={styles.clearFiltersLink}
                        onClick={resetFilters}
                    >
                        {intl.formatMessage({ id: 'downloads.clearFilters' })}
                    </button>
                </div>
            )}

            {items.length === 0 ? (
                <div className={styles.empty}>
                    <MeshyIcon name="empty-downloads" size={96} className={styles.emptyIcon} />
                    <h2 className={styles.emptyTitle}>
                        {intl.formatMessage({ id: 'downloads.empty.title' })}
                    </h2>
                    <p className={styles.emptyHint}>
                        {intl.formatMessage({ id: 'downloads.empty.hint' })}
                    </p>
                    {onAddTorrent && (
                        <button type="button" className="btn btn--primary" onClick={onAddTorrent}>
                            <MeshyIcon name="add-torrent" />{' '}
                            {intl.formatMessage({ id: 'app.nav.addTorrent' })}
                        </button>
                    )}
                </div>
            ) : filteredItems.length === 0 ? (
                // Estado vazio filtrado: filtros excluem todos os itens
                <div className={styles.filteredEmpty}>
                    <p className={styles.emptyTitle}>
                        {intl.formatMessage({ id: 'downloads.filteredEmpty.title' })}
                    </p>
                    <button
                        type="button"
                        className={styles.clearFiltersButton}
                        onClick={resetFilters}
                    >
                        {intl.formatMessage({ id: 'downloads.clearFilters' })}
                    </button>
                </div>
            ) : (
                // Lista agrupada por status
                <div className={styles.list}>
                    {groups.map((group) => {
                        const isCollapsed = collapsedGroups.has(group.id);
                        const groupLabel = intl.formatMessage({ id: group.labelKey });
                        return (
                            <div key={group.id} className={styles.group}>
                                <button
                                    type="button"
                                    className={styles.groupHeader}
                                    onClick={() => toggleGroup(group.id)}
                                    aria-expanded={!isCollapsed}
                                    aria-label={intl.formatMessage(
                                        { id: 'downloads.group.toggleAriaLabel' },
                                        { group: groupLabel, count: group.items.length },
                                    )}
                                >
                                    <span className={styles.groupChevron}>
                                        {isCollapsed ? <VscChevronRight /> : <VscChevronDown />}
                                    </span>
                                    <span className={styles.groupLabel}>{groupLabel}</span>
                                    <span className={styles.groupCount}>
                                        {intl.formatMessage(
                                            { id: 'downloads.group.count' },
                                            { count: group.items.length },
                                        )}
                                    </span>
                                </button>
                                {!isCollapsed && (
                                    <div
                                        className={styles.groupItems}
                                        role="list"
                                        {...(group.id === 'waiting'
                                            ? {
                                                  onDragOver: (
                                                      e: React.DragEvent<HTMLDivElement>,
                                                  ) => handleDragOver(e, group.items),
                                                  onDrop: handleDrop,
                                                  onDragLeave: handleDragLeave,
                                              }
                                            : {})}
                                    >
                                        {group.items.map((item, index) => (
                                            <React.Fragment key={item.infoHash}>
                                                {/* Indicador de drop antes do item (Task 8.2) */}
                                                {group.id === 'waiting' &&
                                                    draggedInfoHash !== null &&
                                                    dropTargetIndex === index && (
                                                        <div className={styles.dropIndicator} />
                                                    )}
                                                <DownloadItem
                                                    item={item}
                                                    selected={selectedHashes.has(item.infoHash)}
                                                    onSelectionToggle={
                                                        selectionMode ? toggleSelection : undefined
                                                    }
                                                    selectionDisabled={batchBusy || isBusy}
                                                    queueSize={queueSize}
                                                    onPause={handlePause}
                                                    onResume={handleResume}
                                                    onRemove={handleRemove}
                                                    onMoveUp={handleMoveUp}
                                                    onMoveDown={handleMoveDown}
                                                    onDragStart={handleDragStart}
                                                    onDragEnd={handleDragEnd}
                                                    isDragging={draggedInfoHash === item.infoHash}
                                                />
                                            </React.Fragment>
                                        ))}
                                        {/* Indicador de drop após o último item (Task 8.2) */}
                                        {group.id === 'waiting' &&
                                            draggedInfoHash !== null &&
                                            dropTargetIndex === group.items.length && (
                                                <div className={styles.dropIndicator} />
                                            )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <ConfirmDialog
                isOpen={isConfirmOpen}
                title={intl.formatMessage({ id: 'downloads.confirmClearCompleted.title' })}
                message={intl.formatMessage(
                    { id: 'downloads.confirmClearCompleted.message' },
                    { count: completedCount },
                )}
                onConfirmKeepFiles={() => {
                    setIsConfirmOpen(false);
                    handleClearCompleted(false);
                }}
                onConfirmDeleteFiles={() => {
                    setIsConfirmOpen(false);
                    handleClearCompleted(true);
                }}
                onCancel={() => setIsConfirmOpen(false)}
            />
        </div>
    );
});

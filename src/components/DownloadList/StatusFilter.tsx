import React, { useCallback } from 'react';
import { useIntl } from 'react-intl';
import type { TorrentStatus } from '../../../shared/types';
import { useFilterStore } from '../../store/filterStore';
import styles from './StatusFilter.module.css';

// ─── Mapeamento de status para chaves de tradução ─────────────────────────────

const STATUS_LABEL_KEYS: Record<TorrentStatus, string> = {
    queued: 'downloads.statusLabel.queued',
    'resolving-metadata': 'downloads.statusLabel.resolvingMetadata',
    downloading: 'downloads.statusLabel.downloading',
    paused: 'downloads.statusLabel.paused',
    completed: 'downloads.statusLabel.completed',
    seeding: 'status.seeding',
    error: 'downloads.statusLabel.error',
    'metadata-failed': 'downloads.statusLabel.metadataFailed',
    'files-not-found': 'downloads.statusLabel.filesNotFound',
};

/** Ordem de exibição dos status no filtro. */
const ALL_STATUSES: TorrentStatus[] = [
    'queued',
    'resolving-metadata',
    'downloading',
    'paused',
    'completed',
    'seeding',
    'error',
    'metadata-failed',
    'files-not-found',
];

// ─── Componente StatusFilter ──────────────────────────────────────────────────

/**
 * Grupo de botões toggle para filtrar downloads por status.
 *
 * O botão "Todos" limpa a seleção (equivale a nenhum filtro de status).
 * Cada botão de status individual ativa/desativa aquele status na seleção.
 * Seleção múltipla é suportada.
 */
export function StatusFilter(): React.JSX.Element {
    const intl = useIntl();
    const selectedStatuses = useFilterStore((state) => state.selectedStatuses);
    const setSelectedStatuses = useFilterStore((state) => state.setSelectedStatuses);

    // "Todos" está ativo quando nenhum status individual está selecionado
    const isAllActive = selectedStatuses.length === 0;

    // Clicar em "Todos" limpa a seleção
    const handleAllClick = useCallback(() => {
        setSelectedStatuses([]);
    }, [setSelectedStatuses]);

    // Clicar em um status individual ativa/desativa na seleção
    const handleStatusClick = useCallback(
        (status: TorrentStatus) => {
            const isSelected = selectedStatuses.includes(status);
            if (isSelected) {
                const next = selectedStatuses.filter((s) => s !== status);
                setSelectedStatuses(next);
            } else {
                setSelectedStatuses([...selectedStatuses, status]);
            }
        },
        [selectedStatuses, setSelectedStatuses],
    );

    return (
        <div
            role="group"
            aria-label={intl.formatMessage({ id: 'filter.status.ariaLabel' })}
            className={styles.container}
        >
            <button
                type="button"
                className={`${styles.button} ${isAllActive ? styles.buttonActive : ''}`}
                aria-pressed={isAllActive}
                onClick={handleAllClick}
            >
                {intl.formatMessage({ id: 'filter.status.all' })}
            </button>
            {ALL_STATUSES.map((status) => {
                const isActive = selectedStatuses.includes(status);
                return (
                    <button
                        key={status}
                        type="button"
                        className={`${styles.button} ${isActive ? styles.buttonActive : ''}`}
                        aria-pressed={isActive}
                        onClick={() => handleStatusClick(status)}
                    >
                        {intl.formatMessage({ id: STATUS_LABEL_KEYS[status] })}
                    </button>
                );
            })}
        </div>
    );
}

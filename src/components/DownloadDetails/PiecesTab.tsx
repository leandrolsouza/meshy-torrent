import React, { useCallback, useMemo, useState } from 'react';
import { TorrentStatus } from '../../../shared/types';
import { usePolling } from '../../hooks/usePolling';
import { computePieceSummary } from '../../utils/detailsFormatters';
import { PieceGrid } from './PieceGrid';
import styles from './PiecesTab.module.css';

export interface PiecesTabProps {
    infoHash: string;
    status: TorrentStatus;
    isActive?: boolean;
}

/**
 * Aba de Peças — exibe grade visual de progresso por peça do torrent.
 *
 * - Polling de 2s habilitado apenas quando status é "downloading".
 * - Exibe último estado sem polling quando status é "paused" ou "completed".
 * - Mensagem de erro com botão "Tentar novamente" se IPC falha.
 */
export const PiecesTab = React.memo(function PiecesTab({
    infoHash,
    status,
    isActive = true,
}: PiecesTabProps): React.JSX.Element {
    const [pieces, setPieces] = useState<boolean[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [hasLoaded, setHasLoaded] = useState(false);

    const fetchPieces = useCallback(async () => {
        try {
            const response = await window.meshy.getPieces(infoHash);
            if (response.success) {
                setPieces(response.data);
                setError(null);
                setHasLoaded(true);
            } else {
                setError(response.error);
            }
        } catch {
            setError('Falha ao obter dados de peças');
        }
    }, [infoHash]);

    // Polling habilitado apenas quando downloading
    const pollingEnabled = isActive && status === 'downloading';
    usePolling(fetchPieces, 2000, pollingEnabled);

    // Memoiza o resumo textual que internamente faz filter sobre o array de peças
    const pieceSummary = useMemo(() => computePieceSummary(pieces), [pieces]);

    if (error) {
        return (
            <div className={styles.container}>
                <div className={styles.errorContainer} data-testid="pieces-error">
                    <p className={styles.errorMessage}>{error}</p>
                    <button
                        className={styles.retryButton}
                        onClick={fetchPieces}
                        data-testid="pieces-retry-button"
                    >
                        Tentar novamente
                    </button>
                </div>
            </div>
        );
    }

    if (!hasLoaded) {
        return (
            <div className={styles.container}>
                <p className={styles.emptyState} data-testid="pieces-loading">
                    Carregando...
                </p>
            </div>
        );
    }

    return (
        <div className={styles.container} data-testid="pieces-container">
            <p className={styles.summary} data-testid="pieces-summary">
                {pieceSummary}
            </p>
            <PieceGrid pieces={pieces} />
        </div>
    );
});

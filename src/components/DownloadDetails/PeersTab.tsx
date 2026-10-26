import React, { useCallback, useMemo, useState } from 'react';
import { PeerInfo, TorrentStatus } from '../../../shared/types';
import { usePolling } from '../../hooks/usePolling';
import { formatPeerProgress, formatPeerSpeed } from '../../utils/detailsFormatters';
import styles from './PeersTab.module.css';

export interface PeersTabProps {
    infoHash: string;
    status: TorrentStatus;
    isActive?: boolean;
}

/**
 * Aba de Peers — exibe tabela de pares conectados ao torrent.
 *
 * - Polling de 2s habilitado durante download e seeding.
 * - Exibe última lista sem polling quando status não é "downloading".
 * - Interrompe polling em caso de erro IPC até próxima ativação.
 */
export const PeersTab = React.memo(function PeersTab({
    infoHash,
    status,
    isActive = true,
}: PeersTabProps): React.JSX.Element {
    const [peers, setPeers] = useState<PeerInfo[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [hasError, setHasError] = useState(false);

    const fetchPeers = useCallback(async () => {
        try {
            const response = await window.meshy.getPeers(infoHash);
            if (response.success) {
                setPeers(response.data);
                setError(null);
                setHasLoaded(true);
            } else {
                setError(response.error);
                setHasError(true);
            }
        } catch {
            setError('Falha ao obter lista de peers');
            setHasError(true);
        }
    }, [infoHash]);

    // Polling habilitado durante download ou seeding, sem erro
    const pollingEnabled =
        isActive && (status === 'downloading' || status === 'seeding') && !hasError;
    usePolling(fetchPeers, 2000, pollingEnabled);

    // Memoiza as linhas da tabela para evitar re-map a cada render do componente pai
    const peerRows = useMemo(
        () =>
            peers.map((peer, index) => (
                <tr key={`${peer.address}-${index}`}>
                    <td>{peer.address}</td>
                    <td>{peer.client}</td>
                    <td>{formatPeerSpeed(peer.downloadSpeed)}</td>
                    <td>{formatPeerProgress(peer.progress)}</td>
                </tr>
            )),
        [peers],
    );

    if (error) {
        return (
            <div className={styles.container}>
                <p className={styles.errorState} data-testid="peers-error">
                    {error}
                </p>
            </div>
        );
    }

    if (hasLoaded && peers.length === 0) {
        return (
            <div className={styles.container}>
                <p className={styles.emptyState} data-testid="peers-empty">
                    Nenhum peer conectado
                </p>
            </div>
        );
    }

    if (!hasLoaded) {
        return (
            <div className={styles.container}>
                <p className={styles.emptyState} data-testid="peers-loading">
                    Carregando...
                </p>
            </div>
        );
    }

    return (
        <div className={styles.container} data-testid="peers-table-container">
            <table className={styles.table} data-testid="peers-table">
                <thead>
                    <tr>
                        <th>Endereço IP</th>
                        <th>Cliente</th>
                        <th>Velocidade</th>
                        <th>Progresso</th>
                    </tr>
                </thead>
                <tbody>{peerRows}</tbody>
            </table>
        </div>
    );
});

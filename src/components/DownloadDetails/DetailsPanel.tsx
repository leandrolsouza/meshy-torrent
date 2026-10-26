import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TorrentStatus } from '../../../shared/types';
import { GeneralTab } from './GeneralTab';
import { PeersTab } from './PeersTab';
import { PiecesTab } from './PiecesTab';
import { SpeedTab } from './SpeedTab';
import { TabBar } from './TabBar';
import type { TabDefinition } from './TabBar';
import styles from './DetailsPanel.module.css';

export interface DetailsPanelProps {
    infoHash: string;
    status: TorrentStatus;
    isExpanded: boolean;
    onToggle: () => void;
    selectedTab?: string;
    onTabChange?: (tabId: string) => void;
    tabLabels?: Record<string, string>;
    additionalTabs?: (TabDefinition & { content: React.ReactNode })[];
}

const TABS: TabDefinition[] = [
    { id: 'general', label: 'Geral' },
    { id: 'peers', label: 'Peers' },
    { id: 'pieces', label: 'Peças' },
    { id: 'speed', label: 'Velocidade' },
];

/** Status que impedem a expansão do painel */
const NON_EXPANDABLE_STATUSES: TorrentStatus[] = ['resolving-metadata', 'queued'];

/**
 * Container do painel de detalhes expansível.
 * Gerencia expansão/colapso e a aba ativa em uma área de conteúdo com rolagem.
 * Painéis inativos permanecem montados (ocultos via CSS) para preservar estado.
 * Abas adicionais são montadas na primeira visita para evitar requisições antecipadas.
 */
export const DetailsPanel = React.memo(function DetailsPanel({
    infoHash,
    status,
    isExpanded,
    onToggle,
    selectedTab,
    onTabChange,
    tabLabels,
    additionalTabs = [],
}: DetailsPanelProps): React.JSX.Element {
    const [internalTab, setActiveTab] = useState<string>('general');
    const activeTab = selectedTab ?? internalTab;
    const [visitedTabs, setVisitedTabs] = useState<Set<string>>(new Set());
    const tabs = useMemo(
        () => [
            ...TABS.map((tab) => ({ ...tab, label: tabLabels?.[tab.id] ?? tab.label })),
            ...additionalTabs,
        ],
        [tabLabels, additionalTabs],
    );
    const prevExpandedRef = useRef(isExpanded);
    const panelIdPrefix = `details-${infoHash}`;

    useEffect(() => {
        if (isExpanded) {
            setVisitedTabs((previous) =>
                previous.has(activeTab) ? previous : new Set(previous).add(activeTab),
            );
        }
    }, [isExpanded, activeTab]);

    // Reset aba para "Geral" sempre que o painel expande
    useEffect(() => {
        if (isExpanded && !prevExpandedRef.current) {
            setActiveTab('general');
        }
        prevExpandedRef.current = isExpanded;
    }, [isExpanded]);

    // Auto-colapsar se torrent transiciona para status não-expansível
    useEffect(() => {
        if (isExpanded && NON_EXPANDABLE_STATUSES.includes(status)) {
            onToggle();
        }
    }, [status, isExpanded, onToggle]);

    // Callback estável para mudança de aba — encapsulada em useCallback para não
    // invalidar a memoização de TabBar (React.memo) a cada render do pai.
    const handleTabChange = useCallback(
        (tabId: string) => {
            setActiveTab(tabId);
            setVisitedTabs((previous) => new Set(previous).add(tabId));
            onTabChange?.(tabId);
        },
        [onTabChange],
    );

    // Memoiza os painéis de aba para evitar re-map quando props/estado irrelevantes mudam.
    // Dependências: activeTab (controla isActive), infoHash/status (passados para sub-abas),
    // isExpanded (passado como isCollecting para SpeedTab), panelIdPrefix (derivado de infoHash).
    const tabPanels = useMemo(
        () =>
            tabs.map((tab) => {
                const isActive = tab.id === activeTab;
                return (
                    <div
                        key={tab.id}
                        id={`${panelIdPrefix}-panel-${tab.id}`}
                        role="tabpanel"
                        aria-labelledby={`${panelIdPrefix}-tab-${tab.id}`}
                        inert={!isActive}
                        className={`${styles.tabPanel}${!isActive ? ` ${styles.tabPanelHidden}` : ''}`}
                    >
                        {tab.id === 'general' && (
                            <div data-testid="general-tab-content">
                                <GeneralTab infoHash={infoHash} status={status} />
                            </div>
                        )}
                        {tab.id === 'peers' && (
                            <div data-testid="peers-tab-content">
                                <PeersTab
                                    infoHash={infoHash}
                                    status={status}
                                    isActive={isExpanded && isActive}
                                />
                            </div>
                        )}
                        {tab.id === 'pieces' && (
                            <div data-testid="pieces-tab-content">
                                <PiecesTab
                                    infoHash={infoHash}
                                    status={status}
                                    isActive={isExpanded && isActive}
                                />
                            </div>
                        )}
                        {tab.id === 'speed' && (
                            <div data-testid="speed-tab-content">
                                <SpeedTab infoHash={infoHash} isCollecting={isExpanded} />
                            </div>
                        )}
                        {visitedTabs.has(tab.id) &&
                            additionalTabs.find((extra) => extra.id === tab.id)?.content}
                    </div>
                );
            }),
        [activeTab, infoHash, status, isExpanded, panelIdPrefix, tabs, visitedTabs, additionalTabs],
    );

    return (
        <div
            className={`${styles.panel} ${isExpanded ? styles.panelExpanded : styles.panelCollapsed}`}
            data-testid="details-panel"
            inert={!isExpanded}
        >
            {/* Conteúdo renderizado sempre para manter painéis montados */}
            <div className={styles.panelContent}>
                <TabBar
                    tabs={tabs}
                    activeTab={activeTab}
                    onTabChange={handleTabChange}
                    panelIdPrefix={panelIdPrefix}
                />

                {tabPanels}
            </div>
        </div>
    );
});

/**
 * Hook auxiliar para verificar se o status permite expansão.
 * Pode ser usado pelo componente pai (DownloadItem) para desabilitar o botão.
 */
export function isExpandable(status: TorrentStatus): boolean {
    return !NON_EXPANDABLE_STATUSES.includes(status);
}

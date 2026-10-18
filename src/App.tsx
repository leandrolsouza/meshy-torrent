import React, { useEffect, useState, useMemo } from 'react';
import { useIntl } from 'react-intl';
import { VscArrowDown, VscArrowUp } from 'react-icons/vsc';
import { useDownloadStore } from './store/downloadStore';
import { DownloadList } from './components/DownloadList/DownloadList';
import { DropZone } from './components/AddTorrent/DropZone';
import { AddTorrentModal } from './components/AddTorrent/AddTorrentModal';
import { ExternalTorrentImporter } from './components/AddTorrent/ExternalTorrentImporter';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { LightModeButton } from './components/common/LightModeButton';
import { UpdateControl } from './components/common/UpdateControl';
import { MeshyIcon } from './components/common/MeshyIcon';
import { FilterSidebar } from './components/DownloadList/FilterSidebar';
import { applyTheme } from './themes/themeApplier';
import { DEFAULT_THEME_ID } from './themes/themeRegistry';
import { formatBytes } from './utils/formatters';
import styles from './App.module.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type ActiveView = 'downloads' | 'add-torrent' | 'settings';

// ─── App ──────────────────────────────────────────────────────────────────────

/**
 * Root application component with VS Code-style layout.
 *
 * Layout structure:
 * - Activity Bar: navigation icons for downloads, add torrent, settings
 * - Editor Area: conditional rendering based on activeView
 * - Status Bar: active download count, bandwidth control and aggregated speed
 *
 * On mount, calls `window.meshy.getAll()` to populate the store with the
 * current download state from the main process.
 */
function App(): React.JSX.Element {
    const intl = useIntl();
    const setItems = useDownloadStore((state) => state.setItems);
    const items = useDownloadStore((state) => state.items);
    const [activeView, setActiveView] = useState<ActiveView>('downloads');
    const [isFilterSidebarOpen, setIsFilterSidebarOpen] = useState(false);

    useEffect(() => {
        async function loadInitialState(): Promise<void> {
            try {
                const response = await window.meshy.getAll();
                if (response.success) {
                    setItems(response.data);
                }
            } catch (err) {
                console.error('[App] Failed to load initial download state:', err);
            }
        }

        loadInitialState();
    }, [setItems]);

    // ── Aplicação de tema na inicialização ────────────────────────────────

    useEffect(() => {
        async function initializeTheme(): Promise<void> {
            try {
                const response = await window.meshy.getSettings();
                if (response.success && response.data.theme) {
                    // Tema salvo encontrado — aplica o tema persistido
                    applyTheme(response.data.theme);
                } else {
                    // Primeira execução ou sem tema salvo — aplica tema padrão
                    applyTheme(DEFAULT_THEME_ID);
                }
            } catch (err) {
                // Falha na leitura — aplica tema padrão e registra erro
                console.error('[App] Falha ao carregar tema salvo, aplicando tema padrão:', err);
                applyTheme(DEFAULT_THEME_ID);
            }
        }

        initializeTheme();
    }, []);

    // ── Status Bar computations ───────────────────────────────────────────

    const activeDownloadCount = useMemo(
        () => items.filter((item) => item.status === 'downloading').length,
        [items],
    );

    const totalDownloadSpeed = useMemo(
        () => items.reduce((sum, item) => sum + item.downloadSpeed, 0),
        [items],
    );

    const totalUploadSpeed = useMemo(
        () => items.reduce((sum, item) => sum + item.uploadSpeed, 0),
        [items],
    );

    // ── Render ────────────────────────────────────────────────────────────

    return (
        <div className={styles.app}>
            {/* ── Activity Bar ──────────────────────────────────────────── */}
            <nav
                className={styles.activityBar}
                aria-label={intl.formatMessage({ id: 'app.nav.label' })}
            >
                <button
                    className={
                        activeView === 'downloads' ? styles.activityIconActive : styles.activityIcon
                    }
                    onClick={() => setActiveView('downloads')}
                    aria-label={intl.formatMessage({ id: 'app.nav.downloads' })}
                    title={intl.formatMessage({ id: 'app.nav.downloads' })}
                >
                    <MeshyIcon name="downloads" size={24} />
                </button>
                <button
                    className={
                        isFilterSidebarOpen ? styles.activityIconActive : styles.activityIcon
                    }
                    onClick={() => setIsFilterSidebarOpen((prev) => !prev)}
                    aria-label={intl.formatMessage({ id: 'app.nav.searchAndFilter' })}
                    title={intl.formatMessage({ id: 'app.nav.searchAndFilter' })}
                    aria-expanded={isFilterSidebarOpen}
                >
                    <MeshyIcon name="search" size={24} />
                </button>
                <button
                    className={
                        activeView === 'add-torrent'
                            ? styles.activityIconActive
                            : styles.activityIcon
                    }
                    onClick={() => setActiveView('add-torrent')}
                    aria-label={intl.formatMessage({ id: 'app.nav.addTorrent' })}
                    title={intl.formatMessage({ id: 'app.nav.addTorrent' })}
                >
                    <MeshyIcon name="add-torrent" size={24} />
                </button>
                <button
                    className={
                        activeView === 'settings' ? styles.activityIconActive : styles.activityIcon
                    }
                    onClick={() => setActiveView('settings')}
                    aria-label={intl.formatMessage({ id: 'app.nav.settings' })}
                    title={intl.formatMessage({ id: 'app.nav.settings' })}
                >
                    <MeshyIcon name="settings" size={24} />
                </button>
            </nav>

            {/* ── Filter Sidebar ─────────────────────────────────────── */}
            {isFilterSidebarOpen && (
                <div className={styles.sidebarArea}>
                    <FilterSidebar showSearch={activeView !== 'downloads'} />
                </div>
            )}

            {/* ── Editor Area ───────────────────────────────────────────── */}
            <main className={styles.editorArea}>
                {activeView === 'downloads' && (
                    <div className={styles.downloadsView}>
                        <DownloadList onAddTorrent={() => setActiveView('add-torrent')}>
                            <DropZone />
                        </DownloadList>
                    </div>
                )}
                {activeView === 'add-torrent' && (
                    <AddTorrentModal
                        isOpen={true}
                        onClose={() => setActiveView('downloads')}
                        inline={true}
                    />
                )}
                {activeView === 'settings' && (
                    <SettingsPanel isOpen={true} onClose={() => setActiveView('downloads')} />
                )}
            </main>

            <ExternalTorrentImporter />
            {/* ── Status Bar ────────────────────────────────────────────── */}
            <footer className={styles.statusBar}>
                <span>
                    {intl.formatMessage(
                        { id: 'statusBar.activeDownloads' },
                        { count: activeDownloadCount },
                    )}
                </span>
                <div className={styles.statusBarControls}>
                    <UpdateControl />
                    <LightModeButton appearance="statusbar" />
                    <span className={styles.statusBarSpeeds}>
                        <VscArrowDown style={{ verticalAlign: 'middle' }} />{' '}
                        {formatBytes(totalDownloadSpeed)}/s
                        {' · '}
                        <VscArrowUp style={{ verticalAlign: 'middle' }} />{' '}
                        {formatBytes(totalUploadSpeed)}/s
                    </span>
                </div>
            </footer>
        </div>
    );
}

export default App;

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useIntl } from 'react-intl';
import { useSettings } from '../../hooks/useSettings';
import { applyTheme } from '../../themes/themeApplier';
import { isValidThemeId, DEFAULT_THEME_ID } from '../../themes/themeRegistry';
import { SettingsTabs, type SettingsTabId } from './SettingsTabs';
import { GeneralSettings } from './GeneralSettings';
import { TransferSettings, validateTransferFields } from './TransferSettings';
import { NetworkSettings } from './NetworkSettings';
import { TrackerSettings } from './TrackerSettings';
import { BandwidthSettings } from './BandwidthSettings';
import {
    createDefaultBandwidthSettings,
    isValidBandwidthSettings,
} from '../../../shared/bandwidth';
import styles from './SettingsPanel.module.css';

// ─── Props ────────────────────────────────────────────────────────────────────

interface SettingsPanelProps {
    isOpen: boolean;
    onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Painel de configurações organizado em abas.
 *
 * Renderiza inline no Editor Area quando acessado via Activity Bar.
 * Aceita `isOpen` e `onClose` para compatibilidade — quando `isOpen`
 * é false o componente retorna null.
 */
export function SettingsPanel({
    isOpen,
    onClose: _onClose,
}: SettingsPanelProps): React.JSX.Element | null {
    const intl = useIntl();
    const {
        settings,
        loading,
        error,
        updateSettings,
        selectFolder,
        addGlobalTracker,
        removeGlobalTracker,
    } = useSettings();

    // ── Aba ativa ─────────────────────────────────────────────────────────────
    const [activeTab, setActiveTab] = useState<SettingsTabId>('general');

    // ── Estado do formulário ──────────────────────────────────────────────────
    const [downloadLimit, setDownloadLimit] = useState('');
    const [uploadLimit, setUploadLimit] = useState('');
    const [maxConcurrent, setMaxConcurrent] = useState('');
    const [notificationsEnabled, setNotificationsEnabled] = useState(true);
    const [downloadLimitError, setDownloadLimitError] = useState<string | null>(null);
    const [uploadLimitError, setUploadLimitError] = useState<string | null>(null);
    const [maxConcurrentError, setMaxConcurrentError] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [bandwidth, setBandwidth] = useState(createDefaultBandwidthSettings);
    const [bandwidthError, setBandwidthError] = useState<string | null>(null);
    const [currentThemeId, setCurrentThemeId] = useState(DEFAULT_THEME_ID);

    // ── Estado de rede avançada ───────────────────────────────────────────────
    const [dhtEnabled, setDhtEnabled] = useState(true);
    const [pexEnabled, setPexEnabled] = useState(true);
    const [utpEnabled, setUtpEnabled] = useState(true);
    const [seedingEnabled, setSeedingEnabled] = useState(true);
    const [maxConcurrentSeeders, setMaxConcurrentSeeders] = useState(2);
    const [isRestarting, setIsRestarting] = useState(false);
    const [restartError, setRestartError] = useState<string | null>(null);

    // ── Sincroniza estado local quando settings carrega via IPC ───────────────
    // O setState em effect é intencional: sincroniza estado local com dados
    // carregados assincronamente do main process via IPC.
    useEffect(() => {
        if (settings) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setDownloadLimit(String(settings.downloadSpeedLimit));
            setUploadLimit(String(settings.uploadSpeedLimit));
            setMaxConcurrent(String(settings.maxConcurrentDownloads));
            setNotificationsEnabled(settings.notificationsEnabled);
            setDhtEnabled(settings.dhtEnabled);
            setPexEnabled(settings.pexEnabled);
            setUtpEnabled(settings.utpEnabled);
            setSeedingEnabled(settings.seedingEnabled);
            setMaxConcurrentSeeders(settings.maxConcurrentSeeders);
            setBandwidth(settings.bandwidth ?? createDefaultBandwidthSettings());
            if (settings.theme) {
                setCurrentThemeId(settings.theme);
            }
        }
    }, [settings]);

    // ── Aplica tema salvo na inicialização ────────────────────────────────────
    const lastAppliedThemeRef = useRef<string | null>(null);

    useEffect(() => {
        if (!settings) return;

        const themeToApply =
            settings.theme && isValidThemeId(settings.theme) ? settings.theme : DEFAULT_THEME_ID;

        // Só aplica se o tema mudou desde a última aplicação
        if (themeToApply === lastAppliedThemeRef.current) return;
        lastAppliedThemeRef.current = themeToApply;

        applyTheme(themeToApply);

        // Se o tema salvo era inválido, corrige no backend
        if (settings.theme && !isValidThemeId(settings.theme)) {
            updateSettings({ theme: DEFAULT_THEME_ID });
        }
    }, [settings, updateSettings]);

    // ── Handlers ──────────────────────────────────────────────────────────────

    const handleThemeChange = useCallback(
        (newId: string) => {
            applyTheme(newId);
            setCurrentThemeId(newId);
            updateSettings({ theme: newId });
        },
        [updateSettings],
    );

    const handleSelectFolder = useCallback(async () => {
        await selectFolder();
    }, [selectFolder]);

    const handleAutoApplyChange = useCallback(
        (enabled: boolean) => {
            updateSettings({ autoApplyGlobalTrackers: enabled });
        },
        [updateSettings],
    );

    const handleSave = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault();

            // Valida campos de transferência
            const transferValid = validateTransferFields(
                downloadLimit,
                uploadLimit,
                maxConcurrent,
                setDownloadLimitError,
                setUploadLimitError,
                setMaxConcurrentError,
                intl,
            );

            if (!transferValid) return;
            if (!isValidBandwidthSettings(bandwidth)) {
                setBandwidthError(intl.formatMessage({ id: 'bandwidth.invalid' }));
                return;
            }
            setBandwidthError(null);

            // Detectar se configurações de rede mudaram
            const networkChanged =
                settings?.dhtEnabled !== dhtEnabled ||
                settings?.pexEnabled !== pexEnabled ||
                settings?.utpEnabled !== utpEnabled;

            if (networkChanged) {
                setIsRestarting(true);
            }

            setRestartError(null);
            setIsSaving(true);

            try {
                // O botão rápido pode ter alterado o modo manual enquanto este formulário estava aberto.
                const current = await window.meshy.getSettings();
                if (!current.success) {
                    setBandwidthError(intl.formatMessage({ id: 'error.operation.failed' }));
                    return;
                }
                const success = await updateSettings({
                    downloadSpeedLimit: Number(downloadLimit),
                    uploadSpeedLimit: Number(uploadLimit),
                    maxConcurrentDownloads: Number(maxConcurrent),
                    notificationsEnabled,
                    dhtEnabled,
                    pexEnabled,
                    utpEnabled,
                    seedingEnabled,
                    maxConcurrentSeeders,
                    bandwidth: {
                        ...bandwidth,
                        manualEnabled: current.data.bandwidth?.manualEnabled ?? false,
                    },
                });

                if (!success && networkChanged) {
                    setRestartError(error ?? intl.formatMessage({ id: 'settings.restartError' }));
                }
            } catch {
                setBandwidthError(intl.formatMessage({ id: 'error.operation.failed' }));
            } finally {
                setIsSaving(false);
                setIsRestarting(false);
            }
        },
        [
            downloadLimit,
            uploadLimit,
            maxConcurrent,
            notificationsEnabled,
            dhtEnabled,
            pexEnabled,
            utpEnabled,
            seedingEnabled,
            maxConcurrentSeeders,
            bandwidth,
            settings,
            error,
            updateSettings,
            intl,
        ],
    );

    if (!isOpen) return null;

    // ── Conteúdo da aba ativa ─────────────────────────────────────────────────

    const renderTabContent = () => {
        if (!settings) return null;

        switch (activeTab) {
            case 'general':
                return (
                    <GeneralSettings
                        settings={settings}
                        currentThemeId={currentThemeId}
                        notificationsEnabled={notificationsEnabled}
                        onThemeChange={handleThemeChange}
                        onSelectFolder={handleSelectFolder}
                        onNotificationsChange={setNotificationsEnabled}
                        onUpdateSettings={updateSettings}
                    />
                );
            case 'transfer':
                return (
                    <>
                        <TransferSettings
                            downloadLimit={downloadLimit}
                            uploadLimit={uploadLimit}
                            maxConcurrent={maxConcurrent}
                            downloadLimitError={downloadLimitError}
                            uploadLimitError={uploadLimitError}
                            maxConcurrentError={maxConcurrentError}
                            onDownloadLimitChange={setDownloadLimit}
                            onUploadLimitChange={setUploadLimit}
                            onMaxConcurrentChange={setMaxConcurrent}
                            onDownloadLimitErrorChange={setDownloadLimitError}
                            onUploadLimitErrorChange={setUploadLimitError}
                            onMaxConcurrentErrorChange={setMaxConcurrentError}
                        />
                        <BandwidthSettings
                            value={bandwidth}
                            onChange={setBandwidth}
                            error={bandwidthError}
                        />
                    </>
                );
            case 'network':
                return (
                    <NetworkSettings
                        seedingEnabled={seedingEnabled}
                        maxConcurrentSeeders={maxConcurrentSeeders}
                        onSeedingChange={setSeedingEnabled}
                        onMaxSeedersChange={setMaxConcurrentSeeders}
                        dhtEnabled={dhtEnabled}
                        pexEnabled={pexEnabled}
                        utpEnabled={utpEnabled}
                        onDhtChange={setDhtEnabled}
                        onPexChange={setPexEnabled}
                        onUtpChange={setUtpEnabled}
                    />
                );
            case 'trackers':
                return (
                    <TrackerSettings
                        settings={settings}
                        error={error}
                        onAddGlobalTracker={addGlobalTracker}
                        onRemoveGlobalTracker={removeGlobalTracker}
                        onAutoApplyChange={handleAutoApplyChange}
                    />
                );
            default:
                return null;
        }
    };

    // ── Abas que precisam do botão "Salvar" ───────────────────────────────────
    const showSaveButton = activeTab === 'transfer' || activeTab === 'network';

    return (
        <section className={styles.settingsPanel} aria-labelledby="settings-panel-title">
            <h2 id="settings-panel-title" className={styles.panelTitle}>
                {intl.formatMessage({ id: 'settings.title' })}
            </h2>

            {loading && <p>{intl.formatMessage({ id: 'settings.loading' })}</p>}
            {error && (
                <p role="alert" className="modal__error">
                    {intl.formatMessage({ id: 'settings.loadError' }, { error })}
                </p>
            )}

            {settings && (
                <>
                    <SettingsTabs activeTab={activeTab} onTabChange={setActiveTab} />

                    <div
                        id={`settings-tabpanel-${activeTab}`}
                        role="tabpanel"
                        aria-labelledby={`settings-tab-${activeTab}`}
                        className={styles.tabContent}
                    >
                        {showSaveButton ? (
                            <form onSubmit={handleSave} noValidate>
                                {renderTabContent()}

                                {/* Erro de reinício do motor */}
                                {restartError && activeTab === 'network' && (
                                    <p className={styles.errorMessage} role="alert">
                                        {restartError}
                                    </p>
                                )}

                                <div className={styles.actions}>
                                    <button
                                        type="submit"
                                        className="btn btn--primary"
                                        disabled={isSaving}
                                    >
                                        {isRestarting
                                            ? intl.formatMessage({
                                                  id: 'settings.restartingEngine',
                                              })
                                            : isSaving
                                              ? intl.formatMessage({ id: 'common.saving' })
                                              : intl.formatMessage({ id: 'common.save' })}
                                    </button>
                                </div>
                            </form>
                        ) : (
                            renderTabContent()
                        )}
                    </div>
                </>
            )}
        </section>
    );
}

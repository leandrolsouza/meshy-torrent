import React from 'react';
import { useIntl } from 'react-intl';
import styles from './SettingsPanel.module.css';

// ─── Props ────────────────────────────────────────────────────────────────────

interface NetworkSettingsProps {
    seedingEnabled: boolean;
    maxConcurrentSeeders: number;
    onSeedingChange: (enabled: boolean) => void;
    onMaxSeedersChange: (max: number) => void;
    dhtEnabled: boolean;
    pexEnabled: boolean;
    utpEnabled: boolean;
    onDhtChange: (enabled: boolean) => void;
    onPexChange: (enabled: boolean) => void;
    onUtpChange: (enabled: boolean) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Aba "Rede" — configurações avançadas de rede (DHT, PEX, uTP).
 */
export function NetworkSettings({
    seedingEnabled,
    maxConcurrentSeeders,
    onSeedingChange,
    onMaxSeedersChange,
    dhtEnabled,
    pexEnabled,
    utpEnabled,
    onDhtChange,
    onPexChange,
    onUtpChange,
}: NetworkSettingsProps): React.JSX.Element {
    const intl = useIntl();

    return (
        <>
            <fieldset className={styles.fieldGroup}>
                <legend>{intl.formatMessage({ id: 'settings.seeding.title' })}</legend>
                <label className={styles.checkboxLabel}>
                    <input
                        type="checkbox"
                        checked={seedingEnabled}
                        onChange={(e) => onSeedingChange(e.target.checked)}
                    />
                    {intl.formatMessage({ id: 'settings.seeding.enabled' })}
                </label>
                <p>{intl.formatMessage({ id: 'settings.seeding.enabledDescription' })}</p>
                <label>
                    {intl.formatMessage({ id: 'settings.seeding.maxConcurrent' })}
                    <input
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        required
                        value={maxConcurrentSeeders}
                        disabled={!seedingEnabled}
                        onChange={(e) => onMaxSeedersChange(e.target.valueAsNumber)}
                    />
                </label>
                <p>{intl.formatMessage({ id: 'settings.seeding.maxConcurrentDescription' })}</p>
            </fieldset>
            <div className={styles.fieldGroup}>
                <label className={styles.checkboxLabel}>
                    <input
                        type="checkbox"
                        checked={dhtEnabled}
                        onChange={(e) => onDhtChange(e.target.checked)}
                        className={styles.checkbox}
                    />
                    {intl.formatMessage({ id: 'settings.network.dht' })}
                </label>
            </div>

            <div className={styles.fieldGroup}>
                <label className={styles.checkboxLabel}>
                    <input
                        type="checkbox"
                        checked={pexEnabled}
                        onChange={(e) => onPexChange(e.target.checked)}
                        className={styles.checkbox}
                    />
                    {intl.formatMessage({ id: 'settings.network.pex' })}
                </label>
            </div>

            <div className={styles.fieldGroup}>
                <label className={styles.checkboxLabel}>
                    <input
                        type="checkbox"
                        checked={utpEnabled}
                        onChange={(e) => onUtpChange(e.target.checked)}
                        className={styles.checkbox}
                    />
                    {intl.formatMessage({ id: 'settings.network.utp' })}
                </label>
            </div>

            <p className={styles.networkWarning}>
                {intl.formatMessage({ id: 'settings.network.warning' })}
            </p>
        </>
    );
}

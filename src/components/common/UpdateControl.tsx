import React, { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { AppUpdateStatus, IPCResponse } from '../../../shared/types';
import { resolveErrorMessage } from '../../utils/resolveErrorMessage';
import styles from './UpdateControl.module.css';

export function UpdateControl(): React.JSX.Element | null {
    const intl = useIntl();
    const [status, setStatus] = useState<AppUpdateStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    const generation = useRef(0);
    useEffect(() => {
        const current = ++generation.current;
        const apply = (next: AppUpdateStatus) => {
            if (current !== generation.current) return;
            setStatus((previous) =>
                previous && previous.revision > next.revision ? previous : next,
            );
        };
        const unsubscribe = window.meshy.onUpdateStatus(apply);
        void window.meshy
            .getUpdateStatus()
            .then((response) => {
                if (current !== generation.current) return;
                if (response.success) apply(response.data);
                else setError(response.error);
            })
            .catch(() => {
                if (current === generation.current) setError('error.update.failed');
            });
        return () => {
            generation.current = current + 1;
            unsubscribe();
        };
    }, []);

    const run = async (operation: () => Promise<IPCResponse<AppUpdateStatus>>) => {
        if (pending.current) return;
        pending.current = true;
        const current = generation.current;
        setBusy(true);
        setError(null);
        try {
            const response = await operation();
            if (current !== generation.current) return;
            if (response.success)
                setStatus((previous) =>
                    previous && previous.revision > response.data.revision
                        ? previous
                        : response.data,
                );
            else setError(response.error);
        } catch {
            if (current === generation.current) setError('error.update.failed');
        } finally {
            pending.current = false;
            if (current === generation.current) setBusy(false);
        }
    };

    if (!status && !error) return null;
    const downloaded = status?.phase === 'downloaded';
    const errorCode = error ?? status?.error;
    const disabled =
        !!status && ['disabled', 'checking', 'downloading', 'installing'].includes(status.phase);
    const message =
        status?.phase === 'disabled'
            ? intl.formatMessage({ id: `updates.disabled.${status.disabledReason}` })
            : intl.formatMessage(
                  { id: `updates.phase.${status?.phase ?? 'error'}` },
                  {
                      version: status?.availableVersion ?? status?.currentVersion ?? '',
                      percent: Math.round(status?.percent ?? 0),
                  },
              );
    return (
        <div className={styles.control}>
            <span role="status" title={intl.formatMessage({ id: 'updates.help' })}>
                {status && `v${status.currentVersion} · `}
                {message}
            </span>
            <button
                type="button"
                className="btn"
                disabled={busy || disabled}
                onClick={() =>
                    void run(() =>
                        downloaded ? window.meshy.installUpdate() : window.meshy.checkForUpdates(),
                    )
                }
            >
                {intl.formatMessage({ id: downloaded ? 'updates.restart' : 'updates.check' })}
            </button>
            {errorCode && (
                <span role="alert" className={styles.error}>
                    {resolveErrorMessage(intl, errorCode)}
                </span>
            )}
        </div>
    );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { MeshyIcon } from '../common/MeshyIcon';
import type { TorrentSource } from '../../../shared/types';
import { isV2OnlyMagnetUri, isValidMagnetUri, MAX_TORRENT_BYTES } from '../../../shared/validators';
import { AddTorrentModal } from './AddTorrentModal';
import styles from './DropZone.module.css';

/** Arrastar/colar abre a mesma revisão usada na adição manual. */
export function DropZone(): React.JSX.Element {
    const intl = useIntl();
    const [dragging, setDragging] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sources, setSources] = useState<TorrentSource[]>([]);
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const addText = useCallback(
        (text: string) => {
            const links = text
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);
            if (links.some(isV2OnlyMagnetUri)) {
                setError(intl.formatMessage({ id: 'error.torrent.unsupportedV2' }));
                return;
            }
            if (!links.length || links.some((link) => !isValidMagnetUri(link))) {
                setError(intl.formatMessage({ id: 'dropZone.invalidMagnet' }));
                return;
            }
            setError(null);
            setSources(links.map((magnetUri) => ({ kind: 'magnet', magnetUri })));
        },
        [intl],
    );
    useEffect(() => {
        const paste = (event: ClipboardEvent): void => {
            const target = event.target as HTMLElement | null;
            if (
                sources.length ||
                loading ||
                target?.closest('input, textarea, [contenteditable="true"]')
            )
                return;
            const text = event.clipboardData?.getData('text/plain');
            if (!text?.trim().startsWith('magnet:')) return;
            event.preventDefault();
            addText(text);
        };
        document.addEventListener('paste', paste);
        return () => document.removeEventListener('paste', paste);
    }, [addText, sources.length, loading]);
    const drop = async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        if (loading || sources.length) return;
        const files = Array.from(event.dataTransfer.files);
        const text = event.dataTransfer.getData('text/plain');
        setError(null);
        if (!files.length && text) {
            addText(text);
            return;
        }
        if (
            !files.length ||
            files.length > 200 ||
            files.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024 ||
            files.some(
                (file) =>
                    !file.name.toLowerCase().endsWith('.torrent') || file.size > MAX_TORRENT_BYTES,
            )
        ) {
            setError(intl.formatMessage({ id: 'dropZone.unsupportedFormat' }));
            return;
        }
        setLoading(true);
        try {
            const inputs: TorrentSource[] = [];
            for (const file of files)
                inputs.push({
                    kind: 'buffer',
                    buffer: new Uint8Array(await file.arrayBuffer()),
                    name: file.name,
                });
            if (mounted.current) setSources(inputs);
        } catch {
            if (mounted.current) setError(intl.formatMessage({ id: 'dropZone.errorGeneric' }));
        } finally {
            if (mounted.current) setLoading(false);
        }
    };
    return (
        <>
            <div
                className={`${styles.zone} ${dragging ? styles.active : loading ? styles.loading : ''}`}
                onDragOver={(event) => {
                    event.preventDefault();
                    if (!sources.length) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => void drop(event)}
                role="region"
                aria-label={intl.formatMessage({ id: 'dropZone.ariaLabel' })}
            >
                <div className={styles.icon}>
                    <MeshyIcon name="import-torrent" size={24} />
                </div>
                <span className={styles.text}>
                    {intl.formatMessage({ id: loading ? 'dropZone.loading' : 'dropZone.text' })}
                </span>
                <span className={styles.hint}>{intl.formatMessage({ id: 'dropZone.hint' })}</span>
                {error && (
                    <span role="alert" className={styles.error}>
                        {error}
                    </span>
                )}
            </div>
            {sources.length > 0 && (
                <AddTorrentModal isOpen initialSources={sources} onClose={() => setSources([])} />
            )}
        </>
    );
}

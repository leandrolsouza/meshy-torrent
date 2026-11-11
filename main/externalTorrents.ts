import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import type { ExternalTorrentRequest, TorrentSource } from '../shared/types';
import { isV2OnlyMagnetUri, isValidMagnetUri, isValidTorrentFile } from '../shared/validators';

export interface ExternalTorrentInbox {
    enqueueArguments(args: string[], cwd?: string): void;
    getPending(): ExternalTorrentRequest[];
    acknowledge(id: string): void;
}

/** Guarda entradas do SO até o renderer confirmar/cancelar, inclusive durante o boot. */
export function createExternalTorrentInbox(onPending: () => void): ExternalTorrentInbox {
    const requests: ExternalTorrentRequest[] = [];
    const key = (source: TorrentSource): string =>
        source.kind === 'magnet' ? source.magnetUri : source.kind === 'file' ? source.filePath : '';
    return {
        enqueueArguments(args, cwd = process.cwd()) {
            let changed = false;
            for (const arg of args) {
                if (requests.length >= 64 || typeof arg !== 'string' || arg.length > 16_384)
                    continue;
                const value = arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg;
                let source: TorrentSource | undefined;
                if (isValidMagnetUri(value) || isV2OnlyMagnetUri(value))
                    source = { kind: 'magnet', magnetUri: value };
                else if (!value.startsWith('-') && !value.includes('\0')) {
                    try {
                        const path = value.startsWith('file:')
                            ? fileURLToPath(value)
                            : resolve(cwd, value);
                        if (
                            isValidTorrentFile(path) &&
                            !/^[a-z]+:\/\//i.test(value.replace(/^file:/, ''))
                        )
                            source = { kind: 'file', filePath: path };
                    } catch {
                        /* Argumentos que não representam torrents são ignorados. */
                    }
                }
                if (!source || requests.some((request) => key(request.source) === key(source!)))
                    continue;
                requests.push({ id: randomUUID(), source });
                changed = true;
            }
            if (changed) onPending();
        },
        getPending: () =>
            requests.map((request) => ({ ...request, source: { ...request.source } })),
        acknowledge(id) {
            const index = requests.findIndex((request) => request.id === id);
            if (index !== -1) requests.splice(index, 1);
        },
    };
}

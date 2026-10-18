import type { UpdateDisabledReason } from '../shared/types';

/** Restringe o updater ao feed oficial; builds sem certificado usam o SHA-512 do feed. */
export function getUpdateDisabledReason(options: {
    isPackaged: boolean;
    platform: NodeJS.Platform;
    arch: string;
    configuration: unknown;
}): UpdateDisabledReason | undefined {
    if (!options.isPackaged) return 'development';
    if (options.platform !== 'win32' || options.arch !== 'x64') return 'platform';
    const config = options.configuration as Record<string, unknown> | null;
    if (
        !config ||
        typeof config !== 'object' ||
        Array.isArray(config) ||
        config.provider !== 'github' ||
        config.owner !== 'leandrolsouza' ||
        config.repo !== 'meshy-torrent' ||
        (config.host !== undefined && config.host !== 'github.com') ||
        (config.protocol !== undefined && config.protocol !== 'https')
    )
        return 'configuration';
    // Sem certificado, electron-updater não encontra publisherName e não verifica
    // Authenticode. O canal permanece limitado ao GitHub oficial em HTTPS e o
    // electron-updater valida o SHA-512 do instalador indicado pelo manifesto.
    if (config.publisherName === undefined || config.publisherName === null) return undefined;
    const names = Array.isArray(config.publisherName)
        ? config.publisherName
        : [config.publisherName];
    if (!names.length || names.some((name) => typeof name !== 'string' || !name.trim()))
        return 'configuration';
    return undefined;
}

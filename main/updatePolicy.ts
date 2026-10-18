import type { UpdateDisabledReason } from '../shared/types';

/** Não permita que um pacote sem editor confiável pule a validação Authenticode. */
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
    const names = Array.isArray(config.publisherName)
        ? config.publisherName
        : [config.publisherName];
    if (!names.length || names.some((name) => typeof name !== 'string' || !name.trim()))
        return 'unsigned';
    return undefined;
}

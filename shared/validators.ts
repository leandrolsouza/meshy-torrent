// ─── Shared validators for Main Process and Renderer Process ─────────────────
//
// Single source of truth for validation logic used across both processes.
// Avoids duplication of regex patterns and validation functions.
import ipaddr from 'ipaddr.js';

// ─── Magnet URI ───────────────────────────────────────────────────────────────
export { MAX_TORRENT_BYTES } from './torrentLimits';

// O hash continua exigindo 40 caracteres hexadecimais. A query também admite
// caracteres reservados de URI usados em trackers, nomes e seleção de arquivos.
const MAGNET_REGEX =
    /^magnet:\?xt=urn:btih:[a-fA-F0-9]{40}(&[a-zA-Z0-9&=%.+:?_/~,!'()*[\]@$;-]*)?$/i;

/**
 * Valida se uma string é um magnet URI válido.
 * Requer o prefixo `magnet:?xt=urn:btih:` seguido de exatamente 40 caracteres hexadecimais.
 */
export function isValidMagnetUri(uri: string): boolean {
    return MAGNET_REGEX.test(uri.trim());
}

// ─── Torrent file ─────────────────────────────────────────────────────────────

/**
 * Valida se um caminho de arquivo possui a extensão `.torrent`.
 */
export function isValidTorrentFile(filePath: string): boolean {
    return filePath.toLowerCase().endsWith('.torrent');
}

/**
 * Valida o conteúdo de um buffer verificando os magic bytes do formato bencode.
 * Um arquivo .torrent válido começa com 'd' (0x64) — dicionário bencode.
 */
export function hasTorrentMagicBytes(buffer: Uint8Array): boolean {
    return buffer.length > 0 && buffer[0] === 0x64;
}

// ─── Speed limit ──────────────────────────────────────────────────────────────

/**
 * Valida se um valor é um limite de velocidade válido.
 * Deve ser um inteiro não-negativo (KB/s), onde 0 indica sem limite.
 */
export function isValidSpeedLimit(value: unknown): boolean {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// ─── Max concurrent downloads ─────────────────────────────────────────────────

/** Limite mínimo de downloads simultâneos */
export const MIN_CONCURRENT_DOWNLOADS = 1;

/** Limite máximo de downloads simultâneos */
export const MAX_CONCURRENT_DOWNLOADS = 10;

/** Valor padrão de downloads simultâneos */
export const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 3;

/**
 * Valida se um valor é um limite de downloads simultâneos válido.
 * Deve ser um inteiro entre MIN_CONCURRENT_DOWNLOADS e MAX_CONCURRENT_DOWNLOADS (inclusive).
 */
export function isValidMaxConcurrentDownloads(value: unknown): boolean {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MIN_CONCURRENT_DOWNLOADS &&
        value <= MAX_CONCURRENT_DOWNLOADS
    );
}

// ─── Tracker URL ──────────────────────────────────────────────────────────────

/**
 * Protocolos aceitos para Tracker URLs.
 */
const VALID_TRACKER_PROTOCOLS = ['http:', 'https:', 'udp:'];

/**
 * Valida se uma string é uma Tracker URL válida.
 * Aceita protocolos http://, https://, udp:// com hostname não-vazio.
 * Rejeita strings vazias, apenas espaços, protocolos inválidos e IPs privados/loopback.
 */
export function isValidTrackerUrl(url: string): boolean {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (trimmed.length === 0) return false;

    try {
        const protocolMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
        if (!protocolMatch) return false;

        const [, capturedProtocol] = protocolMatch;
        if (!capturedProtocol) return false;
        const protocol = capturedProtocol.toLowerCase() + ':';
        if (!VALID_TRACKER_PROTOCOLS.includes(protocol)) return false;

        // O mesmo parser do tracker UDP: HTTP canonicaliza IPv4 abreviado/hexadecimal.
        const parsed = new URL(trimmed.replace(/^udp:/i, 'http:'));
        if (parsed.username || parsed.password || !parsed.hostname) return false;
        const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
        if (!hostname) return false;
        if (ipaddr.isValid(hostname)) return isPublicIpAddress(hostname);
        return (
            !/^(localhost|localhost\.localdomain)$/i.test(hostname) &&
            !/\.(localhost|local)$/i.test(hostname)
        );
    } catch {
        return false;
    }
}

/**
 * Aceita somente IPs unicast públicos, incluindo IPv4 mapeado em IPv6.
 * Não resolve DNS; o transporte também deve validar a resolução usada pelo socket.
 */
export function isPublicIpAddress(value: string): boolean {
    try {
        if (value.includes('%')) return false;
        const address = ipaddr.process(value);
        return (
            address.range() === 'unicast' &&
            (address.kind() === 'ipv4' || address.match(ipaddr.parse('2000::'), 3))
        );
    } catch {
        return false;
    }
}

/**
 * Normaliza uma Tracker URL: remove espaços, converte protocolo para minúsculas,
 * e remove barras finais duplicadas.
 */
export function normalizeTrackerUrl(url: string): string {
    const trimmed = url.trim();

    // Converte protocolo para minúsculas
    const normalized = trimmed.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/, (match) =>
        match.toLowerCase(),
    );

    // Remove barras finais duplicadas (mantém no máximo uma)
    return normalized.replace(/\/+$/, '');
}

// ─── Network toggle ───────────────────────────────────────────────────────────

/**
 * Valida se um valor é um booleano válido para configurações de rede (DHT/PEX/uTP).
 */
export function isValidNetworkToggle(value: unknown): boolean {
    return typeof value === 'boolean';
}

// ─── Theme ID ─────────────────────────────────────────────────────────────────

/**
 * Valida se um valor é um identificador de tema válido.
 * Deve ser uma string não-vazia.
 */
export function isValidThemeId(value: unknown): boolean {
    return typeof value === 'string' && value.length > 0;
}

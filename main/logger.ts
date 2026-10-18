import log from 'electron-log';

// ─── Logger ───────────────────────────────────────────────────────────────────
//
// Wrapper around electron-log for the main process com suporte a contexto
// estruturado. Cada mensagem pode incluir campos adicionais (channel, infoHash,
// durationMs, etc.) que são serializados junto ao log para facilitar debugging.
//
// Logs are written to:
//   Windows: %APPDATA%/Meshy/logs/
//   macOS:   ~/Library/Logs/Meshy/
//   Linux:   ~/.config/Meshy/logs/

/** Campos de contexto opcionais para enriquecer mensagens de log */
export interface LogContext {
    /** Canal IPC que originou a operação */
    channel?: string;
    /** InfoHash do torrent relacionado */
    infoHash?: string;
    /** Duração da operação em milissegundos */
    durationMs?: number;
    /** Código de erro estruturado */
    errorCode?: string;
    /** Origem do erro (módulo/componente) */
    source?: string;
    /** Campos adicionais livres */
    [key: string]: unknown;
}

export interface Logger {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

/**
 * Flag global para habilitar/desabilitar logs de debug.
 * Ativado via variável de ambiente MESHY_DEBUG=1 ou programaticamente.
 */
let debugEnabled = process.env['MESHY_DEBUG'] === '1';

/** Habilita ou desabilita logs de debug em runtime */
export function setDebugEnabled(enabled: boolean): void {
    debugEnabled = enabled;
}

/** Retorna se o modo debug está ativo */
export function isDebugEnabled(): boolean {
    return debugEnabled;
}

/**
 * Formata campos de contexto como string legível para append ao log.
 * Campos undefined/null são omitidos. Resultado: `{channel=torrent:pause, infoHash=abc123}`
 */
function formatContext(ctx: LogContext): string {
    const entries = Object.entries(ctx).filter(
        ([, v]) => v !== undefined && v !== null && v !== '',
    );
    if (entries.length === 0) return '';
    const fields = entries.map(([k, v]) => `${k}=${String(v)}`).join(', ');
    return ` {${fields}}`;
}

/**
 * Default logger backed by electron-log.
 * Can be replaced with a mock in tests via dependency injection.
 */
export const logger: Logger = {
    info(message: string, ...args: unknown[]): void {
        log.info(message, ...args);
    },
    warn(message: string, ...args: unknown[]): void {
        log.warn(message, ...args);
    },
    error(message: string, ...args: unknown[]): void {
        log.error(message, ...args);
    },
    debug(message: string, ...args: unknown[]): void {
        if (debugEnabled) {
            log.info(`[DEBUG] ${message}`, ...args);
        }
    },
};

// ─── Scoped logger ────────────────────────────────────────────────────────────

/**
 * Cria um logger com contexto fixo (ex: módulo, canal IPC).
 * Cada chamada de log inclui automaticamente os campos do contexto base,
 * podendo ser enriquecido com campos adicionais por chamada.
 *
 * @example
 * const log = createScopedLogger(logger, { channel: 'torrent:pause' });
 * log.info('Operação iniciada', { infoHash: 'abc123' });
 * // => "[torrent:pause] Operação iniciada {infoHash=abc123}"
 *
 * log.error('Falha na operação', { infoHash: 'abc123', durationMs: 150 });
 * // => "[torrent:pause] Falha na operação {infoHash=abc123, durationMs=150}"
 */
export interface ScopedLogger {
    info(message: string, ctx?: LogContext): void;
    warn(message: string, ctx?: LogContext): void;
    error(message: string, ctx?: LogContext): void;
    debug(message: string, ctx?: LogContext): void;
}

export function createScopedLogger(base: Logger, baseCtx: LogContext): ScopedLogger {
    const prefix = baseCtx.channel ? `[${baseCtx.channel}]` : '[Meshy Torrent]';

    return {
        info(message: string, ctx?: LogContext): void {
            const merged = { ...baseCtx, ...ctx };
            // Remover channel do contexto formatado (já está no prefixo)
            delete merged.channel;
            base.info(`${prefix} ${message}${formatContext(merged)}`);
        },
        warn(message: string, ctx?: LogContext): void {
            const merged = { ...baseCtx, ...ctx };
            delete merged.channel;
            base.warn(`${prefix} ${message}${formatContext(merged)}`);
        },
        error(message: string, ctx?: LogContext): void {
            const merged = { ...baseCtx, ...ctx };
            delete merged.channel;
            base.error(`${prefix} ${message}${formatContext(merged)}`);
        },
        debug(message: string, ctx?: LogContext): void {
            const merged = { ...baseCtx, ...ctx };
            delete merged.channel;
            base.debug(`${prefix} ${message}${formatContext(merged)}`);
        },
    };
}
